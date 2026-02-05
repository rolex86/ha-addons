const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/data";
const CACHE_PATH = path.join(DATA_DIR, "cache", "spotify_search_cache.json");

let _store = null;
let _dirty = false;

function nowMs() {
  return Date.now();
}

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function ensureLoaded() {
  if (_store) return;
  const loaded = readJsonSafe(CACHE_PATH, null);
  if (
    loaded &&
    typeof loaded === "object" &&
    loaded.version === 1 &&
    loaded.items &&
    typeof loaded.items === "object"
  ) {
    _store = loaded;
    if (typeof _store.updated_at !== "number") _store.updated_at = 0;
  } else {
    _store = {
      version: 1,
      updated_at: 0,
      items: {}, // { key: { id, ts } }
    };
  }
}

function getByKey(key, ttlMs) {
  if (!key) return null;
  ensureLoaded();
  const ent = _store.items[key];
  if (!ent) return null;

  const ts = Number(ent.ts || 0);
  if (ttlMs != null && ttlMs > 0 && ts > 0) {
    if (nowMs() - ts > ttlMs) {
      delete _store.items[key];
      _dirty = true;
      return null;
    }
  }

  const id = ent.id ? String(ent.id) : "";
  return id || null;
}

function setByKey(key, trackId) {
  if (!key || !trackId) return false;
  ensureLoaded();
  _store.items[key] = { id: String(trackId), ts: nowMs() };
  _store.updated_at = nowMs();
  _dirty = true;
  return true;
}

function pruneExpired(ttlMs) {
  if (!ttlMs || ttlMs <= 0) return;
  ensureLoaded();
  const cutoff = nowMs() - ttlMs;
  let removed = 0;
  for (const [k, v] of Object.entries(_store.items)) {
    const ts = Number(v?.ts || 0);
    if (ts > 0 && ts < cutoff) {
      delete _store.items[k];
      removed += 1;
    }
  }
  if (removed > 0) _dirty = true;
}

function saveSearchCache({ ttlMs } = {}) {
  ensureLoaded();
  if (!_dirty) return false;

  try {
    pruneExpired(ttlMs);
  } catch {
    // ignore prune issues
  }

  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  const tmp = `${CACHE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), "utf8");
  fs.renameSync(tmp, CACHE_PATH);
  _dirty = false;
  return true;
}

module.exports = {
  getByKey,
  setByKey,
  saveSearchCache,
};
