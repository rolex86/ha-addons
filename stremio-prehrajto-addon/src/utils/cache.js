import fs from "node:fs";
import path from "node:path";
import { LRUCache } from "lru-cache";
import { ENV } from "../env.js";

const ttlMs = ENV.CACHE_TTL_SECONDS * 1000;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const CACHE_DIR = path.join(DATA_DIR, "stremio-prehrajto");
const CACHE_FILE = path.join(CACHE_DIR, "cache.json");
const PERSIST_DEBOUNCE_MS = 1500;

const memoryCache = new LRUCache({
  max: 500,
  ttl: ttlMs,
});

let persistTimer = null;

function safeJsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function persistNow() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const now = Date.now();
    const items = [];

    for (const key of memoryCache.keys()) {
      const value = memoryCache.get(key);
      if (value === undefined) continue;

      const ttl = memoryCache.getRemainingTTL(key);
      if (!Number.isFinite(ttl) || ttl <= 0) continue;

      const cloned = safeJsonClone(value);
      if (cloned === undefined) continue;

      items.push({
        key,
        value: cloned,
        expiresAt: now + ttl,
      });
    }

    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify(
        {
          version: 1,
          savedAt: new Date().toISOString(),
          items,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`Cache persistence failed: ${String(e?.message || e)}`);
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

function loadPersistedCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;

    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];

    const now = Date.now();
    for (const item of items) {
      if (!item || typeof item.key !== "string") continue;

      const expiresAt = Number(item.expiresAt);
      if (!Number.isFinite(expiresAt)) continue;

      const remainingTtl = expiresAt - now;
      if (remainingTtl <= 0) continue;

      memoryCache.set(item.key, item.value, { ttl: remainingTtl });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`Cache load failed, using empty cache: ${String(e?.message || e)}`);
  }
}

function flushAndExit(code = 0) {
  try {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistNow();
  } finally {
    process.exit(code);
  }
}

loadPersistedCache();

process.on("beforeExit", () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistNow();
});
process.on("SIGINT", () => flushAndExit(0));
process.on("SIGTERM", () => flushAndExit(0));

export const cache = {
  get(key) {
    return memoryCache.get(key);
  },

  set(key, value, options) {
    const out = memoryCache.set(key, value, options);
    schedulePersist();
    return out;
  },

  delete(key) {
    const out = memoryCache.delete(key);
    if (out) schedulePersist();
    return out;
  },

  clear() {
    memoryCache.clear();
    schedulePersist();
  },

  has(key) {
    return memoryCache.has(key);
  },
};

// Small helper for promise caching
export async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const val = await fn();
  cache.set(key, val);
  return val;
}
