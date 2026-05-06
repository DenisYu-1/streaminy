'use strict';

require('dotenv').config();

const os = require('os');

function detectLocalIp() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const entry of iface) {
      if (!entry.internal && entry.family === 'IPv4') {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

function resolveAnnouncedIp() {
  return process.env.ANNOUNCED_IP || detectLocalIp();
}

function toInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);

  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function toBoolean(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function withTurnServerCredentials(entry, defaultTurnUsername, defaultTurnCredential) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const normalized = { ...entry };
  const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
  const safeUrls = urls.filter(Boolean);

  if (safeUrls.length === 0) {
    return null;
  }

  normalized.urls = safeUrls;
  normalized.username = typeof normalized.username === 'string' ? normalized.username.trim() : '';
  normalized.credential = typeof normalized.credential === 'string' ? normalized.credential.trim() : '';

  if (!normalized.username && defaultTurnUsername) {
    normalized.username = defaultTurnUsername;
  }

  if (!normalized.credential && defaultTurnCredential) {
    normalized.credential = defaultTurnCredential;
  }
  const hasUsername = typeof normalized.username === 'string' && normalized.username.trim();
  const hasCredential = typeof normalized.credential === 'string' && normalized.credential.trim();
  const requiresAuth = normalized.urls.some((url) => String(url).trim().toLowerCase().startsWith('turn:'))
    || normalized.urls.some((url) => String(url).trim().toLowerCase().startsWith('turns:'));
  if (requiresAuth && (!hasUsername || !hasCredential)) {
    return null;
  }

  return normalized;
}

function parseTurnServers() {
  const raw = typeof process.env.TURN_SERVERS === 'string'
    ? process.env.TURN_SERVERS.trim()
    : '';

  const fallback = [
    { urls: ['stun:stun.l.google.com:19302'] }
  ];
  const defaultTurnUsername = process.env.TURN_USERNAME || '';
  const defaultTurnCredential = process.env.TURN_CREDENTIAL || '';

  if (!raw) {
    const fallbackUrl = process.env.TURN_FALLBACK_URL;
    if (!fallbackUrl) {
      return fallback;
    }

    const fallbackTurn = {
      urls: [fallbackUrl]
    };

    const normalizedFallback = withTurnServerCredentials(
      fallbackTurn,
      defaultTurnUsername,
      defaultTurnCredential
    );
    if (normalizedFallback) {
      return [...fallback, normalizedFallback];
    }

    return fallback;
  }

  try {
    const candidates = [raw];
    if ((raw[0] === '\'' && raw[raw.length - 1] === '\'')
      || (raw[0] === '"' && raw[raw.length - 1] === '"')) {
      candidates.push(raw.slice(1, -1).trim());
    }

    for (const candidate of candidates) {
      const parsed = JSON.parse(candidate);

      if (Array.isArray(parsed) && parsed.length > 0) {
        const normalized = parsed
          .map((entry) => withTurnServerCredentials(
            entry,
            defaultTurnUsername,
            defaultTurnCredential
          ))
          .filter(Boolean);

        return normalized.length > 0 ? normalized : fallback;
      }

      if (parsed) {
        const normalized = withTurnServerCredentials(
          parsed,
          defaultTurnUsername,
          defaultTurnCredential
        );

        return normalized ? [normalized] : fallback;
      }
    }
  } catch (err) {
    return fallback;
  }

  return fallback;
}

module.exports = {
  listen: {
    host: process.env.LISTEN_IP || '0.0.0.0',
    port: toInt(process.env.PORT, 3000)
  },
  worker: {
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    rtcMinPort: toInt(process.env.WORKER_RTC_MIN_PORT, 40000),
    rtcMaxPort: toInt(process.env.WORKER_RTC_MAX_PORT, 49999)
  },
  mediaCodecs: [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
      preferredPayloadType: 111
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 800
      },
      preferredPayloadType: 96
    },
    {
      kind: 'video',
      mimeType: 'video/H264',
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '42e01f',
        'level-asymmetry-allowed': 1
      },
      preferredPayloadType: 102
    }
  ],
  webRtcTransport: {
    listenIps: [
      {
        ip: '0.0.0.0',
        announcedIp: resolveAnnouncedIp()
      }
    ],
    initialAvailableOutgoingBitrate: 800000,
    minimumAvailableOutgoingBitrate: 300000,
    maxSctpMessageSize: 262144,
    enableTcp: true,
    enableUdp: toBoolean(process.env.ENABLE_UDP, true),
    preferUdp: true,
    preferTcp: true,
    maxPacketLifeTime: 3000,
    minPort: toInt(process.env.WEBRTC_MIN_PORT, 49160),
    maxPort: toInt(process.env.WEBRTC_MAX_PORT, 49200)
  },
  room: {
    maxParticipants: toInt(process.env.ROOM_MAX_PARTICIPANTS, 10),
    password: process.env.ROOM_PASSWORD || ''
  },
  bitrate: {
    audio: {
      maxBitrate: 64000
    },
    video: {
      encodings: [
        {
          rid: 'r0',
          maxBitrate: 300000,
          maxFramerate: 20,
          scaleResolutionDownBy: 2
        },
        {
          rid: 'r1',
          maxBitrate: 800000,
          maxFramerate: 30,
          scaleResolutionDownBy: 1
        }
      ]
    }
  },
  rtcConfig: {
    iceServers: parseTurnServers()
  }
};
