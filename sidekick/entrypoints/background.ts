import type {
  Request,
  Response,
  EvalRequest,
  ScreenshotRequest,
  RelayMessage,
  RelayResponse,
} from '../utils/protocol';

const DEFAULT_URL = 'ws://localhost:8765';
const STORAGE_KEYS = {
  relayUrl: 'relayUrl',
  stayConnected: 'stayConnected',
} as const;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_STATUS_THRESHOLD_MS = 15_000;
const RECONNECT_NOTIFY_THRESHOLD_MS = 5 * 60_000;
const NOTIFICATION_ICON_URL = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="%23f44336"/><circle cx="32" cy="20" r="4" fill="white"/><rect x="28" y="28" width="8" height="20" rx="4" fill="white"/></svg>';

type ConnectResult = { success: boolean; error?: string };
type ConnectionStatus = {
  connected: boolean;
  stayConnected: boolean;
  url: string;
  reconnecting: boolean;
  reconnectAttempts: number;
  reconnectElapsedMs: number;
  lastError?: string;
};

export default defineBackground(() => {
  let ws: WebSocket | null = null;
  let connected = false;
  let messageCount = 0;
  let relayUrl = DEFAULT_URL;
  let stayConnected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let reconnectStartedAt: number | null = null;
  let reconnectNotified = false;
  let intentionalDisconnect = false;
  let activeConnectPromise: Promise<ConnectResult> | null = null;
  let activeConnectUrl: string | null = null;
  let statusBroadcastInterval: ReturnType<typeof setInterval> | null = null;
  let lastError: string | undefined;

  void init();

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { type, url, enabled } = message;

    if (type === 'connect') {
      void (async () => {
        if (typeof url === 'string' && url) {
          relayUrl = url;
          await persistSettings();
        }
        const result = await connect(relayUrl, { manual: true });
        sendResponse(result);
      })();
      return true;
    }

    if (type === 'disconnect') {
      void (async () => {
        await disconnect({ manual: true });
        sendResponse({ success: true });
      })();
      return true;
    }

    if (type === 'status') {
      sendResponse(buildStatus());
      return false;
    }

    if (type === 'setStayConnected') {
      void (async () => {
        stayConnected = Boolean(enabled);
        await persistSettings();

        if (stayConnected) {
          if (!connected && !isConnecting()) {
            await connect(relayUrl, { manual: false });
          }
          ensureStatusBroadcast();
        } else {
          clearReconnectTimer();
          clearStatusBroadcast();
          reconnectAttempts = 0;
          reconnectStartedAt = null;
          reconnectNotified = false;
          updateBadge();
          broadcastStatus();
        }

        sendResponse({ success: true, ...buildStatus() });
      })();
      return true;
    }

    return false;
  });

  async function init() {
    const stored = await browser.storage.local.get({
      [STORAGE_KEYS.relayUrl]: DEFAULT_URL,
      [STORAGE_KEYS.stayConnected]: false,
    });

    const storedRelayUrl = stored[STORAGE_KEYS.relayUrl];
    relayUrl = typeof storedRelayUrl === 'string' ? storedRelayUrl : DEFAULT_URL;
    stayConnected = Boolean(stored[STORAGE_KEYS.stayConnected]);

    updateBadge();
    if (stayConnected) {
      await connect(relayUrl, { manual: false });
    }
  }

  function isConnecting() {
    return Boolean(activeConnectPromise);
  }

  async function persistSettings() {
    await browser.storage.local.set({
      [STORAGE_KEYS.relayUrl]: relayUrl,
      [STORAGE_KEYS.stayConnected]: stayConnected,
    });
  }

  function buildStatus(): ConnectionStatus {
    return {
      connected,
      stayConnected,
      url: relayUrl,
      reconnecting: !connected && (isConnecting() || Boolean(reconnectStartedAt) || Boolean(reconnectTimer)),
      reconnectAttempts,
      reconnectElapsedMs: reconnectStartedAt ? Date.now() - reconnectStartedAt : 0,
      lastError,
    };
  }

  async function connect(url: string, options: { manual: boolean }): Promise<ConnectResult> {
    relayUrl = url;
    await persistSettings();

    if (ws?.readyState === WebSocket.OPEN) {
      connected = true;
      lastError = undefined;
      updateBadge();
      broadcastStatus();
      return { success: true };
    }

    if (activeConnectPromise && activeConnectUrl === url) {
      return activeConnectPromise;
    }

    intentionalDisconnect = false;
    activeConnectUrl = url;
    activeConnectPromise = new Promise((resolve) => {
      let settled = false;

      const finish = (result: ConnectResult) => {
        if (settled) return;
        settled = true;
        activeConnectPromise = null;
        activeConnectUrl = null;
        resolve(result);
      };

      try {
        const socket = new WebSocket(url);
        ws = socket;
        updateBadge();
        broadcastStatus();

        socket.onopen = () => {
          connected = true;
          ws = socket;
          lastError = undefined;
          reconnectAttempts = 0;
          reconnectStartedAt = null;
          reconnectNotified = false;
          clearReconnectTimer();
          ensureStatusBroadcast();
          updateBadge();
          broadcastStatus();
          finish({ success: true });
        };

        socket.onclose = (event) => {
          if (ws === socket) {
            ws = null;
          }
          connected = false;

          if (!intentionalDisconnect) {
            const detail = event.reason || `close ${event.code}`;
            lastError = `Disconnected (${detail})`;
            scheduleReconnect('close');
          }

          updateBadge();
          broadcastStatus();
          finish(options.manual ? { success: false, error: lastError || 'Connection closed' } : { success: true });
        };

        socket.onerror = () => {
          connected = false;
          lastError = 'Connection failed';
          updateBadge();
          broadcastStatus();
          finish({ success: false, error: lastError });
        };

        socket.onmessage = (event) => {
          messageCount++;
          void handleMessage(event.data);
        };
      } catch (error) {
        connected = false;
        lastError = String(error);
        updateBadge();
        broadcastStatus();
        finish({ success: false, error: lastError });
      }
    });

    const result = await activeConnectPromise;

    if (!result.success && (stayConnected || !options.manual)) {
      scheduleReconnect('connect-failed');
    }

    if (options.manual && !result.success) {
      return result;
    }

    return result;
  }

  function scheduleReconnect(reason: string) {
    if (!stayConnected || intentionalDisconnect) {
      return;
    }

    if (connected || isConnecting()) {
      return;
    }

    if (!reconnectStartedAt) {
      reconnectStartedAt = Date.now();
      reconnectAttempts = 0;
      reconnectNotified = false;
    }

    if (reconnectTimer) {
      return;
    }

    reconnectAttempts += 1;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_DELAY_MS);
    lastError = `${reason}; retrying in ${Math.round(delay / 1000)}s`;
    ensureStatusBroadcast();
    updateBadge();
    broadcastStatus();

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect(relayUrl, { manual: false });
      maybeNotifyReconnectTrouble();
    }, delay);
  }

  function maybeNotifyReconnectTrouble() {
    if (!stayConnected || reconnectNotified || !reconnectStartedAt) {
      return;
    }

    const elapsed = Date.now() - reconnectStartedAt;
    if (elapsed < RECONNECT_NOTIFY_THRESHOLD_MS) {
      return;
    }

    reconnectNotified = true;
    if (!('notifications' in browser)) {
      return;
    }

    const minutes = Math.floor(elapsed / 60_000);
    const message = `Couldn't connect for ${minutes} minute${minutes === 1 ? '' : 's'} (${reconnectAttempts} attempts)`;
    void browser.notifications.create('sidekick-reconnect-trouble', {
      type: 'basic',
      iconUrl: NOTIFICATION_ICON_URL,
      title: 'Sidekick connection issue',
      message,
    }).catch(() => {});
  }

  async function handleMessage(raw: string) {
    try {
      const msg: RelayMessage = JSON.parse(raw);
      const response = await handleRequest(msg.request);
      const relayResponse: RelayResponse = { id: msg.id, response };
      const payload = JSON.stringify(relayResponse);

      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    } catch (error) {
      lastError = String(error);
      broadcastStatus();
    }
  }

  async function disconnect(options: { manual: boolean }) {
    intentionalDisconnect = options.manual;
    stayConnected = options.manual ? false : stayConnected;
    await persistSettings();
    clearReconnectTimer();
    clearStatusBroadcast();
    reconnectAttempts = 0;
    reconnectStartedAt = null;
    reconnectNotified = false;
    lastError = undefined;

    if (ws) {
      const socket = ws;
      ws = null;
      socket.close();
    }

    connected = false;
    updateBadge();
    broadcastStatus();
  }

  async function handleRequest(request: Request): Promise<Response> {
    switch (request.type) {
      case 'eval':
        return handleEval(request);
      case 'tabs':
        return handleTabs();
      case 'screenshot':
        return handleScreenshot(request);
      default:
        return { type: 'eval', success: false, error: `Unknown request type: ${(request as any).type}` };
    }
  }

  async function handleEval(request: EvalRequest): Promise<Response> {
    const tabId = request.tabId ?? (await getActiveTabId());

    if (!tabId) {
      return { type: 'eval', success: false, error: 'No active tab' };
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (code: string) => {
          function serialize(value: any): any {
            if (value === undefined) return { __undefined: true };
            if (value === null) return null;
            if (typeof value === 'function') return { __function: true };
            if (typeof value === 'symbol') return { __symbol: value.toString() };
            if (value instanceof Element) {
              return { __element: true, tag: value.tagName.toLowerCase(), text: value.textContent?.slice(0, 200) };
            }
            if (value instanceof Error) {
              return { __error: true, message: value.message, name: value.name };
            }
            try {
              JSON.stringify(value);
              return value;
            } catch {
              return { __unserializable: true, toString: String(value) };
            }
          }
          try {
            const result = (0, eval)(code);
            return serialize(result);
          } catch (e: any) {
            return { __error: true, message: e.message, name: e.name };
          }
        },
        args: [request.code],
        world: 'MAIN',
      });

      const value = results?.[0]?.result;
      if (value?.__error) {
        return { type: 'eval', success: false, error: `${value.name}: ${value.message}` };
      }

      return { type: 'eval', success: true, result: value };
    } catch (error: any) {
      return {
        type: 'eval',
        success: false,
        error: `executeScript failed: ${error.message}`,
      };
    }
  }

  async function handleTabs(): Promise<Response> {
    try {
      const tabs = await browser.tabs.query({});
      return {
        type: 'tabs',
        success: true,
        tabs: tabs.map((t) => ({
          id: t.id!,
          title: t.title || '',
          url: t.url || '',
        })),
      };
    } catch (error) {
      return { type: 'tabs', success: false, error: String(error) };
    }
  }

  async function handleScreenshot(request: ScreenshotRequest): Promise<Response> {
    const tabId = request.tabId ?? (await getActiveTabId());

    if (!tabId) {
      return { type: 'screenshot', success: false, error: 'No active tab' };
    }

    try {
      const win = await browser.windows.getCurrent();
      if (!win.id) {
        return { type: 'screenshot', success: false, error: 'No window ID' };
      }
      const dataUrl = await browser.tabs.captureVisibleTab(win.id, { format: 'png' });
      const base64 = dataUrl.split(',')[1];
      return { type: 'screenshot', success: true, image: base64 };
    } catch (error) {
      return { type: 'screenshot', success: false, error: String(error) };
    }
  }

  async function getActiveTabId(): Promise<number | undefined> {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id;
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function ensureStatusBroadcast() {
    if (statusBroadcastInterval) {
      return;
    }
    statusBroadcastInterval = setInterval(() => {
      if (connected || !reconnectStartedAt) {
        return;
      }
      maybeNotifyReconnectTrouble();
      updateBadge();
      broadcastStatus();
    }, 1000);
  }

  function clearStatusBroadcast() {
    if (statusBroadcastInterval) {
      clearInterval(statusBroadcastInterval);
      statusBroadcastInterval = null;
    }
  }

  function broadcastStatus() {
    void browser.runtime.sendMessage({ type: 'statusChanged', status: buildStatus() }).catch(() => {});
  }

  function updateBadge() {
    const status = buildStatus();
    const showTrouble = !status.connected && status.reconnectElapsedMs >= RECONNECT_STATUS_THRESHOLD_MS;
    const badgeText = status.connected ? '●' : showTrouble ? '!' : stayConnected ? '…' : '○';
    const badgeColor = status.connected ? '#4CAF50' : showTrouble ? '#f44336' : stayConnected ? '#FF9800' : '#9E9E9E';

    browser.action.setBadgeText({ text: badgeText });
    browser.action.setBadgeBackgroundColor({ color: badgeColor });

    const title = status.connected
      ? `Sidekick connected to ${status.url}`
      : showTrouble
        ? formatReconnectStatus(status.reconnectElapsedMs, status.reconnectAttempts)
        : stayConnected
          ? 'Sidekick reconnecting…'
          : 'Sidekick not connected';
    void browser.action.setTitle({ title });
  }
});

function formatReconnectStatus(elapsedMs: number, attempts: number) {
  const roundedMinutes = Math.floor(elapsedMs / 60_000);
  if (roundedMinutes >= 1) {
    return `Couldn't connect for ${roundedMinutes} minute${roundedMinutes === 1 ? '' : 's'} (${attempts} attempt${attempts === 1 ? '' : 's'})`;
  }
  const seconds = Math.floor(elapsedMs / 1000);
  return `Couldn't connect for ${seconds}s (${attempts} attempt${attempts === 1 ? '' : 's'})`;
}
