// app/lib/genre_catalog.js
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");

const CATALOG_PATH = path.join(DATA_DIR, "genres_catalog.json");

let _loaded = false;
let _dirty = false;
let _catalog = null;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function emptyCatalog() {
  return {
    version: 1,
    updated_at: nowSec(),
    genres: {},
  };
}

function loadCatalog() {
  if (_loaded && _catalog) return _catalog;

  try {
    const raw = fs.readFileSync(CATALOG_PATH, "utf8");
    const parsed = raw ? JSON.parse(raw) : null;

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      parsed.genres &&
      typeof parsed.genres === "object"
    ) {
      _catalog = parsed;
    } else {
      _catalog = emptyCatalog();
    }
  } catch (e) {
    // missing file / invalid json => start fresh
    _catalog = emptyCatalog();
  }

  _loaded = true;
  _dirty = false;
  return _catalog;
}

function observeGenres(genres) {
  if (!Array.isArray(genres) || genres.length === 0) return;

  const cat = loadCatalog();
  const ts = nowSec();

  // normalize + dedupe within batch
  const batch = new Set();
  for (const g of genres) {
    const s = String(g ?? "")
      .trim()
      .toLowerCase();
    if (!s) continue;
    batch.add(s);
  }

  if (batch.size === 0) return;

  for (const key of batch) {
    const existing = cat.genres[key];
    if (!existing) {
      cat.genres[key] = { count: 1, first_seen: ts, last_seen: ts };
      _dirty = true;
      continue;
    }

    // defensive: keep format stable even if old file is weird
    if (typeof existing.count !== "number") existing.count = 0;
    if (typeof existing.first_seen !== "number") existing.first_seen = ts;

    existing.count += 1;
    existing.last_seen = ts;
    _dirty = true;
  }
}

function flushCatalog() {
  if (!_loaded || !_catalog) loadCatalog();
  if (!_dirty) return false;

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _catalog.updated_at = nowSec();
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(_catalog, null, 2), "utf8");
    _dirty = false;
    return true;
  } catch (e) {
    // do not throw (we don't want to break a run because of disk write)
    return false;
  }
}

module.exports = {
  CATALOG_PATH,
  loadCatalog,
  observeGenres,
  flushCatalog,
};
