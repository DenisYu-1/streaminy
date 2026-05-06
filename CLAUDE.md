# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Run locally:**
```bash
cd server
cp .env.example .env   # edit ANNOUNCED_IP, ROOM_PASSWORD
node src/index.js
# open http://localhost:3000
```

**Run via Docker (backend only):**
```bash
cd server
ANNOUNCED_IP=<your-ip> docker compose up -d --build
# open http://localhost:3000
```

**Run with observability (Prometheus + Grafana):**
```bash
docker compose -f docker-compose.observability.yml up -d
# Prometheus: http://localhost:9090
# Grafana:    http://localhost:3001  (admin / admin)
```

No test suite or linter is configured (ESLint config exists but not wired to CI).

## Architecture

WebRTC video conference with mediasoup SFU backend.

```
server/src/
  config.js       – env-driven config; parses TURN_SERVERS JSON, detects local IP
  roomManager.js  – mediasoup room/peer/transport/producer/consumer lifecycle
  metrics.js      – Prometheus metrics (prom-client); exposed at GET /metrics
  index.js        – HTTP server (serves client/) + WebSocket signaling dispatcher

client/
  app.js          – vanilla JS; mediasoup-client loaded from esm.sh CDN
  index.html / styles.css
```

### WebSocket signaling protocol

All client→server messages carry `{ type, requestId, data }`. Server echoes `requestId` back in the response. Consumers are created paused and need an explicit `resume-consumer` call.

**Client → Server (request/response):**
| type | purpose |
|------|---------|
| `join-room` | create/join room; returns `routerRtpCapabilities`, existing peers & producers |
| `create-transport` | `direction: 'send'|'recv'`; returns ICE/DTLS params |
| `connect-transport` | DTLS handshake |
| `produce` | publish track; broadcasts `new-producer` to other peers |
| `consume` | subscribe to a producer; returned consumer is paused |
| `resume-consumer` | unpause consumer server-side |
| `pause-producer` / `resume-producer` | mute/unmute own track |
| `close-producer` | stop publishing (screen share end); broadcasts `producer-closed` |
| `leave` | clean disconnect |

**Server → Client (push events, no requestId):**
`peer-joined`, `peer-left`, `new-producer`, `producer-closed`

### Room data model (server-side)

```
rooms: Map<roomId, {
  router,
  peers: Map<peerId, { socket, clientId, transports, producers, consumers }>,
  producers: Map<producerId, { peerId, producer, appData }>   // room-level index
}>
```

When the last peer leaves, the router is closed and the room is deleted.

### Client consume flow

1. On `join-room` response: iterate `existingProducers`, call `consumeProducer` for each.
2. On `new-producer` push: enqueue `consumeProducer` (serialized via `consumeQueue` promise chain to avoid race conditions).
3. `consumeProducer` → `consume` request → `recvTransport.consume()` → `resume-consumer` request.

### Duplicate-peer eviction

Client generates a stable `clientId` (stored in `sessionStorage`) and sends it on every `join-room`. Server calls `evictByClientId()` before adding a new peer, so a page reload or reconnect never leaves a ghost entry in the room. Same-socket double-join is guarded separately.

### Reconnect behavior

On disconnect (non-intentional), the client retries up to 5 times with exponential backoff (1 s → 16 s cap). During reconnect:
- Conference panel stays visible; peer tile DOM is preserved so browsers freeze video on last frame.
- A semi-transparent overlay (`.reconnecting`) dims frozen tiles.
- `activateRoom()` clears stale tiles atomically when the new session is established.

### Key env vars

| var | default | notes |
|-----|---------|-------|
| `PORT` | 3000 | HTTP + WS listen port |
| `LISTEN_IP` | 0.0.0.0 | bind address |
| `ANNOUNCED_IP` | auto-detect LAN IP | must be reachable by clients |
| `ROOM_PASSWORD` | *(none)* | required for all join-room calls if set |
| `ROOM_MAX_PARTICIPANTS` | 10 | per-room cap (`.env.example` sets 4) |
| `TURN_SERVERS` | Google STUN only | JSON array of ICE server objects |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | — | applied to entries missing credentials |
| `TURN_FALLBACK_URL` | — | single fallback TURN URL |
| `ENABLE_UDP` | true | set `false` for TCP-only TURN |
| `WORKER_RTC_MIN/MAX_PORT` | 40000–49999 | mediasoup worker UDP port range |
| `WEBRTC_MIN/MAX_PORT` | 49160–49200 | WebRTC transport port range |

### mediasoup codecs

Opus (audio), VP8 (video, simulcast), H264 baseline (video). Video uses 2-layer simulcast (`r0`: 300 kbps ×2 downscale, `r1`: 800 kbps full).

### `appData.mediaType` values

`'microphone'`, `'camera'`, `'screen'` — used on the client to route screen producers to the `#screenGrid` element rather than the peer tile.

### Prometheus metrics (`GET /metrics`)

| metric | type | description |
|--------|------|-------------|
| `mediasoup_rooms` | gauge | active rooms |
| `mediasoup_peers` | gauge | connected peers |
| `mediasoup_producers{kind}` | gauge | active producers by audio/video |
| `mediasoup_consumers` | gauge | active consumers |
| `mediasoup_ws_connections` | gauge | open WebSocket connections |
| `mediasoup_messages_total{type}` | counter | signaling messages by type |
| `mediasoup_producer_bitrate_bits{room,kind,media_type}` | gauge | per-producer bitrate |
| `mediasoup_producer_score{...}` | gauge | quality score 0–10 |
| `mediasoup_producer_packets_lost{...}` | gauge | cumulative packets lost |
| `mediasoup_producer_jitter_seconds{...}` | gauge | jitter |
