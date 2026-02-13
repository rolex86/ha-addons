import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { csfd } from "node-csfd-api";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// HA persistent root
const DATA_DIR = process.env.DATA_DIR || "/data";

// default list dir + runtime/cache on /data
const DEFAULT_LIST_DIR = path.join(DATA_DIR, "lists");
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
const CACHE_DIR = path.join(RUNTIME_DIR, "enrich-cache");

// tunables
const SLEEP_MS = Number(process.env.ENRICH_SLEEP_MS || 120);
const FETCH_TIMEOUT_MS = Number(process.env.ENRICH_FETCH_TIMEOUT_MS || 15000);
const CINEMETA_UA = process.env.CINEMETA_UA || "stremio-local-addon/0.0.6";

const CACHE_TTL_DAYS = Number(process.env.ENRICH_CACHE_TTL_DAYS || 30);
const FORCE = String(process.env.ENRICH_FORCE || "").trim() === "1";
const LIGHT_MODE = String(process.env.ENRICH_LIGHT || "").trim() === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let FILES_DONE = 0;
let ITEMS_DONE = 0;
let CINEMETA_FAILS = 0;
let CSFD_FAILS = 0;
let UPDATED_POSTER = 0;
let UPDATED_DESC = 0;
let CACHE_HITS = 0;
let CACHE_MISSES = 0;
let FILES_UNCHANGED = 0;

function sha1(obj) {
  return crypto
    .createHash("sha1")
    .update(typeof obj === "string" ? obj : JSON.stringify(obj))
    .digest("hex");
}

function formatCountK(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

function csfdRatingText(rating, ratingCount) {
  if (!Number.isFinite(rating)) return "";
  const cnt = Number.isFinite(ratingCount) ? ` (${formatCountK(ratingCount)})` : "";
  return `ČSFD: ${Math.round(rating)}%${cnt}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchCinemetaMeta(type, imdbId) {
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const res = await fetchWithTimeout(url, { headers: { "user-agent": CINEMETA_UA } }, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Cinemeta ${res.status} for ${type} ${imdbId}`);
  const data = await res.json();
  return data?.meta;
}

async function findCsfdIdBySearch(name, year) {
  const q = name?.trim();
  if (!q) return null;

  const results = await csfd.search(q);
  await sleep(SLEEP_MS);

  const movies = results?.movies || [];
  if (year) {
    const exact = movies.find((m) => String(m.year) === String(year));
    if (exact?.id) return exact.id;
  }
  return movies[0]?.id || null;
}

function cachePathFor(imdbId) {
  return path.join(CACHE_DIR, `${imdbId}.json`);
}

function isFreshCache(cacheObj) {
  if (!cacheObj?.updatedAt) return false;
  const t = Date.parse(cacheObj.updatedAt);
  if (!Number.isFinite(t)) return false;
  const ageMs = Date.now() - t;
  const ttlMs = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  return ageMs >= 0 && ageMs <= ttlMs;
}

function applyCacheToItem(it, cacheObj) {
  const keys = [
    "poster", "background",
    "imdbRating", "runtime",
    "csfdId", "csfdRating", "csfdRatingCount",
    "name", "year", "genres",
    "description", "releaseInfo",
  ];
  for (const k of keys) {
    if (cacheObj[k] !== undefined && cacheObj[k] !== null && cacheObj[k] !== "") {
      it[k] = cacheObj[k];
    }
  }
}

function pickCacheFromItem(it) {
  return {
    poster: it.poster,
    background: it.background,
    imdbRating: it.imdbRating,
    runtime: it.runtime,
    csfdId: it.csfdId,
    csfdRating: it.csfdRating,
    csfdRatingCount: it.csfdRatingCount,
    name: it.name,
    year: it.year,
    genres: it.genres,
    description: it.description,
    releaseInfo: it.releaseInfo,
    updatedAt: new Date().toISOString(),
    v: 1,
  };
}

async function loadCache(imdbId) {
  try {
    const raw = await fs.readFile(cachePathFor(imdbId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCache(imdbId, cacheObj) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cachePathFor(imdbId), JSON.stringify(cacheObj, null, 2), "utf8");
}

async function enrichItem(it, listType) {
  if (!it?.imdb || typeof it.imdb !== "string" || !it.imdb.startsWith("tt")) return false;
  const imdbId = it.imdb;

  const cached = await loadCache(imdbId);
  if (!FORCE && cached && isFreshCache(cached)) {
    CACHE_HITS++;
    const before = sha1(it);
    applyCacheToItem(it, cached);
    const after = sha1(it);
    return before !== after;
  }
  CACHE_MISSES++;

  let cm = null;
  try {
    cm = await fetchCinemetaMeta(listType === "series" ? "series" : "movie", imdbId);
    await sleep(SLEEP_MS);
  } catch (e) {
    CINEMETA_FAILS++;
    console.warn(`[CINEMETA] fail ${listType} ${imdbId}: ${e?.message || e}`);
    cm = null;
  }

  const fallbackName = cm?.name;
  const fallbackDesc = cm?.description;
  const fallbackYear = cm?.releaseInfo;
  const fallbackGenres = cm?.genres;

  let changed = false;

  if (cm?.poster) {
    const newPoster = `${cm.poster}?src=cinemeta`;
    if (it.poster !== newPoster) {
      UPDATED_POSTER++;
      changed = true;
    }
    it.poster = newPoster;
  }

  const bg = cm?.background || cm?.banner;
  if (bg) {
    const newBg = `${bg}?src=cinemeta`;
    if (it.background !== newBg) changed = true;
    it.background = newBg;
  }

  if (cm?.imdbRating && it.imdbRating !== cm.imdbRating) {
    it.imdbRating = cm.imdbRating;
    changed = true;
  }
  if (cm?.runtime && it.runtime !== cm.runtime) {
    it.runtime = cm.runtime;
    changed = true;
  }

  // SERIES: jen Cinemeta
  if (listType === "series") {
    const before = sha1(it);

    it.name = it.name || fallbackName;
    it.year = it.year || fallbackYear;
    it.genres = it.genres || fallbackGenres;
    it.description = it.description || fallbackDesc;
    it.releaseInfo = it.releaseInfo || it.year;

    const after = sha1(it);
    const didChange = before !== after || changed;

    await saveCache(imdbId, pickCacheFromItem(it));
    return didChange;
  }

  // MOVIES: Cinemeta + CSFD
  if (LIGHT_MODE) {
    const before = sha1(it);

    it.name = it.name || fallbackName;
    it.year = it.year || fallbackYear;
    it.genres = it.genres || fallbackGenres;
    it.description = it.description || fallbackDesc;
    it.releaseInfo = it.releaseInfo || it.year;

    const after = sha1(it);
    const didChange = before !== after || changed;

    await saveCache(imdbId, pickCacheFromItem(it));
    return didChange;
  }

  // MOVIES: full mode Cinemeta + CSFD
  let cs = null;
  try {
    if (!it.csfdId) {
      it.csfdId = await findCsfdIdBySearch(it.name || fallbackName, it.year || fallbackYear);
      if (it.csfdId) changed = true;
    }
    if (it.csfdId) {
      cs = await csfd.movie(Number(it.csfdId));
      await sleep(SLEEP_MS);
    }
  } catch (e) {
    CSFD_FAILS++;
    console.warn(`[CSFD] fail ${imdbId}: ${e?.message || e}`);
    cs = null;
  }

  const beforeDesc = it.description;
  const beforeHash = sha1(it);

  if (cs) {
    const ratingLine = csfdRatingText(cs.rating, cs.ratingCount);
    const descBase = Array.isArray(cs.descriptions) && cs.descriptions.length ? cs.descriptions[0] : "";

    const desc = ratingLine ? (descBase ? `${descBase}\n\n${ratingLine}` : ratingLine) : descBase;

    it.name = cs.title || it.name || fallbackName;
    it.year = cs.year || it.year || fallbackYear;

    it.genres = Array.isArray(cs.genres) && cs.genres.length ? cs.genres : it.genres || fallbackGenres;

    it.description = desc || it.description || fallbackDesc;
    if (it.description && it.description !== beforeDesc) UPDATED_DESC++;

    it.releaseInfo = it.year && ratingLine ? `${it.year} • ${ratingLine}` : it.year || it.releaseInfo;

    it.csfdRating = cs.rating;
    it.csfdRatingCount = cs.ratingCount;
  } else {
    it.name = it.name || fallbackName;
    it.year = it.year || fallbackYear;
    it.genres = it.genres || fallbackGenres;
    it.description = it.description || fallbackDesc;
    it.releaseInfo = it.releaseInfo || it.year;
  }

  const afterHash = sha1(it);
  const didChange = beforeHash !== afterHash || changed;

  await saveCache(imdbId, pickCacheFromItem(it));
  return didChange;
}

async function loadTargetsIfAny() {
  const p = process.env.ENRICH_TARGETS_PATH;
  if (!p) return null;
  try {
    const raw = await fs.readFile(p, "utf8");
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.files) || !j.listsDir) return null;
    return { listsDir: j.listsDir, files: j.files };
  } catch {
    return null;
  }
}

async function enrichFile(listDir, file) {
  const fullPath = path.join(listDir, file);
  const raw = await fs.readFile(fullPath, "utf8");
  const json = JSON.parse(raw);

  const listType = json.type === "series" ? "series" : "movie";
  const items = Array.isArray(json.items) ? json.items : [];

  const beforeFileHash = sha1(json);

  console.log(`\n=== ENRICH FILE: ${file} type=${listType} items=${items.length} ===`);

  let i = 0;
  let changedAny = false;

  for (const it of items) {
    i++;
    ITEMS_DONE++;

    if (i % 10 === 0) {
      console.log(`  progress ${i}/${items.length} (total ${ITEMS_DONE})`);
    }

    try {
      const changed = await enrichItem(it, listType);
      if (changed) changedAny = true;
    } catch (e) {
      console.warn(`[ENRICH] unexpected fail ${it?.imdb || "unknown"}: ${e?.message || e}`);
    }
  }

  const afterFileHash = sha1(json);

  if (changedAny || beforeFileHash !== afterFileHash) {
    await fs.writeFile(fullPath, JSON.stringify(json, null, 2), "utf8");
  } else {
    FILES_UNCHANGED++;
    console.log(`  unchanged -> skip write`);
  }

  FILES_DONE++;
}

async function main() {
  const targets = await loadTargetsIfAny();
  const listDir = targets?.listsDir || DEFAULT_LIST_DIR;

  await fs.mkdir(CACHE_DIR, { recursive: true });

  let files = [];
  if (targets) {
    files = targets.files.filter((f) => f.endsWith(".json"));
  } else {
    files = (await fs.readdir(listDir)).filter((f) => f.endsWith(".json"));
  }

  if (!files.length) {
    console.log("No list files found in:", listDir);
    return;
  }

  console.log(
    `Starting enrichment: files=${files.length}, listDir=${listDir}, cacheDir=${CACHE_DIR}, cacheTtlDays=${CACHE_TTL_DAYS}, force=${FORCE ? "1" : "0"}, lightMode=${LIGHT_MODE ? "1" : "0"}, sleepMs=${SLEEP_MS}, timeoutMs=${FETCH_TIMEOUT_MS}`
  );

  for (const f of files) {
    await enrichFile(listDir, f);
  }

  console.log(
    `\nDone. files=${FILES_DONE} unchangedFiles=${FILES_UNCHANGED} items=${ITEMS_DONE} cacheHits=${CACHE_HITS} cacheMisses=${CACHE_MISSES} posterUpdates=${UPDATED_POSTER} descUpdates=${UPDATED_DESC} cinemetaFails=${CINEMETA_FAILS} csfdFails=${CSFD_FAILS}`
  );
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  console.error(e);
  process.exit(1);
});
