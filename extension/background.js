const DEFAULT_SERVER_BASE = 'http://127.0.0.1:8765';
const SCHEDULE_POLL_ALARM = 'scout-schedule-poll';
const RECOVERY_ALARM = 'scout-recovery-check';

const sessions = new Map();
const managedTabs = new Map();
const notificationUrls = new Map();
let offscreenReady = false;

async function getServerConfig() {
  const config = await chrome.storage.local.get(['serverUrl', 'localToken']);
  return { serverUrl: config.serverUrl || DEFAULT_SERVER_BASE, localToken: config.localToken || '' };
}

async function ensureOffscreenDocument() {
  if (offscreenReady) return;

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (contexts.length > 0) {
    offscreenReady = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture tab audio and video for transcription and playback'
  });
  offscreenReady = true;
}

function broadcastStatus() {
  const status = {};
  for (const [tabId, session] of sessions) {
    status[tabId] = session;
  }
  chrome.runtime.sendMessage({ type: 'status-update', sessions: status }).catch(() => {});
}

// --- Startup recovery ---

chrome.runtime.onStartup.addListener(() => {
  console.log('[Scout] Service worker started — running recovery check');
  recoverOrphanedSessions();
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Scout] Extension installed/updated — running recovery check');
  recoverOrphanedSessions();
});

async function recoverOrphanedSessions() {
  const stored = await chrome.storage.local.get('activeSessions');
  const savedSessions = stored.activeSessions || {};
  const savedTabIds = Object.keys(savedSessions).map(Number);

  if (savedTabIds.length === 0) return;

  console.log(`[Scout] Found ${savedTabIds.length} saved session(s) to recover`);

  for (const tabId of savedTabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) {
        console.log(`[Scout] Tab ${tabId} still exists ("${tab.title}") — session can be restarted from popup`);
      }
    } catch {
      console.log(`[Scout] Tab ${tabId} gone — cleaning up orphaned session`);
      sessions.delete(tabId);
      managedTabs.delete(tabId);
    }
  }

  await chrome.storage.local.remove('activeSessions');
  broadcastStatus();
}

async function persistSessions() {
  const data = {};
  for (const [tabId, session] of sessions) {
    data[tabId] = { tabTitle: session.tabTitle, status: session.status };
  }
  await chrome.storage.local.set({ activeSessions: data });
}

// --- Schedule polling ---

chrome.alarms.create(SCHEDULE_POLL_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SCHEDULE_POLL_ALARM) {
    checkSchedule();
    checkAutoLeave();
  }
  if (alarm.name === RECOVERY_ALARM) {
    checkTabHealth();
  }
});

async function ackEvent(eventId) {
  try {
    const config = await getServerConfig();
    if (!config.localToken) return;
    await fetch(`${config.serverUrl}/events/ack/${encodeURIComponent(eventId)}`, {
      method: 'POST',
      headers: { 'X-Scout-Token': config.localToken }
    });
    console.log(`[Scout] Acked event: ${eventId}`);
  } catch (err) {
    console.error(`[Scout] Failed to ack event ${eventId}:`, err.message);
  }
}

async function checkSchedule() {
  try {
    const config = await getServerConfig();
    if (!config.localToken) return;
    const res = await fetch(`${config.serverUrl}/schedule`, { headers: { 'X-Scout-Token': config.localToken } });
    if (!res.ok) return;

    const data = await res.json();
    if (!data.readyToOpen || data.readyToOpen.length === 0) return;

    console.log(`[Scout] Schedule poll: ${data.readyToOpen.length} event(s) ready`, data.readyToOpen.map(e => e.summary));
    for (const event of data.readyToOpen) {
      const alreadyManaged = [...managedTabs.values()].some(info => info.eventId === event.id);
      if (alreadyManaged) continue;

      if (event.mode === 'auto') {
        autoJoinEvent(event, data.displayName);
      } else {
        notifyEvent(event);
      }
    }
  } catch {
    // Server not running — silent
  }
}

// --- Notify mode (default): Chrome notification with link ---

function notifyEvent(event) {
  const notifId = `scout-${event.id}`;
  const startTime = new Date(event.start).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `Scout — ${event.summary}`,
    message: `Starts at ${startTime}. Click to open.`,
    priority: 2,
    requireInteraction: true
  }, (createdId) => {
    if (chrome.runtime.lastError) {
      console.error(`[Scout] Notification FAILED for "${event.summary}":`, chrome.runtime.lastError.message);
    } else {
      console.log(`[Scout] Notification created (${createdId}) for: "${event.summary}"`);
    }
  });

  notificationUrls.set(notifId, { url: event.meetingUrl, eventId: event.id });
}

chrome.notifications.onClicked.addListener((notifId) => {
  const info = notificationUrls.get(notifId);
  if (info) {
    chrome.tabs.create({ url: info.url, active: true });
    ackEvent(info.eventId);
    notificationUrls.delete(notifId);
    chrome.notifications.clear(notifId);
  }
});

// --- Auto mode: open tab, inject join script, start capture ---

async function autoJoinEvent(event, displayName) {
  let meetingUrl = event.meetingUrl;
  if (event.platform === 'zoom' && meetingUrl.includes('/j/')) {
    meetingUrl = meetingUrl.replace('/j/', '/wc/join/');
  }

  for (const [existingTabId, info] of managedTabs) {
    try {
      const existingTab = await chrome.tabs.get(existingTabId);
      if (existingTab.url && new URL(existingTab.url).origin === new URL(meetingUrl).origin) {
        console.log(`[Scout] Reusing existing tab ${existingTabId} for "${event.summary}" (same origin as "${info.summary}")`);
        info.eventId = event.id;
        info.summary = event.summary;
        info.endTime = new Date(event.end).getTime() + 3 * 60 * 1000;
        ackEvent(event.id);
        if (sessions.has(existingTabId)) {
          console.log(`[Scout] Capture already running — extending session through "${event.summary}"`);
          return;
        }
        setTimeout(() => startAutoCapture(existingTabId), 3000);
        return;
      }
    } catch {
      managedTabs.delete(existingTabId);
    }
  }

  console.log(`[Scout] Auto-joining: "${event.summary}" — ${meetingUrl}`);

  const tab = await chrome.tabs.create({ url: meetingUrl, active: false });

  managedTabs.set(tab.id, {
    eventId: event.id,
    summary: event.summary,
    platform: event.platform,
    endTime: new Date(event.end).getTime() + 3 * 60 * 1000,
    displayName,
    captureStarted: false
  });

  ackEvent(event.id);

  chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
    if (tabId !== tab.id || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(listener);
    setTimeout(() => injectAutoJoin(tab.id, event.platform, displayName), 2000);
  });
}

async function injectAutoJoin(tabId, platform, displayName) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (name) => { window.__scoutDisplayName = name; },
      args: [displayName]
    });

    const scriptFile = platform === 'zoom'
      ? 'content-scripts/zoom-join.js'
      : 'content-scripts/generic-join.js';

    await chrome.scripting.executeScript({
      target: { tabId },
      files: [scriptFile]
    });

    console.log(`[Scout] Injected ${scriptFile} into tab ${tabId}`);
  } catch (err) {
    console.error(`[Scout] Script injection failed for tab ${tabId}:`, err.message);
    injectIdentityGuard(tabId, 'exit');
  }
}

async function injectIdentityGuard(tabId, mode) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (m) => { window.__scoutGuardMode = m; },
      args: [mode]
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/identity-guard.js']
    });

    console.log(`[Scout] Identity guard injected (${mode}) into tab ${tabId}`);
  } catch (err) {
    console.error(`[Scout] Identity guard injection failed for tab ${tabId}:`, err.message);
    if (mode === 'exit') {
      chrome.tabs.remove(tabId).catch(() => {});
      sessions.delete(tabId);
      managedTabs.delete(tabId);
      broadcastStatus();
      persistSessions();
    }
  }
}

async function startAutoCapture(tabId) {
  const info = managedTabs.get(tabId);
  if (!info || info.captureStarted) return;
  if (sessions.has(tabId)) return;

  info.captureStarted = true;

  try {
    const config = await getServerConfig();
    if (!config.localToken) throw new Error('Scout local token is not configured');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

    await ensureOffscreenDocument();
    sessions.set(tabId, { status: 'capturing', tabTitle: info.summary, frameCount: 0 });
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start-capture',
      streamId,
      tabId,
      tabTitle: info.summary,
      serverUrl: config.serverUrl,
      localToken: config.localToken
    });
    broadcastStatus();
    console.log(`[Scout] Auto-capture started for "${info.summary}"`);
  } catch (err) {
    console.error(`[Scout] Auto-capture failed for tab ${tabId}:`, err.message);
    info.captureStarted = false;
  }
}

// --- Auto-leave: stop capture + close tab at event end time ---

function checkAutoLeave() {
  const now = Date.now();
  for (const [tabId, info] of managedTabs) {
    if (now >= info.endTime + 3 * 60 * 1000) {
      console.log(`[Scout] Event ended: "${info.summary}" — stopping capture and closing tab`);

      if (sessions.has(tabId)) {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'stop-capture',
          tabId
        });
        sessions.delete(tabId);
      }

      chrome.tabs.remove(tabId).catch(() => {});
      managedTabs.delete(tabId);
      broadcastStatus();
    }
  }
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'offscreen') return;

  switch (message.type) {
    case 'start-capture': {
      const { streamId, tabId, tabTitle } = message;
      ensureOffscreenDocument()
        .then(async () => {
          const config = await getServerConfig();
          if (!config.localToken) throw new Error('Scout local token is not configured');
          sessions.set(tabId, { status: 'capturing', tabTitle, frameCount: 0 });
          chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'start-capture',
            streamId,
            tabId,
            tabTitle,
            serverUrl: config.serverUrl,
            localToken: config.localToken
          });
          broadcastStatus();
          persistSessions();
          sendResponse({ success: true });
        })
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'stop-capture': {
      const { tabId } = message;
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'stop-capture',
        tabId
      });
      sessions.delete(tabId);
      managedTabs.delete(tabId);
      broadcastStatus();
      persistSessions();
      sendResponse({ success: true });
      return false;
    }

    case 'get-status': {
      const status = {};
      for (const [tabId, session] of sessions) {
        status[tabId] = session;
      }
      sendResponse({ sessions: status });
      return false;
    }

    case 'capture-status': {
      const session = sessions.get(message.tabId);
      if (session) {
        session.status = message.status;
        broadcastStatus();
      }
      break;
    }

    case 'transcript': {
      chrome.runtime.sendMessage({
        type: 'transcript-update',
        tabId: message.tabId,
        text: message.text,
        isFinal: message.isFinal
      }).catch(() => {});
      break;
    }

    case 'frame-captured': {
      const session = sessions.get(message.tabId);
      if (session) {
        session.frameCount = message.frameIndex;
        broadcastStatus();
      }
      break;
    }

    case 'auto-join-result': {
      const tabId = sender.tab?.id;
      if (!tabId) break;

      console.log(`[Scout] Auto-join result for tab ${tabId}: success=${message.success}, phase=${message.phase}`);

      if (message.success) {
        console.log(`[Scout] Join button clicked — starting capture in 3s`);
        setTimeout(() => startAutoCapture(tabId), 3000);
      } else {
        console.log(`[Scout] No join button found — assuming already in session, starting capture in 3s`);
        setTimeout(() => startAutoCapture(tabId), 3000);
      }
      injectIdentityGuard(tabId, 'monitor');
      break;
    }

    case 'guard-trigger': {
      const tabId = sender.tab?.id;
      if (!tabId) break;

      console.log(`[Scout] Identity guard tier ${message.tier}: ${message.reason || 'escalation'} (tab ${tabId})`);

      chrome.tabs.remove(tabId).catch(() => {
        console.log(`[Scout] Tab ${tabId} could not be closed — guard will escalate`);
      });
      sessions.delete(tabId);
      managedTabs.delete(tabId);
      broadcastStatus();
      persistSessions();
      break;
    }

    case 'guard-alert': {
      const tabId = sender.tab?.id;
      console.warn(`[Scout] Guard alert (tab ${tabId}): ${message.reason} — ${message.detail || ''}`);
      break;
    }

    case 'capture-error': {
      console.error(`Capture error for tab ${message.tabId}:`, message.error);
      sessions.delete(message.tabId);
      broadcastStatus();
      persistSessions();
      break;
    }
  }
});

// --- Tab health checks ---

async function checkTabHealth() {
  for (const [tabId] of sessions) {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      console.log(`[Scout] Tab ${tabId} crashed or closed — cleaning up session`);
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'stop-capture',
        tabId
      }).catch(() => {});
      sessions.delete(tabId);
      managedTabs.delete(tabId);
      broadcastStatus();
      persistSessions();
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessions.has(tabId)) {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'stop-capture',
      tabId
    });
    sessions.delete(tabId);
    broadcastStatus();
    persistSessions();
  }
  managedTabs.delete(tabId);
});
