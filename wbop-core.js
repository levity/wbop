export function num(s) {
  const n = parseInt(s, 10);
  return isNaN(n) ? undefined : n;
}

export function parseExtra(pairs) {
  const obj = {};
  for (let i = 0; i < pairs.length; i += 2) {
    if (pairs[i + 1] !== undefined) obj[pairs[i]] = pairs[i + 1];
  }
  return obj;
}

export function buildMessage(args) {
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
    default:            return { cmd, ...parseExtra(args.slice(1)) };
  }
}

export function parseWxH(s) {
  const m = /^([1-9]\d*)x([1-9]\d*)$/i.exec(s || "");
  if (!m) return null;
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

export function defaultWindowSizeForScreen(screen) {
  return {
    width: Math.max(800, Math.floor(screen.width * 0.95)),
    height: Math.max(600, Math.floor(screen.height * 0.95)),
  };
}

export function launchArgsForWindowSize(windowSize) {
  return [
    "--no-sandbox",
    "--disable-blink-features=AutomationControlled",
    `--window-size=${windowSize.width},${windowSize.height}`,
  ];
}
