'use strict';

const { randomUUID } = require('crypto');

class RoomManager {
  constructor({ worker, mediaCodecs, webRtcTransportOptions, maxParticipants }) {
    this.worker = worker;
    this.mediaCodecs = mediaCodecs;
    this.webRtcTransportOptions = webRtcTransportOptions;
    this.maxParticipants = maxParticipants;
    this.rooms = new Map();
  }

  async createRoom(roomId) {
    if (!roomId) {
      throw new Error('roomId is required');
    }

    let room = this.rooms.get(roomId);
    if (room) {
      return room;
    }

    const router = await this.worker.createRouter({
      mediaCodecs: this.mediaCodecs
    });

    room = {
      id: roomId,
      router,
      peers: new Map(),
      producers: new Map()
    };

    this.rooms.set(roomId, room);

    return room;
  }

  async addPeer(roomId, socket, peerName = 'Guest', role = 'watcher', clientId = null) {
    const room = this.rooms.get(roomId) || await this.createRoom(roomId);

    if (room.peers.size >= this.maxParticipants) {
      throw new Error('room is full');
    }

    const peerId = randomUUID();
    const peer = {
      id: peerId,
      name: peerName,
      role,
      clientId,
      socket,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map()
    };

    room.peers.set(peerId, peer);
    return peer;
  }

  evictByClientId(roomId, clientId) {
    if (!clientId) {
      return null;
    }
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }
    for (const peer of room.peers.values()) {
      if (peer.clientId === clientId) {
        return this.closePeer(peer.id, roomId);
      }
    }
    return null;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  getPeer(roomId, peerId) {
    const room = this.getRoom(roomId);
    return room?.peers.get(peerId);
  }

  getPeerInfo(roomId, excludingPeerId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return [];
    }

    return [...room.peers.values()]
      .filter((peer) => peer.id !== excludingPeerId)
      .map((peer) => ({ peerId: peer.id, name: peer.name, role: peer.role }));
  }

  getProducerInfoList(roomId, excludingPeerId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return [];
    }

    return [...room.producers.values()]
      .filter((entry) => entry.peerId !== excludingPeerId)
      .map((entry) => ({
        producerId: entry.producer.id,
        peerId: entry.peerId,
        kind: entry.producer.kind,
        appData: entry.producer.appData || {}
      }));
  }

  getProducerEntry(roomId, producerId) {
    const room = this.getRoom(roomId);
    return room?.producers.get(producerId);
  }

  async createTransport(roomId, peerId, direction) {
    const peer = this.getPeer(roomId, peerId);
    if (!peer) {
      throw new Error('peer not found');
    }

    const room = this.getRoom(roomId);
    const transport = await room.router.createWebRtcTransport({
      ...this.webRtcTransportOptions,
      appData: { peerId, direction }
    });

    transport.on('close', () => {
      peer.transports.delete(transport.id);
    });

    peer.transports.set(transport.id, transport);
    return transport;
  }

  async connectTransport(roomId, peerId, transportId, dtlsParameters) {
    const peer = this.getPeer(roomId, peerId);
    if (!peer) {
      throw new Error('peer not found');
    }

    const transport = peer.transports.get(transportId);
    if (!transport) {
      throw new Error('transport not found');
    }

    await transport.connect({ dtlsParameters });
  }

  async createProducer(roomId, peerId, transportId, kind, rtpParameters, appData = {}) {
    const peer = this.getPeer(roomId, peerId);
    if (!peer) {
      throw new Error('peer not found');
    }

    const transport = peer.transports.get(transportId);
    if (!transport) {
      throw new Error('transport not found');
    }

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData
    });

    const entry = {
      peerId,
      producer,
      appData
    };

    peer.producers.set(producer.id, producer);
    this.getRoom(roomId).producers.set(producer.id, entry);

    const onProducerClose = () => this.removeProducer(roomId, peerId, producer.id);

    producer.on('close', onProducerClose);
    producer.on('transportclose', onProducerClose);

    return producer;
  }

  async createConsumer(roomId, peerId, transportId, producerId, rtpCapabilities) {
    const room = this.getRoom(roomId);
    const peer = this.getPeer(roomId, peerId);
    if (!room || !peer) {
      throw new Error('peer not found');
    }

    if (!room.producers.has(producerId)) {
      throw new Error('producer not found');
    }

    const canConsume = room.router.canConsume({ producerId, rtpCapabilities });

    if (!canConsume) {
      throw new Error('cannot consume producer');
    }

    const transport = peer.transports.get(transportId);
    if (!transport) {
      throw new Error('transport not found');
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true
    });

    peer.consumers.set(consumer.id, consumer);

    consumer.on('producerclose', () => {
      peer.consumers.delete(consumer.id);
    });

    if (consumer.type === 'simulcast') {
      const producerEntry = room.producers.get(producerId);
      const producerPeer = room.peers.get(producerEntry?.peerId);
      const mediaType = producerEntry?.appData?.mediaType;
      const isHighQuality = mediaType === 'screen' || producerPeer?.role === 'streamer';
      await consumer.setPreferredLayers({ spatialLayer: isHighQuality ? 1 : 0, temporalLayer: 1 });
    }

    return consumer;
  }

  async resumeConsumer(roomId, peerId, consumerId) {
    const consumer = this.getPeer(roomId, peerId)?.consumers.get(consumerId);
    if (!consumer) {
      throw new Error('consumer not found');
    }

    await consumer.resume();
  }

  async pauseProducer(roomId, peerId, producerId) {
    const producerEntry = this.getProducerEntry(roomId, producerId);
    if (!producerEntry) {
      throw new Error('producer not found');
    }

    if (producerEntry.peerId !== peerId) {
      throw new Error('not owner of producer');
    }

    await producerEntry.producer.pause();
  }

  async resumeProducer(roomId, peerId, producerId) {
    const producerEntry = this.getProducerEntry(roomId, producerId);
    if (!producerEntry) {
      throw new Error('producer not found');
    }

    if (producerEntry.peerId !== peerId) {
      throw new Error('not owner of producer');
    }

    await producerEntry.producer.resume();
  }

  removeProducer(roomId, peerId, producerId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }

    const peer = room.peers.get(peerId);
    if (!peer) {
      return null;
    }

    const producer = peer.producers.get(producerId);
    if (!producer) {
      return null;
    }

    peer.producers.delete(producerId);
    room.producers.delete(producerId);

    producer.removeAllListeners();
    producer.close();

    return { producerId, peerId };
  }

  closePeer(peerId, roomId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }

    const peer = room.peers.get(peerId);
    if (!peer) {
      return null;
    }

    for (const transport of peer.transports.values()) {
      transport.removeAllListeners();
      transport.close();
    }

    for (const producer of peer.producers.values()) {
      producer.removeAllListeners();
      producer.close();
    }

    for (const consumer of peer.consumers.values()) {
      consumer.removeAllListeners();
      consumer.close();
    }

    for (const [producerId, producerEntry] of room.producers.entries()) {
      if (producerEntry.peerId === peerId) {
        room.producers.delete(producerId);
      }
    }

    room.peers.delete(peerId);

    const payload = { roomId, peerId, name: peer.name, role: peer.role };

    if (room.peers.size === 0) {
      room.router.close();
      this.rooms.delete(roomId);
    }

    return payload;
  }
}

module.exports = RoomManager;
