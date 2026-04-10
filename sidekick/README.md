# Sidekick

A browser extension for opportunistic automation. Pass JS snippets in from outside the browser, get results back.

## Architecture

```
┌─────────────┐                      ┌─────────────┐
│  Extension  │ ◄─── WebSocket ────► │   Relay     │
│  Background │                      │  (serve)    │
└──────┬──────┘                      └──────┬──────┘
       │                                    │
  runtime.sendMessage                stdin/stdout
       │                                    │
       ▼                                    ▼
┌─────────────┐                      ┌─────────────┐
│   Content   │                      │    CLI      │
│   Script    │                      │  (eval)     │
└─────────────┘                      └─────────────┘
```

## Usage

### 1. Build and install the extension

```bash
cd sidekick
npm install
npm run build
```

Load `sidekick/.output/chrome-mv3/` as an unpacked extension in Chrome.

### 2. Start the relay

```bash
./sidekick.js serve
# or: node sidekick.js serve
```

### 3. Connect the extension

Click the extension icon, enter the relay URL (default: `ws://localhost:8765`), and click Connect.

You can also enable **Stay connected** in the popup. When enabled, the extension will retry in the background with exponential backoff and show a compact reconnect status in the popup. If it stays disconnected for several minutes, it will raise a browser notification.

### 4. Run commands

```bash
# Evaluate JS in current tab
./sidekick.js eval "document.title"

# Evaluate in specific tab
./sidekick.js eval -t 123 "location.href"

# List all tabs
./sidekick.js tabs

# Capture screenshot (base64)
./sidekick.js screenshot > shot.png.b64
```

## CLI Commands

```
sidekick serve                Start the relay server
sidekick eval <code>          Evaluate JS in current tab
sidekick eval -t <id> <code>  Evaluate JS in specific tab
sidekick tabs                 List all tabs
sidekick screenshot           Capture viewport (outputs base64)

Options:
  -p, --port <port>           Relay port (default: 8765)
```

## Protocol

Requests are JSON messages:

```json
{"type": "eval", "code": "document.title"}
{"type": "eval", "code": "...", "tabId": 123}
{"type": "tabs"}
{"type": "screenshot", "tabId": 123}
```

Responses:

```json
{"type": "eval", "success": true, "result": "Example Domain"}
{"type": "tabs", "success": true, "tabs": [{"id": 123, "title": "...", "url": "..."}]}
{"type": "screenshot", "success": true, "image": "<base64>"}
```

## Files

```
sidekick/
├── sidekick.js              # CLI (serve, eval, tabs, screenshot)
├── entrypoints/
│   ├── background.ts        # WebSocket client, reconnect logic, notifications
│   ├── content.ts           # JS evaluation in page context
│   └── popup/               # Connect/disconnect + stay-connected UI
├── utils/
│   └── protocol.ts          # Type definitions
└── wxt.config.ts            # Extension config
```
