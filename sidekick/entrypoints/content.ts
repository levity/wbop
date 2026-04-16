/**
 * Content script — bridge between page global (window.sidekick) and the
 * background service worker.
 *
 * Page → content script: window.postMessage with __sidekickReq marker
 * Content script → page: window.postMessage with __sidekickRes marker
 * Background → content script: browser.runtime.onMessage (for pushes)
 */

const REQ = '__sidekickReq';
const RES = '__sidekickRes';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',

  main() {
    // Ask background to inject the page-global helper
    void browser.runtime.sendMessage({ type: 'injectPageGlobal' }).catch(() => {});

    // Relay page requests to background
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg[REQ] !== true) return;
      void relayToBackground(msg);
    });

    // Receive pushes from background (agent writes)
    browser.runtime.onMessage.addListener((message) => {
      if (message?.type === 'scratchpadPush') {
        window.postMessage({
          [RES]: true,
          push: true,
          body: message.body,
        }, '*');
      }
    });
  },
});

async function relayToBackground(msg: any) {
  const rid = msg.rid as string;
  try {
    const result = await browser.runtime.sendMessage({
      type: msg.command,
      from: msg.from,
      body: msg.body,
      afterId: msg.afterId,
    });
    window.postMessage({ [RES]: true, rid, ok: true, result }, '*');
  } catch (error) {
    window.postMessage({
      [RES]: true,
      rid,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, '*');
  }
}
