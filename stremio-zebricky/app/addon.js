const { addonBuilder } = require("stremio-addon-sdk");
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");

const PAGE_SIZE = 100;

const ROOT = __dirname;
const LIST_DIR = path.join(ROOT, "lists");
const CONFIG_PATH = path.join(ROOT, "config", "lists.trakt.json");

const META_PREFIX = "cztt:"; // jen pro MOVIES
const CACHE_TTL_MS = Number(process.env.LISTS_CACHE_TTL_MS || 60_000);

let configCache = null;

let listsById = new Map();
let itemByImdb = new Map();
let listsLoadedAt = 0;
let loadingPromise = null;

function readJsonSafeSync(p, fallback = null) {
  try {
    const raw = fssync.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function readJsonSafe(p, fallback = null) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function buildCatalogsFromConfig(cfg) {
  const base = (cfg.lists || []).map((l) => ({
    type: l.type || "movie",
    id: l.id,
    name: l.name,
    extra: [{ name: "skip", isRequired: false }],
  }));

  const sp = cfg.smartPicks;
  const profiles = Array.isArray(sp?.profiles) ? sp.profiles : [];
  const smart = (sp?.enabled ? profiles : [])
    .filter(
      (p) => p?.id && p?.name && (p.type === "movie" || p.type === "series"),
    )
    .map((p) => ({
      type: p.type,
      id: p.id,
      name: p.name,
      extra: [{ name: "skip", isRequired: false }],
    }));

  return [...base, ...smart];
}

function getImdbFromPrefixedId(prefixed) {
  if (!prefixed || typeof prefixed !== "string") return null;
  if (!prefixed.startsWith(META_PREFIX)) return null;
  return prefixed.slice(META_PREFIX.length);
}

async function loadAllListsFromDisk() {
  const newListsById = new Map();
  const newItemByImdb = new Map();

  let files = [];
  try {
    files = (await fs.readdir(LIST_DIR)).filter((f) => f.endsWith(".json"));
  } catch (e) {
    console.error(`[cache] LIST_DIR missing? ${LIST_DIR} (${e?.message || e})`);
    files = [];
  }

  for (const f of files) {
    try {
      const raw = await fs.readFile(path.join(LIST_DIR, f), "utf8");
      const json = JSON.parse(raw);
      const id = json?.id || path.basename(f, ".json");
      const items = Array.isArray(json?.items) ? json.items : [];

      newListsById.set(id, items);

      for (const it of items) {
        if (
          it?.imdb &&
          typeof it.imdb === "string" &&
          it.imdb.startsWith("tt")
        ) {
          newItemByImdb.set(it.imdb, it);
        }
      }
    } catch (e) {
      console.error(`[cache] Failed to load ${f}:`, e?.message || e);
    }
  }

  listsById = newListsById;
  itemByImdb = newItemByImdb;
  listsLoadedAt = Date.now();
  console.log(
    `[cache] Loaded lists=${listsById.size}, indexed items=${itemByImdb.size}`,
  );
}

async function ensureListsFresh(force = false) {
  const now = Date.now();
  const expired = now - listsLoadedAt > CACHE_TTL_MS;
  if (!force && listsLoadedAt > 0 && !expired) return;

  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      await loadAllListsFromDisk();
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

// --- build manifest SYNC at startup (so we can export AddonInterface instance) ---
configCache = readJsonSafeSync(CONFIG_PATH, null);

if (!configCache?.lists?.length) {
  throw new Error(`Config is missing/empty: ${CONFIG_PATH}`);
}

const manifest = {
  id: "org.vlastni.zebricky.cz",
  version: "0.0.6",
  name: "Vlastní žebříčky (CZ Classics)",
  description: "Katalogy generované z configu + CZ meta pro filmy.",
  website:
    "https://github.com/rolex86/ha-addons/tree/master/stremio-zebricky#readme",
  resources: [
    "catalog",
    { name: "meta", types: ["movie"], idPrefixes: [META_PREFIX] },
  ],
  types: ["movie", "series"],
  catalogs: buildCatalogsFromConfig(configCache),
};

const builder = new addonBuilder(manifest);

// --- handlers ---
builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
  await ensureListsFresh(false);

  const items = listsById.get(id) || [];
  const skip = Number(extra.skip || 0) || 0;
  const page = items.slice(skip, skip + PAGE_SIZE);

  if (type === "movie") {
    const metas = page
      .filter((it) => it?.imdb && String(it.imdb).startsWith("tt"))
      .map((it) => ({
        id: `${META_PREFIX}${it.imdb}`, // prefixed => detail přes náš meta handler
        type: "movie",
        name: it.name,
        releaseInfo: it.releaseInfo || it.year,
        poster: it.poster,
        background: it.background,
        genres: it.genres,
        description: it.description,
      }));
    return { metas };
  }

  if (type === "series") {
    const metas = page
      .filter((it) => it?.imdb && String(it.imdb).startsWith("tt"))
      .map((it) => ({
        id: it.imdb, // bez prefixu => meta typicky řeší Cinemeta
        type: "series",
        name: it.name,
        releaseInfo: it.releaseInfo || it.year,
        poster: it.poster,
        background: it.background,
        genres: it.genres,
        description: it.description,
      }));
    return { metas };
  }

  return { metas: [] };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "movie") return { meta: null };
  if (!id || typeof id !== "string" || !id.startsWith(META_PREFIX))
    return { meta: null };

  await ensureListsFresh(false);

  const imdbId = getImdbFromPrefixedId(id);
  const hit = imdbId ? itemByImdb.get(imdbId) : null;
  if (!hit) return { meta: null };

  return {
    meta: {
      id, // prefixed id
      type: "movie",
      name: hit.name,
      poster: hit.poster,
      background: hit.background,
      description: hit.description,
      releaseInfo: hit.releaseInfo || hit.year,
      genres: hit.genres || [],

      // stream addony mapují podle video id (tt...)
      videos: [{ id: imdbId, title: hit.name }],
      behaviorHints: { defaultVideoId: imdbId },

      imdbRating: hit.imdbRating,
      runtime: hit.runtime,
    },
  };
});

// export AddonInterface INSTANCE (tohle chce serveHTTP!)
module.exports = builder.getInterface();
