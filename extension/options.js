const DEFAULT_URL = 'http://127.0.0.1:8765';
const urlInput = document.getElementById('server-url');
const tokenInput = document.getElementById('local-token');
const saved = document.getElementById('saved');

async function load() {
  const config = await chrome.storage.local.get(['serverUrl', 'localToken']);
  urlInput.value = config.serverUrl || DEFAULT_URL;
  tokenInput.value = config.localToken || '';
}

document.getElementById('save').addEventListener('click', async () => {
  let serverUrl;
  try {
    serverUrl = new URL(urlInput.value).toString().replace(/\/$/, '');
    if (!['localhost', '127.0.0.1'].includes(new URL(serverUrl).hostname)) throw new Error();
  } catch {
    saved.textContent = 'Use a localhost or 127.0.0.1 URL.';
    saved.style.color = '#b91c1c';
    return;
  }
  if (tokenInput.value.trim().length < 32) {
    saved.textContent = 'Enter the token from .env.';
    saved.style.color = '#b91c1c';
    return;
  }
  await chrome.storage.local.set({ serverUrl, localToken: tokenInput.value.trim() });
  saved.textContent = 'Saved.';
  saved.style.color = '#15803d';
});

load();
