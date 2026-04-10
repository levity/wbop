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
 */

import { WebSocketServer, WebSocket } from 'ws';

const VERSION = '0.1.0';
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
    default:
      return `id=${request?.__id ?? '?'} type=${request?.type ?? 'unknown'} payload=${preview(request, PREVIEW_LIMIT)}`;
  }
}

// ============================================================================
// Serve Command — Relay between extension and CLI clients
// ============================================================================

async function serve(port: number) {
  let extension: WebSocket | null = null;
  const pendingRequests = new Map<string, { timeout: ReturnType<typeof setTimeout>; clientWs: WebSocket; request: any }>();

  const server = new WebSocketServer({ port });

  server.on('connection', (ws) => {
    const peer = !extension ? 'extension' : 'client';

    if (!extension) {
      extension = ws;
      logInfo('extension connected');
    } else {
      logInfo('cli client connected');
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.response) {
          const pending = pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeout);
            pendingRequests.delete(msg.id);
            logLine('←', `id=${msg.id} ${msg.response?.success === false ? 'error' : 'ok'} ${responseSummary(msg.response)}`);

            if (pending.clientWs.readyState === WebSocket.OPEN) {
              pending.clientWs.send(JSON.stringify(msg));
            } else {
              logInfo(`response dropped for id=${msg.id}; cli client already disconnected`);
            }
          } else {
            logInfo(`unexpected response id=${msg.id} ${responseSummary(msg.response)}`);
          }
          return;
        }

        if (msg.request) {
          const request = { ...msg.request, __id: msg.id };

          if (peer !== 'client') {
            logInfo(`unexpected request from extension id=${msg.id} type=${msg.request.type}`);
            return;
          }

          if (!extension || extension.readyState !== WebSocket.OPEN) {
            const errorResponse = { id: msg.id, response: { success: false, error: 'No extension connected' } };
            logLine('←', `id=${msg.id} error chars=22 preview=No extension connected`);
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

          pendingRequests.set(msg.id, { timeout, clientWs: ws, request });
          extension.send(JSON.stringify(msg));
        }
      } catch (error) {
        logInfo(`parse error ${preview(String(error), PREVIEW_LIMIT)}`);
      }
    });

    ws.on('close', () => {
      if (ws === extension) {
        logInfo('extension disconnected');
        extension = null;
        for (const [id, pending] of pendingRequests) {
          clearTimeout(pending.timeout);
          const errorResponse = { id, response: { success: false, error: 'Extension disconnected' } };
          logLine('←', `id=${id} error chars=22 preview=Extension disconnected`);
          if (pending.clientWs.readyState === WebSocket.OPEN) {
            pending.clientWs.send(JSON.stringify(errorResponse));
          }
        }
        pendingRequests.clear();
      } else {
        logInfo('cli client disconnected');
      }
    });

    ws.on('error', (err) => {
      logInfo(`websocket error ${preview(err.message, PREVIEW_LIMIT)}`);
    });
  });

  logInfo(`relay listening on ws://localhost:${port}`);
  logInfo('waiting for extension to connect');
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

// ============================================================================
// CLI
// ============================================================================

function showHelp() {
  console.log(`
sidekick - Browser automation via extension

Commands:
  serve                Start the relay server
  eval <code>          Evaluate JS in current tab
  eval -t <id> <code>  Evaluate JS in specific tab
  tabs                 List all tabs
  screenshot           Capture viewport screenshot (outputs base64)

Options:
  -p, --port <port>    Relay port (default: ${DEFAULT_PORT})
  -h, --help           Show this help
  -v, --version        Show version

Examples:
  sidekick serve
  sidekick eval "document.title"
  sidekick eval -t 123 "location.href"
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

    default:
      showHelp();
      process.exit(command ? 1 : 0);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
