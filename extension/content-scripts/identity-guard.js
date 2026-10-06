(() => {
  const MODE = window.__scoutGuardMode || 'monitor';
  const DISPLAY_NAME = window.__scoutDisplayName || 'Scout';

  const MONITOR_DELAY_MS = 10000;
  const MONITOR_DURATION_MS = 60000;
  const POLL_MS = 3000;

  const STATE = { MONITORING: 0, TIER1: 1, TIER2: 2, TIER3: 3, DONE: 4 };
  let state = STATE.MONITORING;
  let guardTimer = null;

  function log(msg) {
    console.log(`[Scout/guard] ${msg}`);
  }

  // --- Detection ---

  function detectWaitingRoom() {
    const text = (document.body?.innerText || '').toLowerCase();
    const phrases = [
      'waiting for the host', 'please wait', 'the meeting has not started',
      'waiting room', 'the host will let you in', "meeting hasn't started",
      'webinar will begin', 'event will begin', 'waiting for the meeting',
      'host has not arrived', 'you will be let in'
    ];
    return phrases.some(p => text.includes(p));
  }

  function detectCaptcha() {
    return !!(
      document.querySelector('iframe[src*="recaptcha"]') ||
      document.querySelector('iframe[src*="hcaptcha"]') ||
      document.querySelector('.g-recaptcha, .h-captcha') ||
      document.querySelector('#cf-challenge-running')
    );
  }

  function detectLoginWall() {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      if (input.type === 'password') return true;
      const hint = ((input.name || '') + ' ' + (input.placeholder || '') + ' ' +
        (input.getAttribute('aria-label') || '')).toLowerCase();
      if (hint.includes('email') || hint.includes('e-mail')) return true;
    }
    return false;
  }

  function detectUnexpectedForm() {
    const keywords = ['company', 'organization', 'phone', 'role', 'title', 'department', 'reason for joining'];
    const inputs = document.querySelectorAll('input[type="text"], input:not([type]), textarea, select');
    for (const input of inputs) {
      const hint = ((input.name || '') + ' ' + (input.placeholder || '') + ' ' +
        (input.getAttribute('aria-label') || '')).toLowerCase();
      if (keywords.some(kw => hint.includes(kw))) return true;
    }
    return false;
  }

  function detectThreat() {
    if (detectCaptcha()) return 'captcha';
    if (detectLoginWall()) return 'login-wall';
    if (detectWaitingRoom()) return 'waiting-room';
    if (detectUnexpectedForm()) return 'unexpected-form';
    return null;
  }

  // --- Chat interaction ---

  function findChatInput() {
    const selectors = [
      'textarea[placeholder*="chat" i]', 'textarea[placeholder*="message" i]',
      'textarea[aria-label*="chat" i]', 'textarea[aria-label*="message" i]',
      'input[placeholder*="chat" i]', 'input[placeholder*="message" i]',
      '[contenteditable][aria-label*="chat" i]', '[contenteditable][aria-label*="message" i]',
      '.chat-box textarea', '.chat-box input',
      '.chat-input textarea', '.chat-input input'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function postInChat(message) {
    const input = findChatInput();
    if (!input) {
      log('No chat input found — message not posted');
      return false;
    }

    input.focus();

    if (input.contentEditable === 'true') {
      input.textContent = message;
    } else {
      input.value = message;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    setTimeout(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
      }));

      const sendBtn = document.querySelector(
        'button[aria-label*="send" i], button[title*="send" i], .chat-send-btn, button.send-btn'
      );
      if (sendBtn) sendBtn.click();
    }, 200);

    log(`Posted in chat: "${message.substring(0, 50)}..."`);
    return true;
  }

  // --- Escalation ---

  function triggerTier1(reason) {
    if (state >= STATE.TIER1) return;
    state = STATE.TIER1;
    log(`Tier 1 — silent exit (${reason})`);

    chrome.runtime.sendMessage({ type: 'guard-trigger', tier: 1, reason }).catch(() => {});

    // Never post to a meeting chat. Closing the tab is the only safe response.
  }

  function triggerTier2() {
    if (state >= STATE.TIER2) return;
    state = STATE.TIER2;
    log('Tier 2 — polite apology');

    const message = "Apologies — I joined this session by mistake. " +
      "I can't figure out how to leave. Please feel free to remove me.";
    chrome.runtime.sendMessage({ type: 'guard-trigger', tier: 2 }).catch(() => {});
    state = STATE.DONE;
    stopGuard();
  }

  function triggerTier3() {
    if (state >= STATE.TIER3) return;
    state = STATE.TIER3;
    log('Tier 3 — bot disclosure');

    const message = "I'm a bot — I'm sorry about this. " +
      "Please remove me from the session. Apologies for the disruption.";
    chrome.runtime.sendMessage({ type: 'guard-trigger', tier: 3 }).catch(() => {});
    state = STATE.DONE;
    stopGuard();
  }

  // --- Main loop ---

  function guardCheck() {
    if (state === STATE.DONE) {
      stopGuard();
      return;
    }

    const threat = detectThreat();

    if (threat && state === STATE.MONITORING) {
      triggerTier1(threat);
    }
  }

  function startGuard() {
    if (MODE === 'exit') {
      log('Exit mode — starting Tier 1 immediately');
      triggerTier1('join-failed');
      return;
    }

    log(`Monitor mode — polling starts in ${MONITOR_DELAY_MS / 1000}s`);
    setTimeout(() => {
      guardTimer = setInterval(guardCheck, POLL_MS);

      setTimeout(() => {
        if (state === STATE.MONITORING) {
          log('Monitor period ended — no threats detected');
          stopGuard();
        }
      }, MONITOR_DURATION_MS);
    }, MONITOR_DELAY_MS);
  }

  function stopGuard() {
    if (guardTimer) {
      clearInterval(guardTimer);
      guardTimer = null;
    }
  }

  startGuard();
  log(`Identity guard active (mode=${MODE}, name="${DISPLAY_NAME}")`);
})();
