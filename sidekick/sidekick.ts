#!/usr/bin/env node
/**
 * Sidekick CLI
 *
 * Usage:
 *   sidekick serve              Start the relay server
 *   sidekick eval "code"        Evaluate JS in current tab
 *   sidekick eval -t 123 "code" Evaluate JS in specific tab
 *   sidekick tabs               List all tabs
 *   sidekick screenshot         Capture viewport screenshot
 *   sidekick read               Read latest browser-side scratchpad entry
 *   sidekick write "body"       Write to scratchpad (pushed to page as sidekick.messages[0])
 */

import { WebSocketServer, WebSocket } from 'ws';

const VERSION = '0.2.0';
const DEFAULT_PORT = 8765;
const PREVIEW_LIMIT = 120;
const RESPONSE_PREVIEW_LIMIT = 140;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function singleLine(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, limit: number) {
  const clean = singleLine(value);
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1))}…`;
}

function preview(value: unknown, limit: number) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return truncate(text ?? String(value), limit);
  } catch {
    return truncate(String(value), limit);
  }
}

function responseSummary(response: any) {
  const body = response?.error ?? response?.result ?? response?.tabs ?? response?.image ?? response;
  const serialized = (() => {
    try {
      return typeof body === 'string' ? body : JSON.stringify(body);
    } catch {
      return String(body);
    }
  })();
  return `chars=${serialized.length} preview=${preview(serialized, RESPONSE_PREVIEW_LIMIT)}`;
}

function logLine(direction: string, message: string) {
  console.log(`${timestamp()} ${direction} ${message}`);
}

function logInfo(message: string) {
  console.log(`${timestamp()} ${message}`);
}

function describeRequest(request: any) {
  switch (request?.type) {
    case 'eval':
      return `id=${request.__id ?? '?'} type=eval${request.tabId !== undefined ? ` tab=${request.tabId}` : ''} code=${preview(request.code, PREVIEW_LIMIT)}`;
    case 'tabs':
      return `id=${request.__id ?? '?'} type=tabs`;
    case 'screenshot':
      return `id=${request.__id ?? '?'} type=screenshot${request.tabId !== undefined ? ` tab=${request.tabId}` : ''}`;
    case 'scratchpadWrite':
      return `id=${request.__id ?? '?'} type=scratchpadWrite from=${request.from} body=${preview(request.body, PREVIEW_LIMIT)}`;
    case 'scratchpadRead':
      return `id=${request.__id ?? '?'} type=scratchpadRead from=${request.from ?? 'any'}`;
    default:
      return `id=${request?.__id ?? '?'} type=${request?.type ?? 'unknown'} payload=${preview(request, PREVIEW_LIMIT)}`;
  }
}

// ============================================================================
// Serve Command — Relay between extension and CLI clients
// ============================================================================

async function serve(port: number) {
  const connected = new Set<WebSocket>();
  const pendingRequests = new Map<string, { timeout: ReturnType<typeof setTimeout>; senderWs: WebSocket; request: any }>();

  // Scratchpad — in-memory log, lives in the relay
  const SCRATCHPAD_LIMIT = 200;
  const scratchpad: Array<{ id: string; from: string; body: string; ts: string }> = [];

  function scratchpadAppend(from: string, body: string) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      from,
      body,
      ts: new Date().toISOString(),
    };
    scratchpad.push(entry);
    if (scratchpad.length > SCRATCHPAD_LIMIT) scratchpad.splice(0, scratchpad.length - SCRATCHPAD_LIMIT);
    return entry;
  }

  function scratchpadLatest(from?: string, afterId?: string) {
    const filtered = from ? scratchpad.filter((e) => e.from === from) : scratchpad;
    const latest = filtered[filtered.length - 1];
    if (!latest) return { found: false };
    if (afterId && latest.id === afterId) return { found: false };
    return { found: true, entry: latest };
  }

  const server = new WebSocketServer({ port });

  function otherPeer(ws: WebSocket): WebSocket | null {
    for (const peer of connected) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) return peer;
    }
    return null;
  }

  function failPending(ws: WebSocket, error: string) {
    for (const [id, pending] of pendingRequests) {
      if (pending.senderWs === ws) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(id);
        const errorResponse = { id, response: { success: false, error } };
        logLine('←', `id=${id} error chars=${error.length} preview=${error}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(errorResponse));
        }
      }
    }
  }

  // Handle scratchpad requests locally in the relay
  function handleScratchpadRequest(ws: WebSocket, msg: any): boolean {
    const request = msg.request;
    if (!request) return false;

    if (request.type === 'scratchpadRead') {
      const result = scratchpadLatest(request.from, request.afterId);
      const response = { id: msg.id, response: { type: 'scratchpadRead', success: true, ...result } };
      logLine('←', `id=${msg.id} ok scratchpadRead found=${result.found}`);
      ws.send(JSON.stringify(response));
      return true;
    }

    if (request.type === 'scratchpadWrite') {
      const from = request.from || 'agent';
      const entry = scratchpadAppend(from, request.body);
      logLine('→', `id=${msg.id} scratchpadWrite from=${entry.from} body=${preview(entry.body, PREVIEW_LIMIT)}`);

      // Agent writes must be pushed to the extension peer (to land in sidekick.messages)
      if (from === 'agent') {
        const target = otherPeer(ws);
        if (!target) {
          const response = { id: msg.id, response: { type: 'scratchpadWrite', success: false, error: 'No other peer connected' } };
          logLine('←', `id=${msg.id} error scratchpadWrite no peer`);
          ws.send(JSON.stringify(response));
          return true;
        }

        const forwardId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const forwardMsg = { id: forwardId, request: { type: 'scratchpadWrite', from: entry.from, body: entry.body } };

        const timeout = setTimeout(() => {
          pendingRequests.delete(forwardId);
          logInfo(`scratchpadWrite push to peer timed out for id=${msg.id}`);
        }, 10000);

        pendingRequests.set(forwardId, { timeout, senderWs: ws, request: forwardMsg.request });
        target.send(JSON.stringify(forwardMsg));
      }

      // Respond immediately — entry is stored in relay
      const response = { id: msg.id, response: { type: 'scratchpadWrite', success: true, entry } };
      ws.send(JSON.stringify(response));
      return true;
    }

    return false;
  }

  server.on('connection', (ws) => {
    connected.add(ws);
    let isClient = true;
    let settled = false;

    // Log persistent peers (extension) but not transient CLI connections.
    // Settle after 2s — if still connected, it's a persistent peer.
    const settleTimer = setTimeout(() => { isClient = false; settled = true; logInfo('peer connected'); }, 2000);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Response: deliver to the requester who sent the original request
        if (msg.response !== undefined) {
          const pending = pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeout);
            pendingRequests.delete(msg.id);
            logLine('←', `id=${msg.id} ${msg.response?.success === false ? 'error' : 'ok'} ${responseSummary(msg.response)}`);
            if (pending.senderWs.readyState === WebSocket.OPEN) {
              pending.senderWs.send(JSON.stringify(msg));
            } else {
              logInfo(`response dropped for id=${msg.id}; requester already disconnected`);
            }
          } else {
            logInfo(`unexpected response id=${msg.id} ${responseSummary(msg.response)}`);
          }
          return;
        }

        // Scratchpad: handled locally by relay
        if (msg.request && handleScratchpadRequest(ws, msg)) {
          return;
        }

        // All other requests: forward to the other connected peer
        if (msg.request) {
          const request = { ...msg.request, __id: msg.id };
          const target = otherPeer(ws);

          if (!target) {
            const error = 'No other peer connected';
            const errorResponse = { id: msg.id, response: { success: false, error } };
            logLine('←', `id=${msg.id} error chars=${error.length} preview=${error}`);
            ws.send(JSON.stringify(errorResponse));
            return;
          }

          logLine('→', describeRequest(request));

          const timeout = setTimeout(() => {
            pendingRequests.delete(msg.id);
            const errorResponse = { id: msg.id, response: { success: false, error: 'Request timeout' } };
            logLine('←', `id=${msg.id} error chars=15 preview=Request timeout`);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(errorResponse));
            }
          }, 10000);

          pendingRequests.set(msg.id, { timeout, senderWs: ws, request });
          target.send(JSON.stringify(msg));
        }
      } catch (error) {
        logInfo(`parse error ${preview(String(error), PREVIEW_LIMIT)}`);
      }
    });

    ws.on('close', () => {
      connected.delete(ws);
      clearTimeout(settleTimer);
      if (!isClient) {
        logInfo('peer disconnected');
      }
      failPending(ws, 'Other peer disconnected');
    });

    ws.on('error', (err) => {
      logInfo(`websocket error ${preview(err.message, PREVIEW_LIMIT)}`);
    });
  });

  logInfo(`relay listening on ws://localhost:${port}`);
  logInfo('waiting for peers to connect');
}

// ============================================================================
// Client Commands
// ============================================================================

async function sendRequest(request: any, port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);

    ws.on('error', () => reject(new Error('Cannot connect to relay. Is `sidekick serve` running?')));

    ws.on('open', () => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Request timeout'));
      }, 10000);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            clearTimeout(timeout);
            ws.close();
            resolve(msg.response);
          }
        } catch (error) {
          clearTimeout(timeout);
          ws.close();
          reject(error);
        }
      });

      ws.send(JSON.stringify({ id, request }));
    });
  });
}

async function evalCode(code: string, tabId: number | undefined, port: number) {
  const request: any = { type: 'eval', code };
  if (tabId !== undefined) request.tabId = tabId;

  const response = await sendRequest(request, port);

  if (!response.success) {
    console.error('Error:', response.error);
    process.exit(1);
  }

  console.log(JSON.stringify(response.result, null, 2));
}

async function listTabs(port: number) {
  const response = await sendRequest({ type: 'tabs' }, port);

  if (!response.success) {
    console.error('Error:', response.error);
    process.exit(1);
  }

  for (const tab of response.tabs) {
    console.log(`${tab.id}\t${tab.title.slice(0, 40)}\t${tab.url.slice(0, 60)}`);
  }
}

async function screenshot(port: number, tabId: number | undefined) {
  const request: any = { type: 'screenshot' };
  if (tabId !== undefined) request.tabId = tabId;

  const response = await sendRequest(request, port);

  if (!response.success) {
    console.error('Error:', response.error);
    process.exit(1);
  }

  console.log(response.image);
}

async function scratchpadRead(port: number) {
  const response = await sendRequest({ type: 'scratchpadRead', from: 'browser' }, port);

  if (!response.success) {
    console.error('Error:', response.error);
    process.exit(1);
  }

  if (!response.found) {
    console.error('No browser message found in scratchpad.');
    process.exit(1);
  }

  console.log(response.entry.body);
}

async function scratchpadWrite(body: string, port: number) {
  const response = await sendRequest({ type: 'scratchpadWrite', from: 'agent', body }, port);

  if (!response.success) {
    console.error('Error:', response.error);
    process.exit(1);
  }

  console.log('Written to scratchpad. Pushed to page as sidekick.messages[0].');
}

// ============================================================================
// CLI
// ============================================================================

function showHelp() {
  console.log(`
sidekick - Browser automation via extension + relay bridge

Commands:
  serve                Start the relay server
  eval <code>          Evaluate JS in current tab
  eval -t <id> <code>  Evaluate JS in specific tab
  tabs                 List all tabs
  screenshot           Capture viewport screenshot (outputs base64)
  read                 Read the latest browser-side scratchpad entry
  write <body>         Write to scratchpad; pushed to page as sidekick.messages[0]

The scratchpad is a shared log bridging the agent CLI and the browser page.
Browser-side code writes via sidekick.dump(node) or sidekick.send(node).
Agent-side code writes via "sidekick write", which pushes to sidekick.messages[].

Options:
  -p, --port <port>    Relay port (default: ${DEFAULT_PORT})
  -h, --help           Show this help
  -v, --version        Show version

Examples:
  sidekick serve
  sidekick read
  sidekick write "document.querySelectorAll('.row').forEach(r => console.log(r.textContent))"
  sidekick eval "document.title"
  sidekick tabs
  sidekick screenshot > shot.png.b64
`);
}

function parseArgs(args: string[]): { command: string; options: Record<string, any>; positional: string[] } {
  const options: Record<string, any> = { port: DEFAULT_PORT };
  const positional: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-v' || arg === '--version') {
      options.version = true;
    } else if (arg === '-p' || arg === '--port') {
      options.port = parseInt(args[++i], 10);
    } else if (arg === '-t') {
      options.tabId = parseInt(args[++i], 10);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }

    i++;
  }

  return { command: positional[0] || '', options, positional: positional.slice(1) };
}

async function main() {
  const { command, options, positional } = parseArgs(process.argv.slice(2));

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (options.version) {
    console.log(`sidekick v${VERSION}`);
    process.exit(0);
  }

  const port = options.port;

  switch (command) {
    case 'serve':
      await serve(port);
      break;

    case 'eval':
      if (positional.length === 0) {
        console.error('Usage: sidekick eval <code>');
        process.exit(1);
      }
      await evalCode(positional.join(' '), options.tabId, port);
      break;

    case 'tabs':
      await listTabs(port);
      break;

    case 'screenshot':
      await screenshot(port, options.tabId);
      break;

    case 'read':
      await scratchpadRead(port);
      break;

    case 'write':
      if (positional.length === 0) {
        console.error('Usage: sidekick write <body>');
        process.exit(1);
      }
      await scratchpadWrite(positional.join(' '), port);
      break;

    default:
      showHelp();
      process.exit(command ? 1 : 0);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
