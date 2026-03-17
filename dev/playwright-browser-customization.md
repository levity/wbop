# Playwright Browser Customization

> ChatGPT shared conversation — [original link](https://chatgpt.com/share/69b85a24-7724-8007-9732-a74faa69ebd4)

---

## How much does Playwright customize the browser?

Less than you'd think. Playwright mostly rides on top of real browsers; the "customization" is targeted plumbing, not a forked browser. Three layers:

1. **Control channel** — Playwright talks to browsers through existing debugging protocols (CDP for Chromium, patched remote protocols for Firefox/WebKit). It's closer to "remote controlling" than "embedding."
2. **Thin browser patches** — For Firefox and WebKit, Playwright ships patched builds for deterministic input events, better isolation, and exposing missing protocol hooks. Chromium usually just needs launch flags (disable automation banners, control sandboxing, etc.).
3. **Context abstraction** — The real trick. `BrowserContext` = lightweight, isolated session (cookies, storage, cache). Multiple contexts per browser process. This avoids spinning up full browsers.

It does **not** change layout engines, JS engines, or "fake" rendering like jsdom. Where the illusion breaks: popups, extensions, GPU/media in headless, and timing/auto-waiting differs from real user race conditions.

**Mental model:** Playwright is a deterministic orchestration layer over mostly unmodified browsers, with just enough surgical patching to make them behave like obedient lab instruments.

---

## Controlling your normal browser

You can attach to an already-running Chrome/Edge via `connectOverCDP`, but it's Chromium-only and janky. You need the browser launched with `--remote-debugging-port`. The catch: you lose Playwright's clean isolated context model — you get the real human profile with all its cached state, extensions, and weirdness. For ad hoc personal-browser driving it needs very little modification. For robust automation, it wants its own launched browser — "your normal browser is a swamp full of historical sins."

---

## Does it work with Arc?

No, not reliably. Arc is Chromium-based but doesn't expose a stable remote debugging interface. No official support, CDP attach is flaky/unavailable, and context/isolation features won't work correctly.

---

## Can an extension shim CDP?

No. CDP lives below the extension layer — it talks directly to the browser process. Extensions sit inside the page/runtime sandbox and can't open or expose a remote debugging port. The closest thing is `chrome.debugger`, but it requires user permission per tab, has limited domains, and no multi-target orchestration. "You're trying to emulate a kernel-level interface from userland."

---

## Extension-based approach for opportunistic automation

For "in the wild" one-off tasks while doing normal browsing, you need three primitives: **observe, act, report**. An extension can give you all three:

- **Observe:** Content scripts can read/traverse DOM, observe mutations, extract data
- **Act:** `element.click()`, dispatch events, fill inputs
- **Report:** `chrome.tabs.captureVisibleTab()` for screenshots, message passing to a local agent

Where it breaks vs Playwright: non-deterministic timing, navigation kills script context, cross-origin iframes are opaque, no network interception, no clean context isolation.

**Architecture that works:** content script (execution engine) → background script (router + state) → local agent (LLM brains), connected via WebSocket. The subtle trick: **don't try to mirror Playwright's API.** Lean into higher-level, lossy operations — "click the visible button with text X" rather than precise CSS selectors. Semantic targeting survives better in an unstable environment.

---

## Why you shouldn't mirror Playwright's API

Playwright's API encodes guarantees your setup cannot provide:

- **Selectors:** Playwright's `click()` auto-waits, retries across re-renders, fails with defined timeouts. Your `querySelector + click()` is a best-effort poke with no retry semantics.
- **Navigation:** Playwright tracks it as a first-class event. Navigation in your extension destroys the content script — you reattach after the fact and infer it heuristically.
- **Isolation:** Playwright gives clean state. You're inside a long-lived polluted profile.
- **Input fidelity:** Playwright injects at the browser level (trusted events). Your DOM-level events are sometimes ignored by apps.

**The deeper issue:** Playwright is a deterministic state machine over the browser. Your system is a reactive probe inside a non-deterministic system you don't control. Copying the API creates a semantic mismatch — same shape, different physics. Higher-level semantic ops work because they match your actual control surface: *observe what's visible → attempt action → verify outcome → retry*.

---

## Extension frameworks: WXT vs Plasmo

For building this extension, there are two modern frameworks to consider:

### WXT

- **Framework-agnostic:** Vue, React, Svelte, vanilla JS — pick your poison
- **Lightweight:** Less overhead, explicit entrypoints
- **Module system:** Auto-imports, built-in bundling with Vite
- **Content scripts:** Easy to define, great DX
- **Documentation:** Excellent, comprehensive

### Plasmo

- **React-first:** Better if you want React batteries included
- **More opinionated:** More "magic," less explicit
- **Itero TestBed:** SaaS for beta testing extensions
- **BPP:** GitHub action for publishing to stores

### Recommendation

**WXT** is the better choice for this use case:

1. We don't need React — vanilla JS is sufficient
2. WXT's explicit entrypoints map cleanly to content script + background script architecture
3. Less overhead and more control
4. Content scripts are first-class citizens
5. Great messaging utilities built-in

---

## Implementation: Sidekick

A browser extension that exposes a WebSocket for bi-directional communication with a local agent, enabling opportunistic automation "in the wild."

### Architecture

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│   Local Agent   │ ◄────────────────► │   Background    │
│   (LLM brains)  │                     │   Script        │
└─────────────────┘                     └────────┬────────┘
                                                 │
                                        runtime.sendMessage
                                                 │
                                                 ▼
                                        ┌─────────────────┐
                                        │  Content Script │
                                        │  (DOM actions)  │
                                        └─────────────────┘
```

### Protocol

Three primitives:

- **observe** → Return DOM snapshot (structured, not raw HTML)
- **act** → `{selector, action, params}` — semantic operations
- **screenshot** → Return base64 image of viewport

### Key design decisions

1. **Semantic targeting:** "click button with text X" not `querySelector("#submit")`
2. **Probabilistic success:** Operations can fail; agent retries based on feedback
3. **No Playwright API mirroring:** Match the actual control surface
4. **Feedback loops:** observe → act → verify → retry
