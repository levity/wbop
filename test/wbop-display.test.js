import test from "node:test";
import assert from "node:assert/strict";
import { i3Config, findFreeDisplay } from "../wbop-display.js";

test("i3Config returns a valid config with floating rules", () => {
  const cfg = i3Config();
  assert.ok(cfg.includes("default_border none"));
  assert.ok(cfg.includes("mode invisible"));
  assert.ok(cfg.includes('window_role="pop-up"'));
  assert.ok(cfg.includes('window_role="dialog"'));
  assert.ok(cfg.includes('window_type="dialog"'));
  assert.ok(cfg.includes("floating enable"));
  assert.ok(cfg.includes("focus_follows_mouse no"));
});

test("findFreeDisplay returns a display string like :NN", () => {
  const d = findFreeDisplay();
  assert.match(d, /^:\d+$/);
});
