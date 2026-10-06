(() => {
  const DISPLAY_NAME = window.__scoutDisplayName || 'Scout';
  const MAX_WAIT_MS = 30000;
  const POLL_MS = 1000;
  const start = Date.now();

  function elapsed() { return Date.now() - start; }

  function log(msg) {
    console.log(`[Scout/zoom] ${msg}`);
  }

  function findByText(selector, text) {
    const els = document.querySelectorAll(selector);
    for (const el of els) {
      if (el.textContent.trim().toLowerCase().includes(text.toLowerCase())) return el;
    }
    return null;
  }

  function pageHasSuspiciousFields() {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      if (input.type === 'password') return 'password';
      const hint = ((input.name || '') + ' ' + (input.placeholder || '')).toLowerCase();
      if (hint.includes('email') || hint.includes('e-mail')) return 'email';
      if (hint.includes('company') || hint.includes('organization')) return 'company';
      if (hint.includes('phone')) return 'phone';
    }
    return null;
  }

  function step1_enterName() {
    const suspicious = pageHasSuspiciousFields();
    if (suspicious) {
      log(`Suspicious form detected (${suspicious}) — refusing to fill name`);
      chrome.runtime.sendMessage({ type: 'guard-alert', reason: 'suspicious-form', detail: suspicious });
      return false;
    }

    const nameInput = document.querySelector('#inputname, input[name="inputname"], input[placeholder*="name" i]');
    if (!nameInput) return false;

    nameInput.focus();
    nameInput.value = DISPLAY_NAME;
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    log(`Entered name: ${DISPLAY_NAME}`);
    return true;
  }

  function step2_clickJoin() {
    const joinBtn =
      document.querySelector('#joinBtn, .join-btn, button.btn-join') ||
      findByText('button', 'join') ||
      findByText('a', 'join');

    if (!joinBtn) return false;
    if (joinBtn.disabled) return false;

    joinBtn.click();
    log('Clicked Join');
    return true;
  }

  function step3_joinAudio() {
    const audioBtn =
      findByText('button', 'join audio by computer') ||
      findByText('button', 'join audio') ||
      findByText('button', 'computer audio');

    if (!audioBtn) return false;

    audioBtn.click();
    log('Clicked Join Audio by Computer');
    return true;
  }

  let phase = 'name';
  let audioAttempts = 0;

  const timer = setInterval(() => {
    if (elapsed() > MAX_WAIT_MS) {
      log('Timed out — sending partial result');
      clearInterval(timer);
      chrome.runtime.sendMessage({ type: 'auto-join-result', success: phase !== 'name', phase });
      return;
    }

    switch (phase) {
      case 'name':
        if (step1_enterName()) {
          setTimeout(() => { phase = 'join'; }, 500);
        }
        break;

      case 'join':
        if (step2_clickJoin()) {
          phase = 'audio';
        }
        break;

      case 'audio':
        audioAttempts++;
        if (step3_joinAudio()) {
          log('Auto-join complete');
          clearInterval(timer);
          chrome.runtime.sendMessage({ type: 'auto-join-result', success: true, phase: 'done' });
        } else if (audioAttempts > 15) {
          log('Audio button not found — join may have succeeded without it');
          clearInterval(timer);
          chrome.runtime.sendMessage({ type: 'auto-join-result', success: true, phase: 'audio-skipped' });
        }
        break;
    }
  }, POLL_MS);

  log('Zoom auto-join started');
})();
