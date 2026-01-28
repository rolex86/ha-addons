// app/lib/genre_catalog.js
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/data";
const CATALOG_PATH = path.join(DATA_DIR, "genres_catalog.json");

// in-memory singleton
let _catalog = null;
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

function normalizeGenreName(g) {
  const s = String(g || "").trim();
  if (!s) return null;
  // Spotify genres bývají lowercase, ale pro jistotu normalizujeme key
  return s.toLowerCase();
}

function ensureCatalogLoaded() {
  if (_catalog) return;

  const loaded = readJsonSafe(CATALOG_PATH, null);

  // validace / default
  if (
    loaded &&
    typeof loaded === "object" &&
    loaded.version === 1 &&
    loaded.genres &&
    typeof loaded.genres === "object"
  ) {
    _catalog = loaded;
    if (typeof _catalog.updated_at !== "number") _catalog.updated_at = 0;
  } else {
    _catalog = {
      version: 1,
      updated_at: 0,
      genres: {}, // { "trance": {count, first_seen, last_seen} }
    };
  }
}

function loadCatalog() {
  ensureCatalogLoaded();
  return _catalog;
}

function observeGenres(genresArray) {
  ensureCatalogLoaded();
  const ts = nowMs();

  if (!Array.isArray(genresArray) || genresArray.length === 0) return 0;

  let addedOrUpdated = 0;

  for (const g of genresArray) {
    const key = normalizeGenreName(g);
    if (!key) continue;

    const existing = _catalog.genres[key];
    if (!existing) {
      _catalog.genres[key] = { count: 1, first_seen: ts, last_seen: ts };
      addedOrUpdated += 1;
      continue;
    }

    // update
    existing.count = Number(existing.count || 0) + 1;
    if (!existing.first_seen) existing.first_seen = ts;
    existing.last_seen = ts;
    addedOrUpdated += 1;
  }

  if (addedOrUpdated > 0) {
    _catalog.updated_at = ts;
    _dirty = true;
  }

  return addedOrUpdated;
}

function queryCatalog({ limit = 200, min_count = 1, q = "" } = {}) {
  ensureCatalogLoaded();

  const lim = Math.max(1, Math.min(5000, Number(limit) || 200));
  const minc = Math.max(1, Number(min_count) || 1);
  const qs = String(q || "")
    .trim()
    .toLowerCase();

  const items = Object.entries(_catalog.genres)
    .map(([name, v]) => ({
      name,
      count: Number(v?.count || 0),
      first_seen: Number(v?.first_seen || 0),
      last_seen: Number(v?.last_seen || 0),
    }))
    .filter((x) => x.count >= minc)
    .filter((x) => (qs ? x.name.includes(qs) : true))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    })
    .slice(0, lim);

  return {
    ok: true,
    version: _catalog.version,
    updated_at: _catalog.updated_at,
    total_genres: Object.keys(_catalog.genres).length,
    items,
  };
}

function saveCatalog() {
  ensureCatalogLoaded();
  if (!_dirty) return false;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tmp = `${CATALOG_PATH}.tmp`;
  const data = JSON.stringify(_catalog, null, 2);

  // atomic-ish write
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, CATALOG_PATH);

  _dirty = false;
  return true;
}

module.exports = {
  DATA_DIR,
  CATALOG_PATH,
  loadCatalog,
  observeGenres,
  queryCatalog,
  saveCatalog,
};
