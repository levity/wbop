import type {
  Request,
  Response,
  EvalRequest,
  ScreenshotRequest,
  RelayMessage,
  RelayResponse,
} from '../utils/protocol';

export default defineBackground(() => {
  // State
  let ws: WebSocket | null = null;
  let connected = false;
  let messageCount = 0;

  // Listen for messages from popup
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log('[Sidekick BG] runtime.onMessage:', JSON.stringify(message));

    const { type, url } = message;

    if (type === 'connect') {
      console.log('[Sidekick BG] connect requested, url:', url);
      connect(url).then(sendResponse);
      return true; // async response
    }

    if (type === 'disconnect') {
      console.log('[Sidekick BG] disconnect requested');
      disconnect();
      sendResponse({ success: true });
      return false;
    }

    if (type === 'status') {
      console.log('[Sidekick BG] status requested, connected:', connected);
      sendResponse({ connected });
      return false;
    }

    console.log('[Sidekick BG] unknown message type:', type);
    return false;
  });

  function connect(url: string): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      if (ws?.readyState === WebSocket.OPEN) {
        console.log('[Sidekick BG] already connected');
        resolve({ success: true });
        return;
      }

      try {
        console.log('[Sidekick BG] new WebSocket to', url);
        ws = new WebSocket(url);

        ws.onopen = () => {
          console.log('[Sidekick BG] ★ WebSocket OPEN');
          connected = true;
          updateBadge();
          resolve({ success: true });
        };

        ws.onclose = (event) => {
          console.log('[Sidekick BG] ★ WebSocket CLOSED:', event.code, event.reason);
          connected = false;
          ws = null;
          updateBadge();
        };

        ws.onerror = (event) => {
          console.error('[Sidekick BG] ★ WebSocket ERROR:', event);
          connected = false;
          resolve({ success: false, error: 'Connection failed' });
        };

        ws.onmessage = (event) => {
          messageCount++;
          console.log(`[Sidekick BG] ★ WebSocket MESSAGE #${messageCount}:`, event.data);
          handleMessage(event.data);
        };
      } catch (error) {
        console.error('[Sidekick BG] Connect error:', error);
        resolve({ success: false, error: String(error) });
      }
    });
  }

  async function handleMessage(raw: string) {
    try {
      const msg: RelayMessage = JSON.parse(raw);
      console.log('[Sidekick BG] parsed relay message, id:', msg.id, 'request:', JSON.stringify(msg.request));

      const response = await handleRequest(msg.request);
      console.log('[Sidekick BG] handleRequest result:', JSON.stringify(response));

      const relayResponse: RelayResponse = { id: msg.id, response };
      const payload = JSON.stringify(relayResponse);
      console.log('[Sidekick BG] sending relay response:', payload.slice(0, 200));

      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(payload);
        console.log('[Sidekick BG] sent relay response for', msg.id);
      } else {
        console.error('[Sidekick BG] cannot send response — websocket not open, state:', ws?.readyState);
      }
    } catch (error) {
      console.error('[Sidekick BG] Error in handleMessage:', error);
    }
  }

  function disconnect() {
    console.log('[Sidekick BG] disconnect() called');
    if (ws) {
      ws.close();
      ws = null;
      connected = false;
      updateBadge();
    }
  }

  async function handleRequest(request: Request): Promise<Response> {
    console.log('[Sidekick BG] handleRequest type:', request.type);
    switch (request.type) {
      case 'eval':
        return handleEval(request);
      case 'tabs':
        return handleTabs();
      case 'screenshot':
        return handleScreenshot(request);
      default:
        console.log('[Sidekick BG] unknown request type:', request.type);
        return { type: 'eval', success: false, error: `Unknown request type: ${(request as any).type}` };
    }
  }

  async function handleEval(request: EvalRequest): Promise<Response> {
    const tabId = request.tabId ?? (await getActiveTabId());
    console.log('[Sidekick BG] handleEval, tabId:', tabId, 'code:', request.code.slice(0, 80));

    if (!tabId) {
      return { type: 'eval', success: false, error: 'No active tab' };
    }

    try {
      // Use chrome.scripting.executeScript — bypasses page CSP
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

      // Check if the eval itself threw
      if (value?.__error) {
        return { type: 'eval', success: false, error: `${value.name}: ${value.message}` };
      }

      console.log('[Sidekick BG] eval result:', JSON.stringify(value).slice(0, 200));
      return { type: 'eval', success: true, result: value };
    } catch (error: any) {
      console.error('[Sidekick BG] executeScript failed:', error);
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
      console.log('[Sidekick BG] handleTabs: found', tabs.length, 'tabs');
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

  function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function updateBadge() {
    browser.action.setBadgeText({ text: connected ? '●' : '○' });
    browser.action.setBadgeBackgroundColor({ color: connected ? '#4CAF50' : '#9E9E9E' });
  }

  // JSON-serialize result, handling non-serializable values
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

  updateBadge();
  console.log('[Sidekick BG] ★ Background loaded');
});
