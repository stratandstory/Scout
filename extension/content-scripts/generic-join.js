(() => {
  const DISPLAY_NAME = window.__scoutDisplayName || 'Scout';
  const MAX_WAIT_MS = 30000;
  const POLL_MS = 1500;
  const start = Date.now();

  function log(msg) {
    console.log(`[Scout/generic] ${msg}`);
  }

  function findByText(selector, texts) {
    const els = document.querySelectorAll(selector);
    for (const el of els) {
      const content = el.textContent.trim().toLowerCase();
      for (const text of texts) {
        if (content === text || content.includes(text)) return el;
      }
    }
    return null;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 &&
      style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
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

  function tryFillName() {
    const suspicious = pageHasSuspiciousFields();
    if (suspicious) {
      log(`Suspicious form detected (${suspicious}) — refusing to fill name`);
      chrome.runtime.sendMessage({ type: 'guard-alert', reason: 'suspicious-form', detail: suspicious });
      return false;
    }

    const nameKeywords = ['name', 'display', 'full name', 'your name', 'first name'];
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');

    for (const input of inputs) {
      const label = (input.placeholder || '' ) + ' ' + (input.name || '') + ' ' + (input.getAttribute('aria-label') || '');
      if (nameKeywords.some(kw => label.toLowerCase().includes(kw))) {
        input.focus();
        input.value = DISPLAY_NAME;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        log(`Filled name field: ${input.name || input.placeholder || 'unnamed'}`);
        return true;
      }
    }
    return false;
  }

  function tryClickJoin() {
    const joinTexts = ['join', 'enter', 'attend', 'start', 'launch', 'join now', 'join meeting',
      'join event', 'join webinar', 'enter event', 'join session'];

    const btn = findByText('button', joinTexts) || findByText('a', joinTexts) ||
      findByText('[role="button"]', joinTexts);

    if (btn && isVisible(btn) && !btn.disabled) {
      btn.click();
      log(`Clicked: "${btn.textContent.trim().substring(0, 40)}"`);
      return true;
    }
    return false;
  }

  let filled = false;
  let clicked = false;
  let attempts = 0;

  const timer = setInterval(() => {
    attempts++;

    if (Date.now() - start > MAX_WAIT_MS) {
      log('Timed out');
      clearInterval(timer);
      chrome.runtime.sendMessage({ type: 'auto-join-result', success: clicked, phase: 'timeout' });
      return;
    }

    if (!filled) {
      filled = tryFillName();
    }

    if (!clicked) {
      clicked = tryClickJoin();
      if (clicked) {
        setTimeout(() => {
          tryClickJoin();
          log('Auto-join sequence finished');
          clearInterval(timer);
          chrome.runtime.sendMessage({ type: 'auto-join-result', success: true, phase: 'done' });
        }, 3000);
      }
    }
  }, POLL_MS);

  log('Generic auto-join started');
})();
