import { Device } from 'https://esm.sh/mediasoup-client@3.18.7?bundle';

const _urlParams = new URLSearchParams(window.location.search);
const ROOM_ID = _urlParams.get('room') || 'main';
const isStreamer = _urlParams.get('streamer') === '1';
const isViewer   = _urlParams.get('viewer')   === '1';
const role = isStreamer ? 'streamer' : isViewer ? 'viewer' : 'watcher';

const joinPanel = document.getElementById('joinPanel');
const conferencePanel = document.getElementById('conferencePanel');
const roomPasswordInput = document.getElementById('roomPassword');
const peerNameInput = document.getElementById('peerName');
const joinForm = document.getElementById('joinForm');
const joinButton = joinForm.querySelector('button[type="submit"]');
const joinError = document.getElementById('joinError');
const localVideo = document.getElementById('localVideo');
const localName = document.getElementById('localName');
const participantsContainer = document.getElementById('participants');
const screenGrid = document.getElementById('screenGrid');

const muteMicButton = document.getElementById('muteMic');
const muteVideoButton = document.getElementById('muteVideo');
const startScreenButton = document.getElementById('startScreen');
const stopScreenButton = document.getElementById('stopScreen');
const leaveRoomButton = document.getElementById('leaveRoom');
const reconnectBanner = document.getElementById('reconnectBanner');

if (isStreamer) {
  startScreenButton.hidden = false;
  stopScreenButton.hidden = false;
}

let socket;
const roomId = ROOM_ID;
let currentPeerId = '';
let device;
let sendTransport;
let recvTransport;
let localStream;
let micProducer;
let cameraProducer;
let screenProducer;
let rtpCapabilities = null;
let audioCodecBitrate = 64_000;
let videoEncodings = [];
let isConnecting = false;
let consumeQueue = Promise.resolve();

let sessionPeerName = '';
let sessionPassword = '';
let intentionalLeave = false;

let clientId = sessionStorage.getItem('clientId');
if (!clientId) {
  clientId = crypto.randomUUID();
  sessionStorage.setItem('clientId', clientId);
}
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 5;

const pendingRequests = new Map();
let pendingRequestId = 0;
const participants = new Map();
const participantsData = new Map();
const consumers = new Map();
const producerToConsumerMap = new Map();
const peerToConsumerIds = new Map();

function logIceServerConnection(label, payload = null) {
  if (payload === null) {
    console.info(`[ice] ${label}`);
    return;
  }

  console.info(`[ice] ${label}`, payload);
}

function logIceServerConfig(iceServers) {
  if (!Array.isArray(iceServers) || iceServers.length === 0) {
    return;
  }

  const normalized = iceServers
    .map((entry) => ({
      urls: Array.isArray(entry?.urls) ? entry.urls : [entry?.urls].filter(Boolean),
      hasCredentials: Boolean(entry?.username || entry?.credential)
    }))
    .filter((entry) => entry.urls.length);

  if (normalized.length === 0) {
    return;
  }

  logIceServerConnection('ice server config', {
    count: normalized.length,
    servers: normalized
  });
}

function logIceTransportConfig(transport, direction) {
  const iceServerCount = transport?.iceServers?.length || 0;
  const candidateCount = transport?.iceCandidates?.length || 0;

  logIceServerConnection('transport ice config', {
    direction,
    transportId: transport?.id,
    iceServerCount,
    iceParameterProvided: Boolean(transport?.iceParameters),
    iceCandidateCount: candidateCount
  });
}

function enqueueConsume(consumerTask) {
  consumeQueue = consumeQueue
    .then(consumerTask)
    .catch(() => {});
  return consumeQueue;
}

function prepareVideoElement(video) {
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;

  const startPlayback = () => { void video.play().catch(() => {}); };
  video.addEventListener('canplay', startPlayback, { once: true });
  video.addEventListener('loadedmetadata', startPlayback, { once: true });
}

function nextRequestId() {
  pendingRequestId += 1;
  return String(pendingRequestId);
}

function setJoinBusy(isBusy) {
  joinButton.disabled = isBusy;
  joinButton.textContent = isBusy ? 'Подключаюсь...' : 'Подключиться';
}

function showJoinError(message) {
  joinError.textContent = message;
  joinError.hidden = false;
}

function clearJoinError() {
  joinError.hidden = true;
  joinError.textContent = '';
}

function buildWebSocketUrl() {
  if (window.location.protocol === 'file:') {
    throw new Error('Откройте приложение через HTTP-сервер (например, localhost:3000).');
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

function isMediaContextAvailable() {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '::1') {
    return true;
  }

  return Boolean(window.isSecureContext);
}

function getMediaConstraintError() {
  if (isMediaContextAvailable()) {
    return 'Браузер не предоставляет API getUserMedia. Обновите браузер.';
  }

  return 'В браузере запрещён доступ к камере без HTTPS. Откройте сайт по HTTPS или на localhost.';
}

async function requestUserMedia(constraints) {
  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices && typeof mediaDevices.getUserMedia === 'function') {
    return mediaDevices.getUserMedia(constraints);
  }

  throw new Error(getMediaConstraintError());
}

async function requestDisplayMedia(constraints) {
  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices && typeof mediaDevices.getDisplayMedia === 'function') {
    return mediaDevices.getDisplayMedia(constraints);
  }

  throw new Error('Ваш браузер не поддерживает совместный показ экрана.');
}

async function activateRoom(payload) {
  participantsContainer.innerHTML = '';
  screenGrid.innerHTML = '';
  document.getElementById('screenArea').classList.remove('active');
  conferencePanel.classList.remove('reconnecting');
  participants.clear();
  participantsData.clear();

  currentPeerId = payload.peerId;
  rtpCapabilities = payload.routerRtpCapabilities;
  setBitrateSettings(payload.bitrate);
  logIceServerConfig(payload.rtcConfig?.iceServers);

  localName.textContent = payload.name || payload.peerName || 'Guest';
  isConnecting = false;
  setJoinBusy(false);
  clearJoinError();

  payload.participants.forEach(({ peerId, name, role: peerRole }) => {
    participantsData.set(peerId, { name, role: peerRole });
    getOrCreateTile(peerId, name, peerRole);
  });

  if (isViewer) {
    conferencePanel.classList.add('viewer-mode');
  }

  if (isStreamer || isViewer) {
    muteMicButton.hidden = true;
    muteVideoButton.hidden = true;
  }

  if (isStreamer) {
    document.getElementById('localTile').hidden = true;
  }

  await createDevice();
  await setupTransports();
  for (const producer of payload.existingProducers) {
    await enqueueConsume(() => consumeProducer(producer));
  }
  if (!isStreamer) {
    await publishLocalMedia();
  }

  joinPanel.hidden = true;
  conferencePanel.hidden = false;
}

function sendRequest(type, data = {}) {
  const requestId = nextRequestId();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('signal timeout'));
    }, 15000);

    pendingRequests.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ type, requestId, data }));
  });
}

function resolveRequest(message) {
  const deferred = pendingRequests.get(String(message.requestId));
  if (!deferred) {
    return;
  }

  clearTimeout(deferred.timer);
  pendingRequests.delete(String(message.requestId));

  if (message.error) {
    deferred.reject(new Error(message.error));
    return;
  }

  deferred.resolve(message.payload);
}

function setBitrateSettings(settings = {}) {
  if (settings.audio?.maxBitrate) {
    audioCodecBitrate = settings.audio.maxBitrate;
  }

  if (settings.video?.encodings?.length) {
    videoEncodings = settings.video.encodings;
  }
}

function getOrCreateTile(peerIdValue, name, peerRole) {
  if (participants.has(peerIdValue)) {
    return participants.get(peerIdValue);
  }

  if (peerRole === 'streamer') {
    return null;
  }

  const tile = document.createElement('article');
  tile.className = 'peer-tile';
  tile.dataset.peerId = peerIdValue;
  // if (peerRole) {
  //   tile.dataset.role = peerRole;
  // }

  const title = document.createElement('h4');
  title.textContent = name || `participant-${peerIdValue.slice(0, 6)}`;

  const mediaArea = document.createElement('div');
  mediaArea.className = 'media-area';

  tile.appendChild(mediaArea);
  mediaArea.appendChild(title);

  participantsContainer.appendChild(tile);
  participants.set(peerIdValue, tile);

  return tile;
}

function addConsumerTrack(peerIdValue, stream, kind, mediaId, isScreen) {
  const peerData = participantsData.get(peerIdValue);
  const tile = getOrCreateTile(peerIdValue, peerData?.name, peerData?.role);

  if (kind === 'audio') {
    if (!tile) return;
    const audio = document.createElement('audio');
    audio.dataset.mediaId = mediaId;
    audio.autoplay = true;
    audio.srcObject = stream;
    tile.querySelector('.media-area').appendChild(audio);
    return;
  }

  if (isScreen) {
    const holder = document.createElement('article');
    holder.className = 'screen-item';
    holder.dataset.mediaId = mediaId;

    const label = document.createElement('span');
    label.textContent = `${participantsData.get(peerIdValue)?.name || 'Участник'} · screen`;

    const video = document.createElement('video');
    video.dataset.mediaId = mediaId;
    video.srcObject = stream;

    holder.appendChild(label);
    holder.appendChild(video);
    screenGrid.appendChild(holder);
    document.getElementById('screenArea').classList.add('active');
    prepareVideoElement(video);
    return;
  }

  if (!tile) return;

  const video = document.createElement('video');
  video.dataset.mediaId = mediaId;
  video.srcObject = stream;

  tile.querySelector('.media-area').appendChild(video);
  prepareVideoElement(video);
}

function removeByConsumerId(consumerId) {
  const refs = [
    ...document.querySelectorAll(`[data-media-id='${consumerId}']`)
  ];

  for (const node of refs) {
    node.remove();
  }

  if (screenGrid.children.length === 0) {
    document.getElementById('screenArea').classList.remove('active');
  }

  if (consumers.has(consumerId)) {
    const entry = consumers.get(consumerId);
    entry.consumer.close();

    const peerConsumers = peerToConsumerIds.get(entry.peerId);
    peerConsumers?.delete(consumerId);

    producerToConsumerMap.delete(entry.producerId);
    consumers.delete(consumerId);
  }
}

function addConsumerLink(peerIdValue, consumerId, producerId) {
  if (!peerToConsumerIds.has(peerIdValue)) {
    peerToConsumerIds.set(peerIdValue, new Set());
  }

  peerToConsumerIds.get(peerIdValue).add(consumerId);
  producerToConsumerMap.set(producerId, consumerId);
}

function removeAllPeerConsumers(peerIdValue) {
  const consumerIds = peerToConsumerIds.get(peerIdValue);
  if (!consumerIds) {
    return;
  }

  for (const consumerId of consumerIds) {
    removeByConsumerId(consumerId);
  }

  peerToConsumerIds.delete(peerIdValue);
}

function removeParticipantFromDom(peerIdValue) {
  const tile = participants.get(peerIdValue);
  if (tile) {
    tile.remove();
    participants.delete(peerIdValue);
  }

  participantsData.delete(peerIdValue);
  removeAllPeerConsumers(peerIdValue);
}

async function createDevice() {
  device = new Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });
}

async function setupTransports() {
  const sendTransportResponse = await sendRequest('create-transport', { direction: 'send' });
  const recvTransportResponse = await sendRequest('create-transport', { direction: 'recv' });
  logIceTransportConfig(sendTransportResponse.transport, 'send');
  logIceTransportConfig(recvTransportResponse.transport, 'recv');

  sendTransport = device.createSendTransport(sendTransportResponse.transport);
  recvTransport = device.createRecvTransport(recvTransportResponse.transport);

  sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    try {
      await sendRequest('connect-transport', {
        transportId: sendTransport.id,
        dtlsParameters
      });
      callback();
    } catch (error) {
      errback(error);
    }
  });

  sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
    try {
      const { producerId } = await sendRequest('produce', {
        transportId: sendTransport.id,
        kind,
        rtpParameters,
        appData
      });

      callback({ id: producerId });
    } catch (error) {
      errback(error);
    }
  });

  recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    try {
      await sendRequest('connect-transport', {
        transportId: recvTransport.id,
        dtlsParameters
      });
      callback();
    } catch (error) {
      errback(error);
    }
  });
}

async function publishLocalMedia() {
  const tracksLive = localStream?.getTracks().some((t) => t.readyState === 'live');
  if (!tracksLive) {
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = await requestUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      },
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        frameRate: { ideal: 30 }
      }
    });
  }

  localVideo.srcObject = localStream;

  const audioTrack = localStream.getAudioTracks()[0];
  const videoTrack = localStream.getVideoTracks()[0];

  if (audioTrack) {
    micProducer = await sendTransport.produce({
      track: audioTrack,
      codecOptions: {
        opusStereo: 1,
        opusDtx: true,
        maxBitrate: audioCodecBitrate
      },
      appData: { mediaType: 'microphone' }
    });
  }

  if (videoTrack) {
    cameraProducer = await sendTransport.produce({
      track: videoTrack,
      encodings: videoEncodings,
      appData: { mediaType: 'camera' }
    });
  }
}

async function publishScreen() {
  if (!sendTransport) {
    return;
  }

  const stream = await requestDisplayMedia({
    video: {
      width: { max: 1920 },
      height: { max: 1080 },
      frameRate: { ideal: 30 }
    },
    audio: false
  });

  const [track] = stream.getVideoTracks();
  track.onended = stopScreenShare;

  screenProducer = await sendTransport.produce({
    track,
    appData: {
      mediaType: 'screen',
      source: 'screen-share'
    }
  });

  startScreenButton.disabled = true;
  stopScreenButton.disabled = false;
}

async function stopScreenShare() {
  if (!screenProducer) {
    return;
  }

  await sendRequest('close-producer', {
    producerId: screenProducer.id
  });

  screenProducer.close();
  screenProducer = null;
  startScreenButton.disabled = false;
  stopScreenButton.disabled = true;
}

async function consumeProducer({ producerId, peerId: sourcePeerId, appData }) {
  if (!sourcePeerId || sourcePeerId === currentPeerId) {
    return;
  }

  if (producerToConsumerMap.has(producerId)) {
    return;
  }

  if (isViewer && appData?.mediaType === 'screen') {
    return;
  }

  const response = await sendRequest('consume', {
    transportId: recvTransport.id,
    producerId,
    rtpCapabilities: device.rtpCapabilities
  });

  if (isViewer && response?.appData?.mediaType === 'screen') {
    return;
  }

  const consumer = await recvTransport.consume({
    id: response.consumerId,
    producerId: response.producerId,
    kind: response.kind,
    rtpParameters: response.rtpParameters
  });

  const stream = new MediaStream([consumer.track]);

  const isScreen = response?.appData?.mediaType === 'screen' || appData?.mediaType === 'screen';
  addConsumerTrack(sourcePeerId, stream, response.kind, response.consumerId, isScreen);

  consumers.set(response.consumerId, {
    consumer,
    peerId: sourcePeerId,
    producerId
  });
  addConsumerLink(sourcePeerId, response.consumerId, producerId);

  consumer.on('trackended', () => {
    removeByConsumerId(response.consumerId);
  });

  consumer.on('producerclose', () => {
    removeByConsumerId(response.consumerId);
  });

  try {
    await sendRequest('resume-consumer', {
      consumerId: response.consumerId
    });
    if (consumer.paused) {
      await consumer.resume();
    }
  } catch {
    // resume failure is non-fatal
  }
}

async function pauseCamera() {
  if (!cameraProducer || cameraProducer.paused) {
    return;
  }

  await sendRequest('pause-producer', {
    producerId: cameraProducer.id
  });

  cameraProducer.pause();
}

async function resumeCamera() {
  if (!cameraProducer || !cameraProducer.paused) {
    return;
  }

  await sendRequest('resume-producer', {
    producerId: cameraProducer.id
  });

  cameraProducer.resume();
}

async function pauseMic() {
  if (!micProducer || micProducer.paused) {
    return;
  }

  await sendRequest('pause-producer', {
    producerId: micProducer.id
  });

  micProducer.pause();
}

async function resumeMic() {
  if (!micProducer || !micProducer.paused) {
    return;
  }

  await sendRequest('resume-producer', {
    producerId: micProducer.id
  });

  micProducer.resume();
}

// Full reset — stops camera tracks, used on intentional leave and final give-up.
function resetSession() {
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  localVideo.srcObject = null;

  participantsContainer.innerHTML = '';
  screenGrid.innerHTML = '';
  document.getElementById('screenArea').classList.remove('active');
  conferencePanel.classList.remove('reconnecting');
  participants.clear();
  participantsData.clear();

  softReset();
}

// Partial reset — tears down mediasoup state but preserves localStream and peer tile DOM
// (frozen last frames stay visible during reconnect).
function softReset() {
  clearTimeout(reconnectTimer);

  for (const { timer, reject } of pendingRequests.values()) {
    clearTimeout(timer);
    reject(new Error('disconnected'));
  }
  pendingRequests.clear();

  conferencePanel.classList.add('reconnecting');

  for (const info of consumers.values()) {
    info.consumer.close();
  }

  consumers.clear();
  producerToConsumerMap.clear();
  peerToConsumerIds.clear();

  sendTransport?.close();
  recvTransport?.close();
  sendTransport = null;
  recvTransport = null;
  device = null;
  micProducer = null;
  cameraProducer = null;
  screenProducer = null;
  currentPeerId = '';
  consumeQueue = Promise.resolve();

  if (socket) {
    socket.onmessage = null;
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    reconnectBanner.hidden = true;
    resetSession();
    conferencePanel.hidden = true;
    joinPanel.hidden = false;
    showJoinError('Соединение потеряно. Попробуйте снова.');
    reconnectAttempts = 0;
    return;
  }

  const delay = Math.min(1000 * (2 ** reconnectAttempts), 16000);
  reconnectAttempts++;

  reconnectBanner.textContent = `Нет соединения. Переподключение ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}…`;
  reconnectBanner.hidden = false;

  softReset();

  reconnectTimer = setTimeout(() => connectAndJoin(sessionPeerName, sessionPassword), delay);
}

function connectAndJoin(peerName, password) {
  try {
    socket = new WebSocket(buildWebSocketUrl());
  } catch (error) {
    if (reconnectAttempts > 0) {
      scheduleReconnect();
    } else {
      isConnecting = false;
      setJoinBusy(false);
      showJoinError(error.message);
    }
    return;
  }

  socket.addEventListener('error', () => {
    if (reconnectAttempts === 0) {
      isConnecting = false;
      setJoinBusy(false);
      showJoinError('Не удалось подключиться к серверу. Проверьте, что backend запущен.');
    }
  });

  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);

    if (message.requestId) {
      resolveRequest(message);
      return;
    }

    if (message.type === 'error') {
      if (isConnecting) {
        isConnecting = false;
        setJoinBusy(false);
        showJoinError(message.error);
      }
      return;
    }

    if (message.type === 'peer-joined') {
      participantsData.set(message.peerId, { name: message.name, role: message.role });
      getOrCreateTile(message.peerId, message.name, message.role);
      return;
    }

    if (message.type === 'peer-left') {
      removeParticipantFromDom(message.peerId);
      return;
    }

    if (message.type === 'new-producer') {
      void enqueueConsume(() => consumeProducer(message));
      return;
    }

    if (message.type === 'producer-closed') {
      const consumerId = producerToConsumerMap.get(message.producerId);
      if (consumerId) {
        removeByConsumerId(consumerId);
      }
      return;
    }
  });

  socket.addEventListener('open', async () => {
    try {
      const roomPayload = await sendRequest('join-room', {
        roomId,
        peerName,
        password,
        role,
        clientId
      });

      reconnectAttempts = 0;
      reconnectBanner.hidden = true;

      await activateRoom({ ...roomPayload, peerName });
    } catch (error) {
      if (reconnectAttempts > 0) {
        socket.close();
      } else {
        isConnecting = false;
        setJoinBusy(false);
        showJoinError(error.message);
        socket.close();
      }
    }
  });

  socket.addEventListener('close', () => {
    if (intentionalLeave) {
      intentionalLeave = false;
      reconnectBanner.hidden = true;
      resetSession();
      conferencePanel.hidden = true;
      joinPanel.hidden = false;
      return;
    }

    if (isConnecting) {
      isConnecting = false;
      setJoinBusy(false);
      resetSession();
      conferencePanel.hidden = true;
      joinPanel.hidden = false;
      return;
    }

    scheduleReconnect();
  });
}

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isConnecting) {
    return;
  }

  const peerName = peerNameInput.value.trim() || 'Guest';
  const password = roomPasswordInput.value;

  if (!password) {
    showJoinError('Введите пароль.');
    return;
  }

  clearJoinError();
  setJoinBusy(true);
  isConnecting = true;

  sessionPeerName = peerName;
  sessionPassword = password;

  connectAndJoin(peerName, password);

  localStorage.setItem('peerName', peerName);
});

muteMicButton.addEventListener('click', async () => {
  if (!micProducer) {
    return;
  }

  if (micProducer.paused) {
    await resumeMic();
    muteMicButton.textContent = 'Выключить микрофон';
    return;
  }

  await pauseMic();
  muteMicButton.textContent = 'Включить микрофон';
});

muteVideoButton.addEventListener('click', async () => {
  if (!cameraProducer) {
    return;
  }

  if (cameraProducer.paused) {
    await resumeCamera();
    muteVideoButton.textContent = 'Отключить видео';
    return;
  }

  await pauseCamera();
  muteVideoButton.textContent = 'Включить видео';
});

startScreenButton.addEventListener('click', () => {
  void publishScreen();
});

stopScreenButton.addEventListener('click', () => {
  void stopScreenShare();
});

leaveRoomButton.addEventListener('click', async () => {
  intentionalLeave = true;

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    if (socket.readyState === WebSocket.OPEN) {
      try { await sendRequest('leave', {}); } catch (_e) { /* leaving anyway */ }
    }
    socket.close(); // intentionalLeave=true → close handler does cleanup
  } else {
    // Socket already closed (e.g. in reconnect delay window)
    intentionalLeave = false;
    reconnectBanner.hidden = true;
    resetSession();
    conferencePanel.hidden = true;
    joinPanel.hidden = false;
  }
});

(() => {
  const savedName = localStorage.getItem('peerName');
  if (savedName) {
    peerNameInput.value = savedName;
  }
})();
