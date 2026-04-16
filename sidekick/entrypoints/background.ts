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

  // ========================================================================
  // Message handler — popup, content script, internal
  // ========================================================================

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type } = message;

    // --- Connection management (popup) ---

    if (type === 'connect') {
      void (async () => {
        if (typeof message.url === 'string' && message.url) {
          relayUrl = message.url;
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
        stayConnected = Boolean(message.enabled);
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

    // --- Scratchpad ---

    if (type === 'scratchpadWrite') {
      // Browser-side dump: forward to relay so it stores the entry
      if (message.from === 'browser') {
        void (async () => {
          try {
            const result = await sendToRelay({ type: 'scratchpadWrite', from: 'browser', body: message.body });
            sendResponse(result || { success: true });
          } catch (error) {
            sendResponse({ success: false, error: String(error) });
          }
        })();
        return true;
      }
      sendResponse({ success: true });
      return false;
    }

    // --- Page-global injection ---

    if (type === 'injectPageGlobal') {
      void (async () => {
        try {
          const tabId = sender.tab?.id;
          if (!tabId) {
            sendResponse({ success: false, error: 'No sender tab' });
            return;
          }
          await injectPageGlobal(tabId);
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, error: String(error) });
        }
      })();
      return true;
    }

    return false;
  });

  // ========================================================================
  // Push agent writes to page global via content script
  // ========================================================================

  async function pushAgentWriteToPage(body: string) {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) return;
      await browser.tabs.sendMessage(tabId, { type: 'scratchpadPush', body });
    } catch {
      // Tab may not have content script; ignore
    }
  }

  // ========================================================================
  // Page-global injection (window.sidekick)
  // ========================================================================

  async function injectPageGlobal(tabId: number) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const w = window as any;
        if (w.sidekick?.__v === 1) return;

        const REQ = '__sidekickReq';
        const RES = '__sidekickRes';
        const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: number }>();

        // Listen for responses and pushes from content script
        window.addEventListener('message', (event) => {
          if (event.source !== window) return;
          const msg = event.data;
          if (!msg || msg[RES] !== true) return;

          // Agent push
          if (msg.push && typeof msg.body === 'string') {
            w.sidekick.messages.unshift(msg.body);
            return;
          }

          // Response to a request
          if (typeof msg.rid === 'string') {
            const p = pending.get(msg.rid);
            if (!p) return;
            pending.delete(msg.rid);
            clearTimeout(p.timer);
            if (msg.ok) {
              p.resolve(msg.result);
            } else {
              p.reject(new Error(msg.error || 'bridge error'));
            }
          }
        });

        function request(command: string, payload: any = {}): Promise<any> {
          return new Promise((resolve, reject) => {
            const rid = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            const timer = window.setTimeout(() => {
              pending.delete(rid);
              reject(new Error(`sidekick bridge timeout: ${command}`));
            }, 10_000);
            pending.set(rid, { resolve, reject, timer });
            window.postMessage({ [REQ]: true, rid, command, ...payload }, '*');
          });
        }

        function serialize(node: Node, format: string) {
          if (format === 'html') {
            return node instanceof Element ? node.outerHTML : (node.textContent || '');
          }
          if (format === 'skeleton') {
            return JSON.stringify(skeleton(node), null, 2);
          }
          throw new Error(`sidekick.dump: unknown format "${format}"`);
        }

        async function dump(input: Node | string, opts?: { format?: 'html' | 'skeleton' }) {
          let body: string;
          if (typeof input === 'string') {
            body = input;
          } else if (input instanceof Node) {
            const format = opts?.format || 'html';
            body = serialize(input, format);
          } else {
            throw new Error('sidekick.dump: expected a DOM Node or string');
          }
          await request('scratchpadWrite', { from: 'browser', body });
          return body;
        }

        function skeleton(node: Node, depth = 0): any {
          const MAX_DEPTH = 6;
          const MAX_CHILDREN = 50;
          const TEXT_LIMIT = 120;

          function textSample(n: Node) {
            const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
            return t.length <= TEXT_LIMIT ? t : t.slice(0, TEXT_LIMIT - 1) + '…';
          }

          if (node.nodeType === Node.TEXT_NODE) {
            const t = textSample(node);
            return t ? { type: 'text', text: t } : null;
          }
          if (!(node instanceof Element)) return null;

          const attrs: Record<string, string> = {};
          for (const { name, value } of Array.from(node.attributes)) {
            if (['id', 'class', 'role', 'href', 'type', 'name', 'value'].includes(name) || name.startsWith('aria-') || name.startsWith('data-')) {
              attrs[name] = value;
            }
          }

          const summary: any = {
            tag: node.tagName.toLowerCase(),
            attrs,
            text: textSample(node),
            childCount: node.childNodes.length,
          };

          if (depth >= MAX_DEPTH) {
            summary.truncated = true;
            return summary;
          }

          const children = Array.from(node.childNodes)
            .slice(0, MAX_CHILDREN)
            .map((c) => skeleton(c, depth + 1))
            .filter(Boolean);

          if (children.length) summary.children = children;
          if (node.childNodes.length > MAX_CHILDREN) {
            summary.moreChildren = node.childNodes.length - MAX_CHILDREN;
          }

          return summary;
        }

        w.sidekick = {
          dump,
          messages: [] as string[],
          __v: 1,
        };
      },
    });
  }

  // ========================================================================
  // Send a request to the relay and wait for a response
  // ========================================================================

  function sendToRelay(request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to relay'));
        return;
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const timeout = setTimeout(() => {
        pendingRelayRequests.delete(id);
        reject(new Error('Relay request timeout'));
      }, 10000);
      pendingRelayRequests.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify({ id, request }));
    });
  }

  const pendingRelayRequests = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timeout: ReturnType<typeof setTimeout> }>();

  // ========================================================================
  // Relay handling (CLI ↔ extension)
  // ========================================================================

  async function handleMessage(raw: string) {
    try {
      const msg = JSON.parse(raw);

      // Check if this is a response to a request we initiated (e.g. browser dump → relay)
      if (msg.response !== undefined && typeof msg.id === 'string') {
        const pending = pendingRelayRequests.get(msg.id);
        if (pending) {
          pendingRelayRequests.delete(msg.id);
          clearTimeout(pending.timeout);
          pending.resolve(msg.response);
          return;
        }
      }

      // Otherwise it's a request from the relay for us to handle
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

  async function handleRequest(request: Request): Promise<Response> {
    switch (request.type) {
      case 'eval':
        return handleEval(request);
      case 'tabs':
        return handleTabs();
      case 'screenshot':
        return handleScreenshot(request);
      case 'scratchpadWrite':
        return handleScratchpadWriteFromRelay(request);
      default:
        return { type: 'eval', success: false, error: `Unknown request type: ${(request as any).type}` };
    }
  }

  // Agent writes forwarded from relay — push body to page via content script
  async function handleScratchpadWriteFromRelay(request: any): Promise<Response> {
    try {
      if (request.from === 'agent') {
        await pushAgentWriteToPage(request.body);
      }
      return { type: 'scratchpadWrite', success: true };
    } catch (error) {
      return { type: 'scratchpadWrite', success: false, error: String(error) };
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
            try { JSON.stringify(value); return value; } catch { return { __unserializable: true, toString: String(value) }; }
          }
          try {
            const result = (0, eval)(code);
            return serialize(result);
          } catch (e: any) {
            return { __error: true, message: e.message, name: e.name };
          }
        },
        args: [request.code],
        world: 'ISOLATED',
      });
      const value = results?.[0]?.result;
      if (value?.__error) {
        return { type: 'eval', success: false, error: `${value.name}: ${value.message}` };
      }
      return { type: 'eval', success: true, result: value };
    } catch (error: any) {
      return { type: 'eval', success: false, error: `executeScript failed: ${error.message}` };
    }
  }

  async function handleTabs(): Promise<Response> {
    try {
      const tabs = await browser.tabs.query({});
      return { type: 'tabs', success: true, tabs: tabs.map((t) => ({ id: t.id!, title: t.title || '', url: t.url || '' })) };
    } catch (error) {
      return { type: 'tabs', success: false, error: String(error) };
    }
  }

  async function handleScreenshot(request: ScreenshotRequest): Promise<Response> {
    const tabId = request.tabId ?? (await getActiveTabId());
    if (!tabId) return { type: 'screenshot', success: false, error: 'No active tab' };
    try {
      const win = await browser.windows.getCurrent();
      if (!win.id) return { type: 'screenshot', success: false, error: 'No window ID' };
      const dataUrl = await browser.tabs.captureVisibleTab(win.id, { format: 'png' });
      const base64 = dataUrl.split(',')[1];
      return { type: 'screenshot', success: true, image: base64 };
    } catch (error) {
      return { type: 'screenshot', success: false, error: String(error) };
    }
  }

  // ========================================================================
  // Connection management
  // ========================================================================

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

  function isConnecting() { return Boolean(activeConnectPromise); }

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
      connected = true; lastError = undefined; updateBadge(); broadcastStatus();
      return { success: true };
    }
    if (activeConnectPromise && activeConnectUrl === url) return activeConnectPromise;

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
        updateBadge(); broadcastStatus();

        socket.onopen = () => {
          connected = true; ws = socket; lastError = undefined;
          reconnectAttempts = 0; reconnectStartedAt = null; reconnectNotified = false;
          clearReconnectTimer(); ensureStatusBroadcast(); updateBadge(); broadcastStatus();
          finish({ success: true });
        };
        socket.onclose = (event) => {
          if (ws === socket) ws = null;
          connected = false;
          if (!intentionalDisconnect) {
            const detail = event.reason || `close ${event.code}`;
            lastError = `Disconnected (${detail})`;
            scheduleReconnect('close');
          }
          updateBadge(); broadcastStatus();
          finish(options.manual ? { success: false, error: lastError || 'Connection closed' } : { success: true });
        };
        socket.onerror = () => {
          connected = false; lastError = 'Connection failed';
          updateBadge(); broadcastStatus();
          finish({ success: false, error: lastError });
        };
        socket.onmessage = (event) => { messageCount++; void handleMessage(event.data); };
      } catch (error) {
        connected = false; lastError = String(error);
        updateBadge(); broadcastStatus();
        finish({ success: false, error: lastError });
      }
    });

    const result = await activeConnectPromise;
    if (!result.success && (stayConnected || !options.manual)) scheduleReconnect('connect-failed');
    if (options.manual && !result.success) return result;
    return result;
  }

  function scheduleReconnect(reason: string) {
    if (!stayConnected || intentionalDisconnect) return;
    if (connected || isConnecting()) return;
    if (!reconnectStartedAt) {
      reconnectStartedAt = Date.now(); reconnectAttempts = 0; reconnectNotified = false;
    }
    if (reconnectTimer) return;
    reconnectAttempts += 1;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_DELAY_MS);
    lastError = `${reason}; retrying in ${Math.round(delay / 1000)}s`;
    ensureStatusBroadcast(); updateBadge(); broadcastStatus();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect(relayUrl, { manual: false });
      maybeNotifyReconnectTrouble();
    }, delay);
  }

  function maybeNotifyReconnectTrouble() {
    if (!stayConnected || reconnectNotified || !reconnectStartedAt) return;
    const elapsed = Date.now() - reconnectStartedAt;
    if (elapsed < RECONNECT_NOTIFY_THRESHOLD_MS) return;
    reconnectNotified = true;
    if (!('notifications' in browser)) return;
    const minutes = Math.floor(elapsed / 60_000);
    const message = `Couldn't connect for ${minutes} minute${minutes === 1 ? '' : 's'} (${reconnectAttempts} attempts)`;
    void browser.notifications.create('sidekick-reconnect-trouble', {
      type: 'basic', iconUrl: NOTIFICATION_ICON_URL, title: 'Sidekick connection issue', message,
    }).catch(() => {});
  }

  async function disconnect(options: { manual: boolean }) {
    intentionalDisconnect = options.manual;
    stayConnected = options.manual ? false : stayConnected;
    await persistSettings();
    clearReconnectTimer(); clearStatusBroadcast();
    reconnectAttempts = 0; reconnectStartedAt = null; reconnectNotified = false; lastError = undefined;
    if (ws) { const socket = ws; ws = null; socket.close(); }
    connected = false; updateBadge(); broadcastStatus();
  }

  async function getActiveTabId(): Promise<number | undefined> {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id;
  }

  function clearReconnectTimer() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function ensureStatusBroadcast() {
    if (statusBroadcastInterval) return;
    statusBroadcastInterval = setInterval(() => {
      if (connected || !reconnectStartedAt) return;
      maybeNotifyReconnectTrouble(); updateBadge(); broadcastStatus();
    }, 1000);
  }

  function clearStatusBroadcast() {
    if (statusBroadcastInterval) { clearInterval(statusBroadcastInterval); statusBroadcastInterval = null; }
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
        : stayConnected ? 'Sidekick reconnecting…' : 'Sidekick not connected';
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
