import fs from "node:fs";
import path from "node:path";
import { LRUCache } from "lru-cache";
import { ENV } from "../env.js";

const ttlMs = ENV.CACHE_TTL_SECONDS * 1000;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const CACHE_DIR = path.join(DATA_DIR, "stremio-prehrajto");
const CACHE_FILE = path.join(CACHE_DIR, "cache.json");
const PERSIST_ON_CHANGE = false;
const PERSIST_DEBOUNCE_MS = 30_000;
const PERSIST_MIN_INTERVAL_MS = 120_000;
const SHUTDOWN_PERSIST_TIMEOUT_MS = 4_000;

const memoryCache = new LRUCache({
  max: 500,
  ttl: ttlMs,
});

let persistTimer = null;
let persistInFlight = null;
let pendingPersist = false;
let lastPersistAt = 0;
let persistGeneration = 0;
let persistedGeneration = 0;
let shuttingDown = false;

function safeJsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function isDirty() {
  return persistGeneration > persistedGeneration;
}

function markDirty() {
  persistGeneration += 1;
}

async function persistNowAsync({ force = false } = {}) {
  if (!force && !isDirty()) return;

  const now = Date.now();
  if (!force && now - lastPersistAt < PERSIST_MIN_INTERVAL_MS) {
    pendingPersist = true;
    schedulePersist(PERSIST_MIN_INTERVAL_MS - (now - lastPersistAt));
    return;
  }

  if (persistInFlight) {
    pendingPersist = true;
    await persistInFlight;
    if (force && isDirty()) {
      await persistNowAsync({ force: true });
    }
    return;
  }

  const targetGeneration = persistGeneration;
  const run = (async () => {
    const snapNow = Date.now();
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
        expiresAt: snapNow + ttl,
      });
    }

    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    await fs.promises.writeFile(
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

    lastPersistAt = Date.now();
    persistedGeneration = Math.max(persistedGeneration, targetGeneration);
  })();

  persistInFlight = run;
  try {
    await run;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`Cache persistence failed: ${String(e?.message || e)}`);
  } finally {
    persistInFlight = null;
    if (pendingPersist && PERSIST_ON_CHANGE && !shuttingDown) {
      pendingPersist = false;
      schedulePersist();
    }
  }
}

function schedulePersist(delayMs = PERSIST_DEBOUNCE_MS) {
  if (!PERSIST_ON_CHANGE || shuttingDown) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNowAsync();
  }, Math.max(250, delayMs));
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

async function flushAndExit(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }

    const timeout = new Promise((resolve) =>
      setTimeout(resolve, SHUTDOWN_PERSIST_TIMEOUT_MS),
    );
    await Promise.race([persistNowAsync({ force: true }), timeout]);
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
  if (isDirty()) void persistNowAsync({ force: true });
});
process.on("SIGINT", () => {
  void flushAndExit(0);
});
process.on("SIGTERM", () => {
  void flushAndExit(0);
});

export const cache = {
  get(key) {
    return memoryCache.get(key);
  },

  set(key, value, options) {
    const out = memoryCache.set(key, value, options);
    markDirty();
    schedulePersist();
    return out;
  },

  delete(key) {
    const out = memoryCache.delete(key);
    if (out) {
      markDirty();
      schedulePersist();
    }
    return out;
  },

  clear() {
    memoryCache.clear();
    markDirty();
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
