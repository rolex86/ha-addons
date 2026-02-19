const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function parseLevel(raw) {
  const v = String(raw || "debug").toLowerCase().trim();
  if (v === "warning") return "warn";
  if (v in LEVELS) return v;
  return "debug";
}

const ACTIVE_LEVEL = parseLevel(process.env.LOG_LEVEL);

function canLog(level) {
  return LEVELS[level] <= LEVELS[ACTIVE_LEVEL];
}

function nowIso() {
  return new Date().toISOString();
}

function trimText(text, max = 500) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

function safeJson(value) {
  try {
    return trimText(JSON.stringify(value), 1200);
  } catch {
    return trimText(String(value), 1200);
  }
}

function print(level, msg, meta) {
  const line = `[${nowIso()}] [${level.toUpperCase()}] ${msg}`;
  if (meta === undefined) {
    // eslint-disable-next-line no-console
    console.log(line);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`${line} ${safeJson(meta)}`);
}

export const log = {
  debug(msg, meta) {
    if (!canLog("debug")) return;
    print("debug", msg, meta);
  },

  info(msg, meta) {
    if (!canLog("info")) return;
    print("info", msg, meta);
  },

  warn(msg, meta) {
    if (!canLog("warn")) return;
    print("warn", msg, meta);
  },

  error(msg, meta) {
    if (!canLog("error")) return;
    print("error", msg, meta);
  },
};

export function elapsedMs(startMs) {
  return Math.max(0, Date.now() - Number(startMs || 0));
}

export function sanitizeUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const u = new URL(String(rawUrl));
    return `${u.origin}${u.pathname}`;
  } catch {
    return trimText(String(rawUrl), 220);
  }
}

export function summarizeId(rawId) {
  const s = String(rawId || "");
  if (s.length <= 80) return s;
  return `${s.slice(0, 48)}...${s.slice(-16)}`;
}

export function errorMeta(err) {
  const e = err || {};
  return {
    name: e.name || "Error",
    message: String(e.message || e),
    status: e.status || undefined,
  };
}

