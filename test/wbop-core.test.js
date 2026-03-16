import test from "node:test";
import assert from "node:assert/strict";
import { buildMessage, parseWxH, defaultWindowSizeForScreen, launchArgsForWindowSize, parseServeArgs } from "../wbop-core.js";

test("parseWxH parses valid sizes", () => {
  assert.deepEqual(parseWxH("1440x900"), { width: 1440, height: 900 });
  assert.deepEqual(parseWxH("1600X1200"), { width: 1600, height: 1200 });
});

test("parseWxH rejects invalid sizes", () => {
  assert.equal(parseWxH(""), null);
  assert.equal(parseWxH("1400"), null);
  assert.equal(parseWxH("0x900"), null);
  assert.equal(parseWxH("900x0"), null);
  assert.equal(parseWxH("abcx900"), null);
});

test("defaultWindowSizeForScreen uses 95% with minimums", () => {
  assert.deepEqual(defaultWindowSizeForScreen({ width: 1440, height: 900 }), { width: 1368, height: 855 });
  assert.deepEqual(defaultWindowSizeForScreen({ width: 500, height: 400 }), { width: 800, height: 600 });
});

test("launchArgsForWindowSize includes the requested window size", () => {
  assert.deepEqual(launchArgsForWindowSize({ width: 1368, height: 855 }), [
    "--no-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1368,855",
  ]);
});

test("buildMessage parses common commands", () => {
  assert.deepEqual(buildMessage(["goto", "https://example.com", "2500"]), {
    cmd: "goto",
    url: "https://example.com",
    wait: 2500,
  });

  assert.deepEqual(buildMessage(["screenshot", "home", "viewport"]), {
    cmd: "screenshot",
    name: "home",
    fullPage: false,
  });

  assert.deepEqual(buildMessage(["wait", "#app"]), {
    cmd: "wait",
    selector: "#app",
    timeout: 30000,
  });

  assert.deepEqual(buildMessage(["type", "input[name=q]", "hello", "world"]), {
    cmd: "type",
    selector: "input[name=q]",
    text: "hello world",
  });
});

test("buildMessage parses raw json and fallback key/value args", () => {
  assert.deepEqual(buildMessage(['{"cmd":"eval","js":"1+1"}']), {
    cmd: "eval",
    js: "1+1",
  });

  assert.deepEqual(buildMessage(["custom", "foo", "bar", "baz", "qux", "lonely"]), {
    cmd: "custom",
    foo: "bar",
    baz: "qux",
  });
});

// ─── parseServeArgs ───────────────────────────────────────────────────────────

test("parseServeArgs: no args", () => {
  assert.deepEqual(parseServeArgs([]), { windowSize: null, vncPassword: null });
});

test("parseServeArgs: window size only", () => {
  assert.deepEqual(parseServeArgs(["1440x900"]), { windowSize: "1440x900", vncPassword: null });
});

test("parseServeArgs: vnc password only", () => {
  assert.deepEqual(parseServeArgs(["--vnc-password", "secret"]), { windowSize: null, vncPassword: "secret" });
});

test("parseServeArgs: window size + vnc password", () => {
  assert.deepEqual(parseServeArgs(["1440x900", "--vnc-password", "pw"]), { windowSize: "1440x900", vncPassword: "pw" });
});

test("parseServeArgs: vnc password before window size", () => {
  assert.deepEqual(parseServeArgs(["--vnc-password", "pw", "1440x900"]), { windowSize: "1440x900", vncPassword: "pw" });
});

test("parseServeArgs: ignores unknown flags", () => {
  assert.deepEqual(parseServeArgs(["--unknown", "1440x900"]), { windowSize: "1440x900", vncPassword: null });
});
