wbop (web operator): control a long-lived browser from the CLI.

Usage:
  wbop serve [WxH]         Start the browser (runs until killed)
  wbop <command> [args]    Send a command to the running browser
  wbop --help              Show this help
  wbop --help-all          Show extended help with examples

Commands:
  goto <url> [wait_ms]           Navigate to URL
  screenshot [name] [viewport]   Save screenshot (default: full page)
  click <selector> [wait_ms]     Click an element
  type <selector> <text>         Fill an input
  press <key>                    Press a keyboard key
  eval <js>                      Run JavaScript in the page
  text [selector]                Get innerText (default: body)
  html [selector] [maxlen]       Get outerHTML (default: body)
  download <selector>            Click and wait for download
  wait <selector> [timeout_ms]   Wait for element to appear
  url                            Get current page URL
  tabs                           List all open tabs
  tab <index>                    Switch to tab by index
  close                          Shut down the browser

  Raw JSON is also accepted:
    wbop '{"cmd":"eval","js":"1+1"}'

Configuration (environment variables):
  WBOP_SOCK           Socket path           (default: /tmp/wbop.sock)
  WBOP_BROWSER_DATA   Persistent profile    (default: ~/.wbop/data)
  WBOP_DOWNLOADS      Downloads directory   (default: ~/.wbop/downloads)
  WBOP_SCREENSHOTS    Screenshots directory (default: ~/.wbop/screenshots)

---

How it works:

  `wbop serve` launches a headed Chromium browser with a persistent profile
  and listens on a Unix socket (/tmp/wbop.sock by default). It uses the
  native browser window size for page layout (`viewport: null`) and sets
  the initial window size explicitly. Pass a size like `wbop serve 1440x900`,
  or omit it to auto-pick about 95% of the current screen size. Every other
  invocation connects to that socket, sends one command, prints the JSON
  response, and exits.

  The browser stays open between commands. Log into sites by hand, then
  automate from there. It's a normal browser. wbop just gives it a CLI.

Quick start:

  Terminal 1 — start the browser:
    wbop serve
    wbop serve 1440x900

  Terminal 2 — send commands:
    wbop goto https://example.com
    wbop eval "document.title"
    wbop screenshot example
    wbop click "text=More information"
    wbop close

All responses are JSON:

  $ wbop eval "document.title"
  {"ok":true,"result":"Example Domain"}

  $ wbop url
  {"ok":true,"url":"https://example.com/"}

  $ wbop screenshot home
  {"ok":true,"file":"/Users/you/screenshots/home.png"}

Selectors:

  wbop passes selectors to Playwright. You can use:
    CSS:    wbop click "#submit"
    Text:   wbop click "text=Sign In"
    XPath:  wbop click "xpath=//button[@type='submit']"
    Role:   wbop click "role=button[name='Submit']"

  See https://playwright.dev/docs/selectors for the full syntax.

Install:

  npx wbop-cli serve            # no install needed
  npm install -g wbop-cli   # or install globally

  Playwright will install Chromium on first run if needed.

v0.1.3
