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

// ============================================================================
// Serve Command — Relay between extension and CLI clients
// ============================================================================

async function serve(port: number) {
  let extension: WebSocket | null = null;
  // Map: requestId -> { resolve, timeout, clientWs }
  const pendingRequests = new Map<string, { resolve: Function; timeout: ReturnType<typeof setTimeout>; clientWs: WebSocket }>();

  const server = new WebSocketServer({ port });

  server.on('connection', (ws) => {
    // First connection = extension, subsequent = CLI clients
    if (!extension) {
      extension = ws;
      console.log('[relay] Extension connected');
    } else {
      console.log('[relay] CLI client connected');
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.response) {
          // Response from extension — forward back to the CLI client that asked
          const pending = pendingRequests.get(msg.id);
          if (pending) {
            console.log('[relay] ← response for', msg.id, '→ forwarding to CLI');
            clearTimeout(pending.timeout);
            pendingRequests.delete(msg.id);

            // Send the response back to the CLI client's websocket
            if (pending.clientWs.readyState === WebSocket.OPEN) {
              pending.clientWs.send(JSON.stringify(msg));
              console.log('[relay] → sent response to CLI');
            } else {
              console.log('[relay] CLI client already disconnected');
            }
          } else {
            console.log('[relay] ← response for unknown request', msg.id);
          }
        } else if (msg.request) {
          // Request from a CLI client — forward to extension, remember which client
          if (!extension || extension.readyState !== WebSocket.OPEN) {
            console.log('[relay] ← request but no extension connected');
            const errorResponse = { id: msg.id, response: { success: false, error: 'No extension connected' } };
            ws.send(JSON.stringify(errorResponse));
            return;
          }
          console.log('[relay] ← request', msg.id, msg.request.type, '→ forwarding to extension');

          const timeout = setTimeout(() => {
            pendingRequests.delete(msg.id);
            const errorResponse = { id: msg.id, response: { success: false, error: 'Request timeout' } };
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(errorResponse));
            }
          }, 10000);

          // Track the CLI client so we can send the response back
          pendingRequests.set(msg.id, { resolve: () => {}, timeout, clientWs: ws });

          extension.send(JSON.stringify(msg));
        }
      } catch (error) {
        console.error('[relay] Error parsing message:', error);
      }
    });

    ws.on('close', () => {
      if (ws === extension) {
        console.log('[relay] Extension disconnected');
        extension = null;
        // Fail all pending requests
        for (const [id, pending] of pendingRequests) {
          clearTimeout(pending.timeout);
          const errorResponse = { id, response: { success: false, error: 'Extension disconnected' } };
          if (pending.clientWs.readyState === WebSocket.OPEN) {
            pending.clientWs.send(JSON.stringify(errorResponse));
          }
        }
        pendingRequests.clear();
      } else {
        console.log('[relay] CLI client disconnected');
      }
    });

    ws.on('error', (err) => {
      console.error('[relay] WebSocket error:', err.message);
    });
  });

  console.log(`[sidekick] Relay listening on ws://localhost:${port}`);
  console.log('[sidekick] Waiting for extension to connect...');
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
