const tabList = document.getElementById('tab-list');
const serverDot = document.getElementById('server-dot');
const serverLabel = document.getElementById('server-label');

let captureSessions = {};
let transcripts = {};
let audioMuted = {};
const DEFAULT_SERVER_BASE = 'http://127.0.0.1:8765';

async function getServerConfig() {
  const config = await chrome.storage.local.get(['serverUrl', 'localToken']);
  return { serverUrl: config.serverUrl || DEFAULT_SERVER_BASE, localToken: config.localToken || '' };
}

const SPEAKER_SVG = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8.5v7a4.49 4.49 0 002.5-3.5zM14 3.23v2.06a6.51 6.51 0 010 13.42v2.06A8.5 8.5 0 0014 3.23z"/></svg>';
const MUTED_SVG = '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0014 8.5v2.09l2.44 2.44c.03-.17.06-.34.06-.53zm2.5 0a6.5 6.5 0 00-.78-3.11l-1.49 1.49A4.45 4.45 0 0117 12h2zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.46 8.46 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4l-1.88 1.88L12 7.76V4z"/></svg>';

async function checkServer() {
  try {
    const config = await getServerConfig();
    if (!config.localToken) throw new Error('missing token');
    const res = await fetch(`${config.serverUrl}/status`, { headers: { 'X-Scout-Token': config.localToken } });
    if (res.ok) {
      serverDot.className = 'dot connected';
      serverLabel.textContent = 'Server connected';
      return true;
    }
  } catch {}
  serverDot.className = 'dot error';
  serverLabel.textContent = 'Configure Settings or start server';
  return false;
}

async function loadStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
      if (response?.sessions) captureSessions = response.sessions;
      resolve();
    });
  });
}

async function renderTabs() {
  const tabs = await chrome.tabs.query({});
  const capturable = tabs.filter(t =>
    t.url && (t.url.startsWith('http://') || t.url.startsWith('https://'))
  );

  capturable.sort((a, b) => {
    const aCapturing = captureSessions[a.id] ? 1 : 0;
    const bCapturing = captureSessions[b.id] ? 1 : 0;
    if (aCapturing !== bCapturing) return bCapturing - aCapturing;
    const aAudible = a.audible ? 1 : 0;
    const bAudible = b.audible ? 1 : 0;
    return bAudible - aAudible;
  });

  if (capturable.length === 0) {
    tabList.innerHTML = '<div class="empty">No capturable tabs open</div>';
    return;
  }

  tabList.innerHTML = '';
  for (const tab of capturable) {
    const session = captureSessions[tab.id];
    const isCapturing = !!session;
    const status = session?.status || 'idle';
    const transcript = transcripts[tab.id] || '';

    const item = document.createElement('div');
    item.className = 'tab-item';
    item.dataset.tabId = tab.id;

    const icon = tab.favIconUrl
      ? `<img class="tab-icon" src="${tab.favIconUrl}" onerror="this.style.display='none'">`
      : '<span class="tab-icon"></span>';

    const audibleIcon = tab.audible
      ? '<svg class="audible-badge" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8.5v7a4.49 4.49 0 002.5-3.5zM14 3.23v2.06a6.51 6.51 0 010 13.42v2.06A8.5 8.5 0 0014 3.23z"/></svg>'
      : '';

    const frameCount = session?.frameCount || 0;
    const statusLabel = {
      idle: 'Ready',
      capturing: 'Capturing...',
      transcribing: 'Transcribing'
    }[status] || status;

    const statusDotClass = status === 'idle' ? '' : status;

    const isMuted = audioMuted[tab.id] || false;

    item.innerHTML = `
      ${icon}
      <div class="tab-info">
        <div class="tab-title">${escapeHtml(tab.title || 'Untitled')}${audibleIcon}</div>
        <div class="tab-status">
          ${isCapturing ? `<span class="dot ${statusDotClass}"></span> ${statusLabel}${frameCount > 0 ? ` · ${frameCount} slide${frameCount !== 1 ? 's' : ''}` : ''}` : ''}
        </div>
        ${transcript ? `<div class="tab-transcript">${escapeHtml(transcript)}</div>` : ''}
      </div>
      ${isCapturing ? `<button class="audio-btn ${isMuted ? 'muted' : ''}" data-tab-id="${tab.id}" title="${isMuted ? 'Unmute audio' : 'Mute audio'}">${isMuted ? MUTED_SVG : SPEAKER_SVG}</button>` : ''}
      <button class="capture-btn ${isCapturing ? 'stop' : 'start'}" data-tab-id="${tab.id}">
        ${isCapturing ? 'Stop' : 'Capture'}
      </button>
    `;

    const btn = item.querySelector('.capture-btn');
    btn.addEventListener('click', () => handleCaptureClick(tab, isCapturing, btn));

    const audioBtn = item.querySelector('.audio-btn');
    if (audioBtn) {
      audioBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'toggle-audio', tabId: tab.id });
      });
    }

    tabList.appendChild(item);
  }
}

async function handleCaptureClick(tab, isCapturing, btn) {
  btn.disabled = true;

  if (isCapturing) {
    chrome.runtime.sendMessage({ type: 'stop-capture', tabId: tab.id });
    delete captureSessions[tab.id];
    delete transcripts[tab.id];
    renderTabs();
    return;
  }

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    chrome.runtime.sendMessage({
      type: 'start-capture',
      streamId,
      tabId: tab.id,
      tabTitle: tab.title || `Tab ${tab.id}`
    }, (response) => {
      if (response?.success) {
        captureSessions[tab.id] = { status: 'capturing', tabTitle: tab.title };
      }
      renderTabs();
    });
  } catch (err) {
    console.error('Failed to start capture:', err);
    btn.disabled = false;
  }
}

document.getElementById('settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'status-update':
      captureSessions = message.sessions;
      renderTabs();
      break;
    case 'audio-state':
      audioMuted[message.tabId] = message.muted;
      renderTabs();
      break;
    case 'transcript-update':
      transcripts[message.tabId] = message.text;
      const item = tabList.querySelector(`[data-tab-id="${message.tabId}"]`);
      if (item) {
        let el = item.querySelector('.tab-transcript');
        if (!el) {
          el = document.createElement('div');
          el.className = 'tab-transcript';
          item.querySelector('.tab-info').appendChild(el);
        }
        el.textContent = message.text;
      }
      break;
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

(async () => {
  await Promise.all([checkServer(), loadStatus()]);
  renderTabs();
})();
