import type { EvalResponse } from '../utils/protocol';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',

  main() {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const { code, id } = message as { code: string; id: string };

      try {
        const result = eval(code);
        const response: EvalResponse = {
          type: 'eval',
          success: true,
          result: serializeResult(result),
        };
        sendResponse({ id, response });
      } catch (error) {
        const response: EvalResponse = {
          type: 'eval',
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        sendResponse({ id, response });
      }

      return true; // async response
    });
  },
});

// JSON-serialize result, handling non-serializable values
function serializeResult(value: any): any {
  if (value === undefined) return { __undefined: true };
  if (value === null) return null;
  if (typeof value === 'function') return { __function: true };
  if (typeof value === 'symbol') return { __symbol: value.toString() };
  if (value instanceof Element) {
    return {
      __element: true,
      tag: value.tagName.toLowerCase(),
      text: value.textContent?.slice(0, 200),
    };
  }
  if (value instanceof Error) {
    return { __error: true, message: value.message, name: value.name };
  }
  try {
    // Test if it's JSON-serializable
    JSON.stringify(value);
    return value;
  } catch {
    return { __unserializable: true, toString: String(value) };
  }
}
