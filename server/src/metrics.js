'use strict';

const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const roomsGauge = new client.Gauge({
  name: 'mediasoup_rooms',
  help: 'Active rooms',
  registers: [register]
});

const peersGauge = new client.Gauge({
  name: 'mediasoup_peers',
  help: 'Connected peers',
  registers: [register]
});

const producersGauge = new client.Gauge({
  name: 'mediasoup_producers',
  help: 'Active producers',
  labelNames: ['kind'],
  registers: [register]
});

const consumersGauge = new client.Gauge({
  name: 'mediasoup_consumers',
  help: 'Active consumers',
  registers: [register]
});

const wsConnectionsGauge = new client.Gauge({
  name: 'mediasoup_ws_connections',
  help: 'Active WebSocket connections',
  registers: [register]
});

const messagesCounter = new client.Counter({
  name: 'mediasoup_messages_total',
  help: 'WebSocket messages processed by type',
  labelNames: ['type'],
  registers: [register]
});

function collect(roomManager, wsConnectionCount) {
  let peerCount = 0;
  let audioProducers = 0;
  let videoProducers = 0;
  let consumerCount = 0;

  for (const room of roomManager.rooms.values()) {
    peerCount += room.peers.size;
    for (const entry of room.producers.values()) {
      if (entry.producer.kind === 'audio') {
        audioProducers++;
      } else {
        videoProducers++;
      }
    }
    for (const peer of room.peers.values()) {
      consumerCount += peer.consumers.size;
    }
  }

  roomsGauge.set(roomManager.rooms.size);
  peersGauge.set(peerCount);
  producersGauge.labels('audio').set(audioProducers);
  producersGauge.labels('video').set(videoProducers);
  consumersGauge.set(consumerCount);
  wsConnectionsGauge.set(wsConnectionCount);
}

const producerBitrateGauge = new client.Gauge({
  name: 'mediasoup_producer_bitrate_bits',
  help: 'Producer bitrate in bits/s per room+kind+mediaType',
  labelNames: ['room', 'kind', 'media_type'],
  registers: [register]
});

const producerScoreGauge = new client.Gauge({
  name: 'mediasoup_producer_score',
  help: 'Producer quality score (0-10)',
  labelNames: ['room', 'kind', 'media_type'],
  registers: [register]
});

const producerPacketsLostGauge = new client.Gauge({
  name: 'mediasoup_producer_packets_lost',
  help: 'Producer cumulative packets lost',
  labelNames: ['room', 'kind', 'media_type'],
  registers: [register]
});

const producerJitterGauge = new client.Gauge({
  name: 'mediasoup_producer_jitter_seconds',
  help: 'Producer jitter in seconds',
  labelNames: ['room', 'kind', 'media_type'],
  registers: [register]
});

async function collectProducerStats(roomManager) {
  producerBitrateGauge.reset();
  producerScoreGauge.reset();
  producerPacketsLostGauge.reset();
  producerJitterGauge.reset();

  for (const [roomId, room] of roomManager.rooms.entries()) {
    for (const entry of room.producers.values()) {
      const labels = {
        room: roomId,
        kind: entry.producer.kind,
        media_type: entry.producer.appData?.mediaType || 'unknown'
      };

      try {
        const stats = await entry.producer.getStats();
        let bitrate = 0;
        let packetsLost = 0;
        let jitter = 0;
        let score = 0;
        let count = 0;

        for (const stat of stats) {
          bitrate += stat.bitrate || 0;
          packetsLost += stat.packetsLostCount || 0;
          jitter = Math.max(jitter, stat.jitter || 0);
          score += stat.score || 0;
          count++;
        }

        producerBitrateGauge.labels(labels).set(bitrate);
        producerPacketsLostGauge.labels(labels).set(packetsLost);
        producerJitterGauge.labels(labels).set(jitter);
        if (count > 0) {
          producerScoreGauge.labels(labels).set(score / count);
        }
      } catch {
        // producer closed between iteration and getStats call
      }
    }
  }
}

module.exports = { register, collect, collectProducerStats, messagesCounter };
