'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createWorker } = require('mediasoup');
const { WebSocketServer } = require('ws');
const config = require('./config');
const metrics = require('./metrics');
const RoomManager = require('./roomManager');

function logIceServerConnection(label, payload = null) {
  const prefix = '[ice]';
  if (payload === null) {
    console.info(`${prefix} ${label}`);
    return;
  }

  console.info(`${prefix} ${label}`, payload);
}

const clientDir = path.join(process.cwd(), 'client');

function contentType(filePath) {
  const ext = path.extname(filePath);
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8'
  };

  return map[ext] || 'application/octet-stream';
}

function sendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function createRequestResponse(ws, requestId, payload) {
  sendJson(ws, {
    requestId,
    ...payload
  });
}

function createErrorResponse(ws, requestId, message) {
  sendJson(ws, {
    requestId,
    error: message
  });
}

function createServer(worker) {
  const roomManager = new RoomManager({
    worker,
    mediaCodecs: config.mediaCodecs,
    webRtcTransportOptions: config.webRtcTransport,
    maxParticipants: config.room.maxParticipants
  });

  const connections = new Map(); // ws -> { roomId, peerId }

  function broadcast(roomId, type, payload, exceptPeerId = null) {
    const room = roomManager.getRoom(roomId);
    if (!room) {
      return;
    }

    for (const peer of room.peers.values()) {
      if (peer.id === exceptPeerId) {
        continue;
      }

      sendJson(peer.socket, { type, ...payload });
    }
  }

  async function onMessage(ws, rawMessage) {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      return sendJson(ws, { type: 'error', error: 'invalid_json' });
    }

    const { type, requestId, data = {} } = message;
    metrics.messagesCounter.inc({ type: type || 'unknown' });
    const state = connections.get(ws) || {};

    if (type === 'join-room') {
      try {
        const roomId = String(data.roomId || '').trim();
        const peerName = String(data.peerName || '').trim() || 'Guest';
        const role = ['streamer', 'viewer', 'watcher'].includes(data.role) ? data.role : 'watcher';
        const clientId = String(data.clientId || '').trim() || null;

        if (!roomId) {
          return createErrorResponse(ws, requestId, 'roomId required');
        }

        if (config.room.password && String(data.password || '') !== config.room.password) {
          return createErrorResponse(ws, requestId, 'Неверный пароль.');
        }

        // Same-socket double join guard
        const existingState = connections.get(ws);
        if (existingState) {
          const evicted = roomManager.closePeer(existingState.peerId, existingState.roomId);
          if (evicted) {
            broadcast(evicted.roomId, 'peer-left', { peerId: evicted.peerId, name: evicted.name }, existingState.peerId);
          }
          connections.delete(ws);
        }

        // Evict any stale peer from a previous session with the same clientId
        await roomManager.createRoom(roomId);
        const stale = roomManager.evictByClientId(roomId, clientId);
        if (stale) {
          broadcast(stale.roomId, 'peer-left', { peerId: stale.peerId, name: stale.name }, stale.peerId);
        }

        const room = await roomManager.createRoom(roomId);
        const peer = await roomManager.addPeer(roomId, ws, peerName, role, clientId);

        connections.set(ws, { roomId, peerId: peer.id });

        createRequestResponse(ws, requestId, {
          type: 'room-joined',
          payload: {
            peerId: peer.id,
            roomId,
            routerRtpCapabilities: room.router.rtpCapabilities,
            rtcConfig: config.rtcConfig,
            bitrate: config.bitrate,
            participants: roomManager.getPeerInfo(roomId, peer.id),
            existingProducers: roomManager.getProducerInfoList(roomId, peer.id)
          }
        });

        broadcast(roomId, 'peer-joined', {
          roomId,
          peerId: peer.id,
          name: peer.name,
          role: peer.role
        }, peer.id);
      } catch (error) {
        createErrorResponse(ws, requestId, error.message);
      }

      return;
    }

    if (!state.roomId || !state.peerId) {
      return createErrorResponse(ws, requestId, 'not_joined');
    }

    try {
      if (type === 'create-transport') {
        const transport = await roomManager.createTransport(
          state.roomId,
          state.peerId,
          data.direction
        );
        logIceServerConnection('server transport created', {
          roomId: state.roomId,
          peerId: state.peerId,
          direction: data.direction,
          transportId: transport.id,
          candidateCount: transport.iceCandidates?.length || 0
        });

        return createRequestResponse(ws, requestId, {
          type: 'transport-created',
          payload: {
            transport: {
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
              sctpParameters: transport.sctpParameters,
              iceServers: config.rtcConfig.iceServers
            }
          }
        });
      }

      if (type === 'connect-transport') {
        logIceServerConnection('server transport connect requested', {
          roomId: state.roomId,
          peerId: state.peerId,
          transportId: data.transportId
        });
        await roomManager.connectTransport(
          state.roomId,
          state.peerId,
          data.transportId,
          data.dtlsParameters
        );

        return createRequestResponse(ws, requestId, {
          type: 'transport-connected',
          payload: { ok: true }
        });
      }

      if (type === 'produce') {
        const producer = await roomManager.createProducer(
          state.roomId,
          state.peerId,
          data.transportId,
          data.kind,
          data.rtpParameters,
          data.appData || {}
        );

        const producerData = {
          producerId: producer.id,
          peerId: state.peerId,
          kind: producer.kind,
          appData: producer.appData || {}
        };

        createRequestResponse(ws, requestId, {
          type: 'produce-created',
          payload: producerData
        });
        return broadcast(state.roomId, 'new-producer', producerData, state.peerId);
      }

      if (type === 'consume') {
        const consumer = await roomManager.createConsumer(
          state.roomId,
          state.peerId,
          data.transportId,
          data.producerId,
          data.rtpCapabilities
        );

        const producerEntry = roomManager.getProducerEntry(state.roomId, data.producerId);

        return createRequestResponse(ws, requestId, {
          type: 'consumer-created',
          payload: {
            consumerId: consumer.id,
            producerId: data.producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            producerPeerId: producerEntry?.peerId,
            appData: producerEntry?.producer.appData || {}
          }
        });
      }

      if (type === 'resume-consumer') {
        await roomManager.resumeConsumer(state.roomId, state.peerId, data.consumerId);
        return createRequestResponse(ws, requestId, {
          type: 'consumer-resumed',
          payload: { consumerId: data.consumerId }
        });
      }

      if (type === 'pause-producer') {
        await roomManager.pauseProducer(state.roomId, state.peerId, data.producerId);
        return createRequestResponse(ws, requestId, {
          type: 'producer-paused',
          payload: { producerId: data.producerId }
        });
      }

      if (type === 'resume-producer') {
        await roomManager.resumeProducer(state.roomId, state.peerId, data.producerId);
        return createRequestResponse(ws, requestId, {
          type: 'producer-resumed',
          payload: { producerId: data.producerId }
        });
      }

      if (type === 'close-producer') {
        roomManager.removeProducer(state.roomId, state.peerId, data.producerId);
        broadcast(state.roomId, 'producer-closed', {
          producerId: data.producerId,
          peerId: state.peerId
        }, state.peerId);

        return createRequestResponse(ws, requestId, {
          type: 'producer-removed',
          payload: { producerId: data.producerId }
        });
      }

      if (type === 'leave') {
        const removed = roomManager.closePeer(state.peerId, state.roomId);
        if (removed) {
          broadcast(removed.roomId, 'peer-left', {
            peerId: removed.peerId,
            name: removed.name
          }, state.peerId);
          connections.delete(ws);
        }

        return createRequestResponse(ws, requestId, {
          type: 'left',
          payload: { roomId: state.roomId }
        });
      }

      return createErrorResponse(ws, requestId, 'unknown_event_type');
    } catch (error) {
      createErrorResponse(ws, requestId, error.message);
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      metrics.collect(roomManager, connections.size);
      res.writeHead(200, { 'Content-Type': metrics.register.contentType });
      res.end(await metrics.register.metrics());
      return;
    }

    const requestPath = decodeURIComponent(req.url ? req.url.split('?')[0] : '/');
    const normalizedPath = path.normalize(requestPath).replace(/^(\.\.(\/|\\)|\.\.$)/, '');
    const urlPath = (normalizedPath === '/' || normalizedPath === '\\') ? 'index.html' : normalizedPath.replace(/^[/\\]+/, '');

    const resolvedPath = path.join(clientDir, urlPath);
    if (!resolvedPath.startsWith(path.join(clientDir, path.sep))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(resolvedPath, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      res.writeHead(200, { 'Content-Type': contentType(resolvedPath) });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/' });

  wss.on('connection', (ws) => {
    ws.on('message', (message) => onMessage(ws, message));

    ws.on('close', () => {
      const state = connections.get(ws);
      if (!state) {
        return;
      }

      const removed = roomManager.closePeer(state.peerId, state.roomId);
      if (removed) {
        broadcast(removed.roomId, 'peer-left', {
          peerId: removed.peerId,
          name: removed.name
        }, state.peerId);
      }
      connections.delete(ws);
    });

    ws.on('error', () => {});
  });

  const closeAll = async () => {
    for (const [roomId, room] of [...roomManager.rooms.entries()]) {
      for (const peerId of [...room.peers.keys()]) {
        roomManager.closePeer(peerId, roomId);
      }
    }

    await worker.close();
  };

  process.on('SIGINT', async () => {
    await closeAll();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await closeAll();
    process.exit(0);
  });

  server.listen(config.listen.port, config.listen.host);

  setInterval(() => {
    metrics.collectProducerStats(roomManager).catch(() => {});
  }, 10000);
}

async function start() {
  const worker = await createWorker({
    logLevel: config.worker.logLevel,
    logTags: config.worker.logTags,
    rtcMinPort: config.worker.rtcMinPort,
    rtcMaxPort: config.worker.rtcMaxPort
  });

  worker.on('died', (error) => {
    console.error('Mediasoup worker died:', error);
    process.exit(1);
  });

  createServer(worker);
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
