const statusDot = document.getElementById('statusDot') as HTMLSpanElement;
const statusText = document.getElementById('status') as HTMLDivElement;
const urlInput = document.getElementById('url') as HTMLInputElement;
const button = document.getElementById('button') as HTMLButtonElement;
const errorDiv = document.getElementById('error') as HTMLDivElement;

async function sendToBackground(type: string, data?: any): Promise<any> {
  return browser.runtime.sendMessage({ type, ...data });
}

async function init() {
  try {
    const { connected } = await sendToBackground('status');
    console.log('[Sidekick popup] Initial connected state:', connected);
    updateUI(connected);
  } catch (e) {
    console.error('[Sidekick popup] Failed to get status:', e);
    updateUI(false);
  }
}

function updateUI(connected: boolean, errorMsg?: string) {
  statusDot.classList.toggle('connected', connected);
  statusText.textContent = connected ? 'Connected' : 'Not connected';
  button.textContent = connected ? 'Disconnect' : 'Connect';
  button.className = connected ? 'disconnect' : 'connect';
  errorDiv.textContent = errorMsg || '';
}

button.addEventListener('click', async () => {
  console.log('[Sidekick popup] Button clicked');
  button.disabled = true;
  errorDiv.textContent = '';

  try {
    const { connected } = await sendToBackground('status');
    console.log('[Sidekick popup] Current connected state:', connected);

    if (connected) {
      console.log('[Sidekick popup] Disconnecting...');
      await sendToBackground('disconnect');
      updateUI(false);
    } else {
      const url = urlInput.value;
      console.log('[Sidekick popup] Connecting to:', url);
      const result = await sendToBackground('connect', { url });
      console.log('[Sidekick popup] Connect result:', result);
      if (result?.success) {
        updateUI(true);
      } else {
        updateUI(false, result?.error || 'Connection failed');
      }
    }
  } catch (e) {
    console.error('[Sidekick popup] Error:', e);
    updateUI(false, String(e));
  }

  button.disabled = false;
});

init();
