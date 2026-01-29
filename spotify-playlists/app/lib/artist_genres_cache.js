const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/data";
const ARTISTS_PATH = path.join(DATA_DIR, "artist_genres.json");

// in-memory singleton
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

  const loaded = readJsonSafe(ARTISTS_PATH, null);
  if (
    loaded &&
    typeof loaded === "object" &&
    loaded.version === 1 &&
    loaded.artists &&
    typeof loaded.artists === "object"
  ) {
    _store = loaded;
    if (typeof _store.updated_at !== "number") _store.updated_at = 0;
  } else {
    _store = {
      version: 1,
      updated_at: 0,
      artists: {}, // { "artistId": { genres:[...], first_seen, last_seen } }
    };
  }
}

function loadArtistGenresStore() {
  ensureLoaded();
  return _store;
}

// Vrátí Map(id -> genres[])
function loadArtistGenresMap() {
  ensureLoaded();
  const m = new Map();
  for (const [id, v] of Object.entries(_store.artists)) {
    const gs = Array.isArray(v?.genres) ? v.genres : [];
    m.set(id, gs);
  }
  return m;
}

// Slije do store vše z Map cache (id -> genres[])
function mergeFromGenresMap(cacheMap) {
  ensureLoaded();
  if (!cacheMap || typeof cacheMap.get !== "function") return 0;

  const ts = nowMs();
  let changed = 0;

  for (const [id, genres] of cacheMap.entries()) {
    if (!id) continue;
    const gs = Array.isArray(genres) ? genres.filter(Boolean) : [];
    if (!gs.length) continue;

    const existing = _store.artists[id];
    if (!existing) {
      _store.artists[id] = { genres: gs, first_seen: ts, last_seen: ts };
      changed += 1;
      continue;
    }

    // update genres if different (or empty)
    const old = Array.isArray(existing.genres) ? existing.genres : [];
    const same = old.length === gs.length && old.every((x, i) => x === gs[i]);

    if (!same) {
      existing.genres = gs;
      changed += 1;
    }

    if (!existing.first_seen) existing.first_seen = ts;
    existing.last_seen = ts;
  }

  if (changed > 0) {
    _store.updated_at = ts;
    _dirty = true;
  }

  return changed;
}

function saveArtistGenresStore() {
  ensureLoaded();
  if (!_dirty) return false;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tmp = `${ARTISTS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), "utf8");
  fs.renameSync(tmp, ARTISTS_PATH);

  _dirty = false;
  return true;
}

module.exports = {
  DATA_DIR,
  ARTISTS_PATH,
  loadArtistGenresStore,
  loadArtistGenresMap,
  mergeFromGenresMap,
  saveArtistGenresStore,
};
