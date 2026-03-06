#!/usr/bin/env node

import { resolve, join, dirname } from "path";
import { existsSync, unlinkSync, mkdirSync, readFileSync } from "fs";
import { createServer, connect } from "net";
import { fileURLToPath } from "url";

const VERSION = "0.1.0";
const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

// ─── Help & version ───────────────────────────────────────────────────────────

if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h") || !args.length) {
  printHelp(false);
  process.exit(args.length ? 0 : 1);
}

if (args.includes("--help-all")) {
  printHelp(true);
  process.exit(0);
}

function printHelp(full) {
  const readme = readFileSync(join(PKG_DIR, "README.txt"), "utf8");
  const [short, extended] = readme.split("\n---\n");
  if (full) {
    process.stdout.write(short + "\n" + extended);
  } else {
    process.stdout.write(short);
  }
}

// ─── Resolve socket path ──────────────────────────────────────────────────────

const SOCK = process.env.WBOP_SOCK || "/tmp/wbop.sock";

// ─── Client mode ──────────────────────────────────────────────────────────────

if (args[0] !== "serve") {
  const msg = buildMessage(args);
  const sock = connect(SOCK);
  let buf = "";
  sock.on("connect", () => sock.write(JSON.stringify(msg) + "\n"));
  sock.on("data", (d) => { buf += d; });
  sock.on("end", () => { process.stdout.write(buf); process.exit(0); });
  sock.on("error", (e) => {
    if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
      console.error("wbop: not running. Start it with: wbop serve");
    } else {
      console.error("wbop:", e.message);
    }
    process.exit(1);
  });
  setTimeout(() => { console.error("wbop: timeout (60s)"); process.exit(1); }, 60000);
} else {
  await startServer();
}

// ─── Build JSON message from CLI args ─────────────────────────────────────────

function buildMessage(args) {
  if (args[0].startsWith("{")) return JSON.parse(args[0]);

  const cmd = args[0];
  switch (cmd) {
    case "goto":       return { cmd, url: args[1], wait: num(args[2]) };
    case "screenshot": return { cmd, name: args[1], fullPage: args[2] !== "viewport" };
    case "click":      return { cmd, selector: args[1], wait: num(args[2]) };
    case "type":       return { cmd, selector: args[1], text: args.slice(2).join(" ") };
    case "press":      return { cmd, key: args[1] };
    case "download":   return { cmd, selector: args[1] };
    case "wait":       return { cmd, selector: args[1], timeout: num(args[2]) || 30000 };
    case "eval":       return { cmd, js: args.slice(1).join(" ") };
    case "text":       return { cmd, selector: args[1] || "body" };
    case "html":       return { cmd, selector: args[1] || "body", maxLength: num(args[2]) };
    case "url":        return { cmd };
    case "tabs":       return { cmd };
    case "tab":        return { cmd, index: parseInt(args[1], 10) };
    case "close":      return { cmd };
    default:           return { cmd, ...parseExtra(args.slice(1)) };
  }
}

function num(s) { const n = parseInt(s, 10); return isNaN(n) ? undefined : n; }

function parseExtra(pairs) {
  const obj = {};
  for (let i = 0; i < pairs.length; i += 2) {
    if (pairs[i + 1] !== undefined) obj[pairs[i]] = pairs[i + 1];
  }
  return obj;
}

// ─── Server mode ──────────────────────────────────────────────────────────────

async function startServer() {
  const { chromium } = await import("playwright");

  const HOME = join(process.env.HOME || process.env.USERPROFILE || ".", ".wbop");
  const BROWSER_DATA = resolve(process.env.WBOP_BROWSER_DATA || join(HOME, "data"));
  const DOWNLOADS = resolve(process.env.WBOP_DOWNLOADS || join(HOME, "downloads"));
  const SCREENSHOTS = resolve(process.env.WBOP_SCREENSHOTS || join(HOME, "screenshots"));
  const [VW, VH] = (process.env.WBOP_VIEWPORT || "1280x900").split("x").map(Number);

  for (const dir of [BROWSER_DATA, DOWNLOADS, SCREENSHOTS]) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(SOCK)) {
    const alive = await new Promise((res) => {
      const c = connect(SOCK);
      c.on("connect", () => { c.end(); res(true); });
      c.on("error", () => res(false));
    });
    if (alive) {
      console.error(`wbop: already running on ${SOCK}`);
      process.exit(1);
    }
    unlinkSync(SOCK);
  }

  const context = await chromium.launchPersistentContext(BROWSER_DATA, {
    headless: false,
    viewport: { width: VW, height: VH },
    acceptDownloads: true,
    downloadsPath: DOWNLOADS,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  let page = context.pages()[0] || await context.newPage();
  context.on("page", (p) => { page = p; });

  console.log(`wbop v${VERSION} serving (PID ${process.pid})`);
  console.log(`  socket:      ${SOCK}`);
  console.log(`  profile:     ${BROWSER_DATA}`);
  console.log(`  downloads:   ${DOWNLOADS}`);
  console.log(`  screenshots: ${SCREENSHOTS}`);
  console.log(`  viewport:    ${VW}x${VH}`);

  async function handle(parsed) {
    const { cmd } = parsed;

    const pages = context.pages();
    if (pages.length > 0 && !pages.includes(page)) {
      page = pages[pages.length - 1];
    }

    switch (cmd) {
      case "goto": {
        try { await page.goto(parsed.url, { waitUntil: "commit", timeout: 30000 }); }
        catch (e) { /* SPA redirects often abort */ }
        await page.waitForTimeout(parsed.wait || 2000);
        return { ok: true, url: page.url() };
      }
      case "screenshot": {
        const name = parsed.name || `page-${Date.now()}`;
        const file = join(SCREENSHOTS, `${name}.png`);
        await page.screenshot({ path: file, fullPage: parsed.fullPage !== false });
        return { ok: true, file };
      }
      case "html": {
        const sel = parsed.selector || "body";
        const maxLen = parsed.maxLength || 50000;
        let html = await page.locator(sel).first().evaluate(e => e.outerHTML);
        const truncated = html.length > maxLen;
        if (truncated) html = html.slice(0, maxLen);
        return { ok: true, html, truncated };
      }
      case "text": {
        const sel = parsed.selector || "body";
        return { ok: true, text: await page.locator(sel).first().innerText() };
      }
      case "click": {
        await page.locator(parsed.selector).first().click();
        if (parsed.wait) await page.waitForTimeout(parsed.wait);
        return { ok: true, clicked: parsed.selector };
      }
      case "type": {
        await page.locator(parsed.selector).first().fill(parsed.text);
        return { ok: true, typed: parsed.selector };
      }
      case "press": {
        await page.keyboard.press(parsed.key);
        return { ok: true, pressed: parsed.key };
      }
      case "download": {
        const [dl] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          page.locator(parsed.selector).first().click(),
        ]);
        const file = join(DOWNLOADS, dl.suggestedFilename());
        await dl.saveAs(file);
        return { ok: true, file, filename: dl.suggestedFilename() };
      }
      case "wait": {
        await page.locator(parsed.selector).first().waitFor({ timeout: parsed.timeout || 30000 });
        return { ok: true, found: parsed.selector };
      }
      case "eval": {
        const result = await page.evaluate(parsed.js);
        return { ok: true, result };
      }
      case "url": {
        return { ok: true, url: page.url() };
      }
      case "tabs": {
        return { ok: true, tabs: context.pages().map(p => p.url()) };
      }
      case "tab": {
        const pages = context.pages();
        if (parsed.index >= 0 && parsed.index < pages.length) {
          page = pages[parsed.index];
          return { ok: true, url: page.url() };
        }
        return { ok: false, error: `tab ${parsed.index} not found, have ${pages.length}` };
      }
      case "close": {
        setTimeout(async () => {
          await context.close();
          server.close();
          try { unlinkSync(SOCK); } catch {}
          process.exit(0);
        }, 100);
        return { ok: true, msg: "closing" };
      }
      default:
        return { ok: false, error: `unknown command: ${cmd}` };
    }
  }

  const server = createServer((conn) => {
    let data = "";
    let handled = false;
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      data += chunk;
      if (!handled && data.includes("\n")) {
        handled = true;
        const line = data.split("\n")[0];
        (async () => {
          try {
            const parsed = JSON.parse(line.trim());
            const result = await handle(parsed);
            conn.end(JSON.stringify(result) + "\n");
          } catch (err) {
            conn.end(JSON.stringify({ ok: false, error: err.message }) + "\n");
          }
        })();
      }
    });
  });

  server.listen(SOCK, () => console.log(`Listening on ${SOCK}`));

  function cleanup() {
    context.close().catch(() => {});
    server.close();
    try { unlinkSync(SOCK); } catch {}
    process.exit(0);
  }
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
