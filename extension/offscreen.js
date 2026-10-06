const DEFAULT_SERVER_URL = 'ws://127.0.0.1:8765';
const SAMPLE_RATE = 16000;
const FRAME_INTERVAL_MS = 5000;
const DIFF_THRESHOLD = 0.05;
const COMPARE_WIDTH = 160;
const COMPARE_HEIGHT = 90;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;

const captures = new Map();

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'start-capture':
      startCapture(message.streamId, message.tabId, message.tabTitle, message.serverUrl, message.localToken);
      break;
    case 'stop-capture':
      stopCapture(message.tabId);
      break;
    case 'toggle-audio': {
      const c = captures.get(message.tabId);
      if (c?.audioPlayback) {
        c.audioPlayback.muted = !c.audioPlayback.muted;
        chrome.runtime.sendMessage({
          type: 'audio-state',
          tabId: message.tabId,
          muted: c.audioPlayback.muted
        }).catch(() => {});
      }
      break;
    }
  }
});

async function startCapture(streamId, tabId, tabTitle, serverUrl, localToken) {
  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        }
      });
    } catch (e) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        }
      });
    }

    const wsUrl = (serverUrl || DEFAULT_SERVER_URL).replace(/^http/, 'ws');
    const ws = new WebSocket(wsUrl);
    const capture = {
      stream, ws, audioContext: null, processor: null,
      tabId, tabTitle, serverUrl: wsUrl, localToken,
      videoEl: null, fullCanvas: null, fullCtx: null,
      compareCanvas: null, compareCtx: null,
      prevCompareData: null, frameInterval: null, frameIndex: 0
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'start', tabId, tabTitle, token: localToken }));
      setupAudioPlayback(capture);
      setupAudioProcessing(capture);
      setupVideoCapture(capture);
      sendStatus(tabId, 'capturing');
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'transcript':
          chrome.runtime.sendMessage({
            type: 'transcript',
            tabId,
            text: data.text,
            isFinal: data.isFinal
          });
          break;
        case 'status':
          sendStatus(tabId, data.status);
          break;
        case 'error':
          chrome.runtime.sendMessage({ type: 'capture-error', tabId, error: data.message });
          break;
      }
    };

    ws.onerror = () => {
      if (!capture.reconnecting) {
        chrome.runtime.sendMessage({
          type: 'capture-error',
          tabId,
          error: 'Cannot connect to companion server. Is it running?'
        });
        cleanup(tabId);
      }
    };

    ws.onclose = () => {
      if (capture.reconnecting) return;
      if (captures.has(tabId) && capture.stream.active) {
        capture.reconnectAttempts = (capture.reconnectAttempts || 0) + 1;
        if (capture.reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
          console.log(`[Scout] Server connection lost for tab ${tabId}, reconnecting (attempt ${capture.reconnectAttempts})...`);
          capture.reconnecting = true;
          setTimeout(() => reconnectWebSocket(capture), RECONNECT_DELAY_MS);
          return;
        }
        console.log(`[Scout] Max reconnect attempts reached for tab ${tabId}`);
      }
      cleanup(tabId);
    };

    captures.set(tabId, capture);
  } catch (err) {
    chrome.runtime.sendMessage({ type: 'capture-error', tabId, error: err.message });
  }
}

function setupAudioPlayback(capture) {
  const audio = document.createElement('audio');
  audio.srcObject = new MediaStream(capture.stream.getAudioTracks());
  audio.muted = true;
  audio.play().catch(() => {});
  capture.audioPlayback = audio;
}

function setupAudioProcessing(capture) {
  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(capture.stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event) => {
    if (capture.ws.readyState !== WebSocket.OPEN) return;
    const float32 = event.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    capture.ws.send(int16.buffer);
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  capture.audioContext = audioContext;
  capture.processor = processor;
}

function setupVideoCapture(capture) {
  const videoTracks = capture.stream.getVideoTracks();
  if (videoTracks.length === 0) return;

  const videoEl = document.createElement('video');
  videoEl.srcObject = new MediaStream(videoTracks);
  videoEl.muted = true;
  videoEl.play();

  const fullCanvas = document.createElement('canvas');
  const fullCtx = fullCanvas.getContext('2d');

  const compareCanvas = document.createElement('canvas');
  compareCanvas.width = COMPARE_WIDTH;
  compareCanvas.height = COMPARE_HEIGHT;
  const compareCtx = compareCanvas.getContext('2d', { willReadFrequently: true });

  capture.videoEl = videoEl;
  capture.fullCanvas = fullCanvas;
  capture.fullCtx = fullCtx;
  capture.compareCanvas = compareCanvas;
  capture.compareCtx = compareCtx;

  videoEl.addEventListener('loadedmetadata', () => {
    fullCanvas.width = videoEl.videoWidth;
    fullCanvas.height = videoEl.videoHeight;
    capture.frameInterval = setInterval(() => captureFrame(capture), FRAME_INTERVAL_MS);
  });
}

function captureFrame(capture) {
  if (!capture.videoEl || capture.videoEl.readyState < 2) return;
  if (capture.ws.readyState !== WebSocket.OPEN) return;

  capture.compareCtx.drawImage(capture.videoEl, 0, 0, COMPARE_WIDTH, COMPARE_HEIGHT);
  const currData = capture.compareCtx.getImageData(0, 0, COMPARE_WIDTH, COMPARE_HEIGHT);

  if (capture.prevCompareData) {
    const diff = computeDiff(capture.prevCompareData, currData.data);
    if (diff < DIFF_THRESHOLD) return;
  }

  capture.prevCompareData = new Uint8ClampedArray(currData.data);

  capture.fullCtx.drawImage(capture.videoEl, 0, 0);
  capture.fullCanvas.toBlob((blob) => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      capture.frameIndex++;
      capture.ws.send(JSON.stringify({
        type: 'frame',
        tabId: capture.tabId,
        frameIndex: capture.frameIndex,
        timestamp: new Date().toISOString(),
        data: base64
      }));
      chrome.runtime.sendMessage({
        type: 'frame-captured',
        tabId: capture.tabId,
        frameIndex: capture.frameIndex
      });
    };
    reader.readAsDataURL(blob);
  }, 'image/jpeg', 0.85);
}

function computeDiff(prev, curr) {
  let totalDiff = 0;
  const pixels = prev.length / 4;
  for (let i = 0; i < prev.length; i += 4) {
    totalDiff += Math.abs(prev[i] - curr[i]);
    totalDiff += Math.abs(prev[i + 1] - curr[i + 1]);
    totalDiff += Math.abs(prev[i + 2] - curr[i + 2]);
  }
  return totalDiff / (pixels * 3 * 255);
}

function reconnectWebSocket(capture) {
  const ws = new WebSocket(capture.serverUrl || DEFAULT_SERVER_URL);
  capture.reconnecting = false;

  ws.onopen = () => {
    console.log(`[Scout] Reconnected to server for tab ${capture.tabId}`);
    capture.reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: 'start', tabId: capture.tabId, tabTitle: capture.tabTitle, token: capture.localToken }));
    sendStatus(capture.tabId, 'capturing');
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case 'transcript':
        chrome.runtime.sendMessage({
          type: 'transcript',
          tabId: capture.tabId,
          text: data.text,
          isFinal: data.isFinal
        });
        break;
      case 'status':
        sendStatus(capture.tabId, data.status);
        break;
      case 'error':
        chrome.runtime.sendMessage({ type: 'capture-error', tabId: capture.tabId, error: data.message });
        break;
    }
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    if (captures.has(capture.tabId) && capture.stream.active) {
      capture.reconnectAttempts = (capture.reconnectAttempts || 0) + 1;
      if (capture.reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        console.log(`[Scout] Reconnect failed for tab ${capture.tabId}, retrying (attempt ${capture.reconnectAttempts})...`);
        setTimeout(() => reconnectWebSocket(capture), RECONNECT_DELAY_MS);
        return;
      }
      console.log(`[Scout] Max reconnect attempts reached for tab ${capture.tabId}`);
      chrome.runtime.sendMessage({
        type: 'capture-error',
        tabId: capture.tabId,
        error: 'Lost connection to server after multiple retries'
      });
    }
    cleanup(capture.tabId);
  };

  capture.ws = ws;
}

function stopCapture(tabId) {
  const capture = captures.get(tabId);
  if (!capture) return;
  if (capture.ws.readyState === WebSocket.OPEN) {
    capture.ws.send(JSON.stringify({ type: 'stop' }));
    capture.ws.close();
  }
  cleanup(tabId);
}

function cleanup(tabId) {
  const capture = captures.get(tabId);
  if (!capture) return;
  if (capture.frameInterval) clearInterval(capture.frameInterval);
  if (capture.processor) capture.processor.disconnect();
  if (capture.audioContext) capture.audioContext.close();
  if (capture.audioPlayback) { capture.audioPlayback.pause(); capture.audioPlayback.srcObject = null; }
  if (capture.stream) capture.stream.getTracks().forEach(t => t.stop());
  captures.delete(tabId);
}

function sendStatus(tabId, status) {
  chrome.runtime.sendMessage({ type: 'capture-status', tabId, status });
}
