/**
 * Display environment management for wbop.
 *
 * When no X display is available (headless VM, SSH session, etc.), this module
 * spins up Xvfb + i3 + x11vnc so the headed Chromium browser has somewhere to
 * render. Everything is torn down cleanly when the returned cleanup() is called.
 */

import { execFileSync, spawn } from "child_process";
import { writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createInterface } from "readline";

// ─── Dependency check ─────────────────────────────────────────────────────────

const REQUIRED_DEPS = [
  { bin: "Xvfb",   pkg: "xvfb" },
  { bin: "i3",     pkg: "i3-wm" },
  { bin: "x11vnc", pkg: "x11vnc" },
];

export function hasWorkingDisplay() {
  const d = process.env.DISPLAY;
  if (!d) return false;
  const num = d.replace(/^:/, "").replace(/\..*/, "");
  return existsSync(`/tmp/.X11-unix/X${num}`);
}

export function findMissingDeps() {
  return REQUIRED_DEPS.filter(({ bin }) => {
    try {
      execFileSync("which", [bin], { stdio: "pipe" });
      return false;
    } catch {
      return true;
    }
  });
}

async function confirm(msg) {
  // Non-interactive (piped stdin): default yes
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(msg, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== "n");
    });
  });
}

export async function installMissing(missing) {
  const pkgNames = missing.map((d) => d.pkg);
  const ok = await confirm(
    `wbop: no display found. Need to install ${pkgNames.join(", ")}. Install? [Y/n] `,
  );
  if (!ok) {
    console.error("wbop: cannot start without a display environment.");
    process.exit(1);
  }
  console.error(`wbop: installing ${pkgNames.join(" ")}…`);
  try {
    execFileSync("sudo", ["apt-get", "update", "-qq"], { stdio: "inherit" });
    execFileSync("sudo", ["apt-get", "install", "-y", "-qq", ...pkgNames], {
      stdio: "inherit",
    });
  } catch (e) {
    console.error(`wbop: failed to install packages: ${e.message}`);
    process.exit(1);
  }
}

// ─── Display helpers ──────────────────────────────────────────────────────────

export function findFreeDisplay() {
  for (let n = 99; n < 200; n++) {
    if (!existsSync(`/tmp/.X${n}-lock`)) return `:${n}`;
  }
  throw new Error("wbop: no free X display found (:99–:199 all in use)");
}

export function i3Config() {
  return `# i3 config file (v4)
# wbop managed — minimal, no wasted space

font pango:monospace 8
default_border none
default_floating_border normal
hide_edge_borders both
focus_follows_mouse no

bar {
    mode invisible
}

# Float browser popups and dialogs
for_window [window_role="pop-up"] floating enable
for_window [window_role="dialog"] floating enable
for_window [window_role="alert"] floating enable
for_window [window_type="dialog"] floating enable
for_window [window_type="popup_menu"] floating enable
for_window [window_type="splash"] floating enable
`;
}

export async function waitForDisplay(display, timeoutMs) {
  const num = display.replace(/^:/, "").replace(/\..*/, "");
  const sock = `/tmp/.X11-unix/X${num}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(sock)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`wbop: Xvfb on ${display} did not start within ${timeoutMs}ms`);
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Ensure a working X display exists.
 *
 * If DISPLAY already points to a live X server, returns immediately with
 * managed: false.  Otherwise starts Xvfb + i3 + x11vnc and returns a handle
 * whose cleanup() tears everything down.
 *
 * @param {{ width: number, height: number }} size  Virtual screen resolution
 * @param {string|null} vncPassword                 VNC password (null = no auth)
 * @returns {Promise<{ display: string, managed: boolean, vncPort: number|null, cleanup: () => void }>}
 */
export async function ensureDisplay(size, vncPassword) {
  if (hasWorkingDisplay()) {
    return { display: process.env.DISPLAY, managed: false, vncPort: null, cleanup() {} };
  }

  // Check & install deps if needed
  const missing = findMissingDeps();
  if (missing.length) await installMissing(missing);

  const display = findFreeDisplay();
  const procs = [];

  // Write a temporary i3 config
  const tmpDir = join(tmpdir(), `wbop-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  const i3ConfigPath = join(tmpDir, "i3-config");
  writeFileSync(i3ConfigPath, i3Config());

  // ── Xvfb ──
  const xvfb = spawn(
    "Xvfb",
    [display, "-screen", "0", `${size.width}x${size.height}x24`],
    { stdio: "ignore" },
  );
  procs.push(xvfb);
  await waitForDisplay(display, 5000);

  const env = { ...process.env, DISPLAY: display };

  // ── i3 ──
  const i3 = spawn("i3", ["-c", i3ConfigPath], { stdio: "ignore", env });
  procs.push(i3);

  // ── x11vnc ──
  const vncPort = 5900;
  const vncArgs = [
    "-display", display,
    "-forever",
    "-shared",
    "-rfbport", String(vncPort),
    "-noxdamage",
    "-xkb",
  ];
  if (vncPassword) {
    vncArgs.push("-passwd", vncPassword);
  } else {
    vncArgs.push("-nopw");
  }
  const vnc = spawn("x11vnc", vncArgs, { stdio: "ignore", env });
  procs.push(vnc);

  // Give i3 + vnc a moment to initialise
  await new Promise((r) => setTimeout(r, 500));

  process.env.DISPLAY = display;

  function cleanup() {
    for (const p of [...procs].reverse()) {
      try { p.kill("SIGTERM"); } catch {}
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  return { display, managed: true, vncPort, cleanup };
}
