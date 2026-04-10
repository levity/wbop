const statusDot = document.getElementById('statusDot') as HTMLSpanElement;
const statusText = document.getElementById('status') as HTMLDivElement;
const urlInput = document.getElementById('url') as HTMLInputElement;
const button = document.getElementById('button') as HTMLButtonElement;
const errorDiv = document.getElementById('error') as HTMLDivElement;
const stayConnectedInput = document.getElementById('stayConnected') as HTMLInputElement;

interface PopupStatus {
  connected: boolean;
  stayConnected: boolean;
  url: string;
  reconnecting: boolean;
  reconnectAttempts: number;
  reconnectElapsedMs: number;
  lastError?: string;
}

async function sendToBackground(type: string, data?: any): Promise<any> {
  return browser.runtime.sendMessage({ type, ...data });
}

function formatReconnectStatus(elapsedMs: number, attempts: number) {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes >= 1) {
    return `Couldn't connect for ${minutes} minute${minutes === 1 ? '' : 's'} (${attempts} attempt${attempts === 1 ? '' : 's'})`;
  }
  const seconds = Math.floor(elapsedMs / 1000);
  return `Couldn't connect for ${seconds}s (${attempts} attempt${attempts === 1 ? '' : 's'})`;
}

function statusLabel(status: PopupStatus) {
  if (status.connected) {
    return 'Connected';
  }

  if (status.reconnecting) {
    if (status.reconnectElapsedMs >= 15_000) {
      return formatReconnectStatus(status.reconnectElapsedMs, status.reconnectAttempts);
    }
    return `Reconnecting… (${status.reconnectAttempts} attempt${status.reconnectAttempts === 1 ? '' : 's'})`;
  }

  return 'Not connected';
}

async function init() {
  try {
    const status = await sendToBackground('status');
    updateUI(status);
  } catch (e) {
    console.error('[Sidekick popup] Failed to get status:', e);
    updateUI({
      connected: false,
      stayConnected: false,
      url: urlInput.value,
      reconnecting: false,
      reconnectAttempts: 0,
      reconnectElapsedMs: 0,
      lastError: String(e),
    });
  }
}

function updateUI(status: PopupStatus, errorMsg?: string) {
  statusDot.classList.toggle('connected', status.connected);
  statusDot.classList.toggle('reconnecting', !status.connected && status.reconnecting);
  statusText.textContent = statusLabel(status);
  urlInput.value = status.url || urlInput.value;
  stayConnectedInput.checked = status.stayConnected;
  button.textContent = status.connected ? 'Disconnect' : 'Connect';
  button.className = status.connected ? 'disconnect' : 'connect';
  errorDiv.textContent = errorMsg || status.lastError || '';
}

button.addEventListener('click', async () => {
  button.disabled = true;
  errorDiv.textContent = '';

  try {
    const status = await sendToBackground('status');

    if (status.connected) {
      await sendToBackground('disconnect');
      updateUI({
        ...status,
        connected: false,
        stayConnected: false,
        reconnecting: false,
        reconnectAttempts: 0,
        reconnectElapsedMs: 0,
        lastError: undefined,
      });
    } else {
      const url = urlInput.value.trim();
      const result = await sendToBackground('connect', { url });
      if (result?.success) {
        const nextStatus = await sendToBackground('status');
        updateUI(nextStatus);
      } else {
        const nextStatus = await sendToBackground('status');
        updateUI(nextStatus, result?.error || 'Connection failed');
      }
    }
  } catch (e) {
    console.error('[Sidekick popup] Error:', e);
    const nextStatus = await sendToBackground('status').catch(() => ({
      connected: false,
      stayConnected: stayConnectedInput.checked,
      url: urlInput.value,
      reconnecting: false,
      reconnectAttempts: 0,
      reconnectElapsedMs: 0,
    }));
    updateUI(nextStatus, String(e));
  }

  button.disabled = false;
});

stayConnectedInput.addEventListener('change', async () => {
  stayConnectedInput.disabled = true;
  try {
    const status = await sendToBackground('setStayConnected', { enabled: stayConnectedInput.checked });
    updateUI(status);
  } catch (e) {
    console.error('[Sidekick popup] Failed to update stayConnected:', e);
    errorDiv.textContent = String(e);
  }
  stayConnectedInput.disabled = false;
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'statusChanged' && message.status) {
    updateUI(message.status);
  }
});

init();
