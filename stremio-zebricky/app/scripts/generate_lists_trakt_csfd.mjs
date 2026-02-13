import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { csfd } from "node-csfd-api";
import { getTraktKeys, getTmdbKeys } from "./_secrets.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || "/data";
const LIST_DIR = path.join(DATA_DIR, "lists");
const CONFIG_PATH = path.join(DATA_DIR, "config", "lists.trakt.json");

const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
const CACHE_DIR = path.join(RUNTIME_DIR, "cache");
const STATE_DIR = path.join(RUNTIME_DIR, "lists-state");
const SOURCE_SNAPSHOT_DIR = path.join(RUNTIME_DIR, "source-snapshots");

const CSFD_MAP_PATH = path.join(CACHE_DIR, "csfd_map.json");
const TMDB_IMDB_MAP_PATH = path.join(CACHE_DIR, "tmdb_imdb_map.json");
const EXPOSURE_PATH = path.join(STATE_DIR, "exposure.json");

const TRAKT_BASE = "https://api.trakt.tv";
const TMDB_BASE = "https://api.themoviedb.org/3";
const DEFAULT_TIMEOUT_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ENGINE_VERSION = 2;
const TMDB_MAP_OK_TTL_DAYS = Number(process.env.TMDB_MAP_OK_TTL_DAYS || 120);
const TMDB_MAP_NOT_FOUND_TTL_DAYS = Number(
  process.env.TMDB_MAP_NOT_FOUND_TTL_DAYS || 21,
);

const CSFD_NOT_FOUND_TTL_DAYS = Number(
  process.env.CSFD_NOT_FOUND_TTL_DAYS || 7,
);
const CSFD_ERROR_RETRY_MS = Number(
  process.env.CSFD_ERROR_RETRY_MS || 30 * 60 * 1000,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODE_PRESETS = {
  stable: {
    stability: {
      stableCoreRatio: 0.45,
      maxOverlapRatio: 0.9,
      newEntrantMinRatio: 0.06,
      rotationPeriod: "week",
      coreReinforceBoost: 18,
      explorationJitter: 2.5,
      noveltyRotationWeight: 0.25,
      newEntryPriorityBoost: 6,
    },
    diversity: {
      topWindow: 35,
      maxPrimaryGenreTop: 7,
      maxPerDecadeTop: 11,
      maxPerFranchiseTop: 2,
    },
    novelty: {
      newBoost: 8,
      agingPerDay: 0.2,
      agingMax: 6,
      seenPenalty: 0.25,
      exposurePenaltyPerShow: 1.0,
      exposurePenaltyCap: 20,
    },
    sources: {
      snapshotTtlDays: 14,
      snapshotWeight: 0.8,
      scoreWeight: 1.0,
    },
  },
  balanced: {
    stability: {
      stableCoreRatio: 0.3,
      maxOverlapRatio: 0.78,
      newEntrantMinRatio: 0.12,
      rotationPeriod: "day",
      coreReinforceBoost: 12,
      explorationJitter: 8,
      noveltyRotationWeight: 0.45,
      newEntryPriorityBoost: 10,
    },
    diversity: {
      topWindow: 40,
      maxPrimaryGenreTop: 6,
      maxPerDecadeTop: 9,
      maxPerFranchiseTop: 2,
    },
    novelty: {
      newBoost: 20,
      agingPerDay: 0.5,
      agingMax: 12,
      seenPenalty: 0.45,
      exposurePenaltyPerShow: 2.0,
      exposurePenaltyCap: 30,
    },
    sources: {
      snapshotTtlDays: 14,
      snapshotWeight: 0.75,
      scoreWeight: 1.1,
    },
  },
  fresh: {
    stability: {
      stableCoreRatio: 0.15,
      maxOverlapRatio: 0.62,
      newEntrantMinRatio: 0.2,
      rotationPeriod: "day",
      coreReinforceBoost: 6,
      explorationJitter: 14,
      noveltyRotationWeight: 0.7,
      newEntryPriorityBoost: 14,
    },
    diversity: {
      topWindow: 45,
      maxPrimaryGenreTop: 5,
      maxPerDecadeTop: 8,
      maxPerFranchiseTop: 1,
    },
    novelty: {
      newBoost: 32,
      agingPerDay: 0.9,
      agingMax: 20,
      seenPenalty: 0.75,
      exposurePenaltyPerShow: 3.0,
      exposurePenaltyCap: 40,
    },
    sources: {
      snapshotTtlDays: 10,
      snapshotWeight: 0.7,
      scoreWeight: 1.2,
    },
  },
};

async function ensureDirs() {
  await fs.mkdir(LIST_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.mkdir(SOURCE_SNAPSHOT_DIR, { recursive: true });
}

async function readJsonSafe(p, fallback) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, p);
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function toNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toPositiveInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function toBool(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function normalizeModeName(v) {
  const s = String(v || "")
    .trim()
    .toLowerCase();
  if (s === "stable" || s === "fresh" || s === "balanced") return s;
  return "balanced";
}

function parseCsv(csv) {
  return String(csv || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function uniqLower(list) {
  return Array.from(
    new Set(
      (list || [])
        .map((s) =>
          String(s || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  );
}

function hasAnyIntersection(list, set) {
  if (!set || set.size === 0) return false;
  for (const x of list || []) {
    if (
      set.has(
        String(x || "")
          .trim()
          .toLowerCase(),
      )
    ) {
      return true;
    }
  }
  return false;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((x) => stableStringify(x)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashStrToUint32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function deterministicJitter(seedKey) {
  return hashStrToUint32(seedKey) / 4294967296;
}

function dayKeyUTC(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function weekKeyUTC(d = new Date()) {
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / DAY_MS) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function listHistoryPath(listId) {
  const safe = String(listId || "list").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(STATE_DIR, `history-${safe}.json`);
}

function stableListSignature(obj) {
  return {
    engineVersion: obj.engineVersion ?? ENGINE_VERSION,
    id: obj.id,
    type: obj.type,
    mode: obj.mode || "balanced",
    strategy: {
      stableCoreRatio: obj?.strategy?.stableCoreRatio,
      maxOverlapRatio: obj?.strategy?.maxOverlapRatio,
      newEntrantMinRatio: obj?.strategy?.newEntrantMinRatio,
      topWindow: obj?.strategy?.topWindow,
    },
    sources: (obj.sources || [])
      .map((s) => `${s.provider || "trakt"}:${s.path}|${s.weight}`)
      .sort(),
    items: (obj.items || []).map((x) => x.imdb),
    filters: obj.filters,
  };
}

function sameSignature(a, b) {
  return (
    JSON.stringify(stableListSignature(a)) ===
    JSON.stringify(stableListSignature(b))
  );
}

function buildTraktUrl(pathname, params = {}) {
  const url = new URL(TRAKT_BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function buildTmdbUrl(pathname, params = {}, apiKey = "") {
  const p = String(pathname || "").trim();
  const normalizedPath = p.startsWith("/") ? p : `/${p}`;
  const url = new URL(TMDB_BASE + normalizedPath);
  if (apiKey) url.searchParams.set("api_key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function parseYearRange(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d{4})\s*-\s*(\d{4})$/);
  if (!m) return null;
  let y1 = Number(m[1]);
  let y2 = Number(m[2]);
  if (!Number.isFinite(y1) || !Number.isFinite(y2)) return null;
  if (y2 < y1) [y1, y2] = [y2, y1];
  return { from: y1, to: y2 };
}

function slugifyGenreName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

function buildTmdbFilters(filters, listType, genreSlugToId) {
  const out = {};
  const src = filters && typeof filters === "object" ? filters : {};

  for (const [k, v] of Object.entries(src)) {
    if (k === "genres" || k === "years" || k === "genresExclude" || k === "excludeGenres")
      continue;
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }

  const years = parseYearRange(src.years);
  if (years) {
    if (listType === "series") {
      out["first_air_date.gte"] = `${years.from}-01-01`;
      out["first_air_date.lte"] = `${years.to}-12-31`;
    } else {
      out["primary_release_date.gte"] = `${years.from}-01-01`;
      out["primary_release_date.lte"] = `${years.to}-12-31`;
    }
  }

  const genres = parseCsv(src.genres || "");
  if (genres.length) {
    const ids = genres
      .map((g) => genreSlugToId.get(g))
      .filter((x) => Number.isFinite(Number(x)))
      .map((x) => Number(x));
    if (ids.length) out.with_genres = ids.join(",");
  }

  return out;
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchTraktPage({
  clientId,
  pathname,
  filters,
  page,
  limit,
  timeoutMs,
}) {
  const params = { ...(filters ?? {}), page, limit, extended: "full" };
  const url = buildTraktUrl(pathname, params);

  console.log(`[TRAKT] GET ${pathname} page=${page} limit=${limit}`);

  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        "Content-Type": "application/json",
        "trakt-api-key": clientId,
        "trakt-api-version": "2",
        "user-agent": "stremio-local-addon/0.0.12",
      },
    },
    timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Trakt ${res.status} for ${url}\n${text}`);
  }
  return res.json();
}

async function fetchTmdbPage({
  accessToken,
  apiKey,
  pathname,
  filters,
  page,
  timeoutMs,
}) {
  if (!accessToken && !apiKey) {
    throw new Error(
      "TMDB source configured, but missing tmdb access token or api_key in secrets/env.",
    );
  }

  const params = { ...(filters ?? {}), page };
  const url = buildTmdbUrl(pathname, params, apiKey);
  const headers = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  console.log(`[TMDB] GET ${pathname} page=${page}`);

  const res = await fetchWithTimeout(
    url,
    { headers },
    timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status} for ${url}\n${text}`);
  }

  const json = await res.json();
  return Array.isArray(json?.results) ? json.results : [];
}

function normalizeTraktItem(raw, type) {
  const obj = type === "series" ? (raw?.show ?? raw) : (raw?.movie ?? raw);

  const ids = obj?.ids ?? {};
  const imdb = ids.imdb;
  const title = obj?.title;
  const year = obj?.year;

  const traktSignal =
    (raw?.watcher_count ?? 0) +
    (raw?.play_count ?? 0) +
    (raw?.collected_count ?? 0) +
    (raw?.collector_count ?? 0) +
    (raw?.watchers ?? 0);

  const genres = Array.isArray(obj?.genres) ? uniqLower(obj.genres) : [];

  if (!imdb || typeof imdb !== "string" || !imdb.startsWith("tt")) return null;

  return { imdb, title, year, traktSignal, genres };
}

function normalizeTmdbItem(raw, type, genreIdToSlug) {
  const tmdbId = Number(raw?.id);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return null;

  const title =
    type === "series"
      ? raw?.name || raw?.original_name || raw?.title
      : raw?.title || raw?.original_title || raw?.name;

  const date =
    type === "series"
      ? raw?.first_air_date || raw?.release_date
      : raw?.release_date || raw?.first_air_date;
  const yearMatch = String(date || "").match(/^(\d{4})/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;

  let genres = [];
  if (Array.isArray(raw?.genre_ids) && raw.genre_ids.length) {
    genres = raw.genre_ids
      .map((id) => genreIdToSlug.get(Number(id)) || "")
      .filter(Boolean);
  } else if (Array.isArray(raw?.genres) && raw.genres.length) {
    genres = raw.genres
      .map((g) =>
        g && typeof g === "object"
          ? genreIdToSlug.get(Number(g.id)) || slugifyGenreName(g.name)
          : "",
      )
      .filter(Boolean);
  }

  const popularity = toNumber(raw?.popularity, 0);
  const votes = toNumber(raw?.vote_count, 0);
  const rating = toNumber(raw?.vote_average, 0);
  const tmdbSignal = popularity + votes * 0.5 + rating * 10;

  return {
    tmdbId,
    title: String(title || "").trim(),
    year,
    traktSignal: tmdbSignal,
    genres: uniqLower(genres),
  };
}

function formatCountK(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

function csfdRatingText(rating, ratingCount) {
  if (!Number.isFinite(rating)) return "";
  const cnt = Number.isFinite(ratingCount)
    ? ` (${formatCountK(ratingCount)})`
    : "";
  return `CSFD: ${Math.round(rating)}%${cnt}`;
}

function computeBaseScoreMovie({ rating, ratingCount, traktSignal = 0 }) {
  if (!Number.isFinite(rating)) return -Infinity;
  const trust = Math.log10((ratingCount || 0) + 10);
  const trakt = Math.log10((traktSignal || 0) + 1);
  return rating * trust + 5 * trakt;
}

function computeScoreSeries({ year, traktSignal = 0 }) {
  const y = Number.isFinite(Number(year)) ? Number(year) : 2000;
  const trakt = Math.log10((traktSignal || 0) + 1);
  return y - 1950 + 15 * trakt;
}

async function findCsfdIdBySearch(title, year, sleepMs) {
  const q = title?.trim();
  if (!q) return null;

  const results = await csfd.search(q);
  await sleep(sleepMs);

  const movies = results?.movies || [];
  if (year) {
    const exact = movies.find((m) => String(m.year) === String(year));
    if (exact?.id) return exact.id;
  }
  return movies[0]?.id || null;
}

async function getCsfdInfo(
  { imdb, title, year },
  csfdMap,
  sleepMs,
  ttlDays = 30,
) {
  const cached = csfdMap[imdb];
  const now = Date.now();

  const okTtlMs = ttlDays * DAY_MS;
  const notFoundTtlMs = CSFD_NOT_FOUND_TTL_DAYS * DAY_MS;
  const errorRetryMs = CSFD_ERROR_RETRY_MS;

  const toTs = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const toNumOrNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const cachedSuccess =
    cached &&
    cached.csfdId !== null &&
    Number.isFinite(Number(cached.csfdId)) &&
    Number.isFinite(Number(cached.rating))
      ? {
          csfdId: Number(cached.csfdId),
          rating: Number(cached.rating),
          ratingCount: toNumOrNull(cached.ratingCount),
          name: cached.name,
          year: cached.year,
        }
      : null;

  const okTs =
    toTs(cached?.lastOkAt) || (cachedSuccess ? toTs(cached?.last) : 0);
  if (cachedSuccess && okTs && now - okTs < okTtlMs) {
    return cachedSuccess;
  }

  const notFoundTs =
    toTs(cached?.lastNotFoundAt) ||
    (cached?.csfdId === null ? toTs(cached?.last) : 0);
  if (
    cached?.csfdId === null &&
    notFoundTs &&
    now - notFoundTs < notFoundTtlMs
  ) {
    return null;
  }

  const errorTs =
    toTs(cached?.lastErrorAt) ||
    (cached?.csfdId !== null && !cachedSuccess ? toTs(cached?.last) : 0);
  if (!cachedSuccess && errorTs && now - errorTs < errorRetryMs) {
    return null;
  }

  let csfdId = Number.isFinite(Number(cached?.csfdId))
    ? Number(cached.csfdId)
    : null;

  try {
    if (!csfdId) csfdId = await findCsfdIdBySearch(title, year, sleepMs);

    if (!csfdId) {
      csfdMap[imdb] = {
        csfdId: null,
        lastAttemptAt: now,
        lastNotFoundAt: now,
      };
      return null;
    }

    const m = await csfd.movie(Number(csfdId));
    await sleep(sleepMs);

    const rating = m.rating;
    const ratingCount = m.ratingCount;

    const name = m.title || title;
    const y = m.year || year;

    csfdMap[imdb] = {
      csfdId: Number(csfdId),
      rating,
      ratingCount,
      name,
      year: y,
      lastAttemptAt: now,
      lastOkAt: now,
    };

    return { csfdId: Number(csfdId), rating, ratingCount, name, year: y };
  } catch (e) {
    csfdMap[imdb] = {
      ...(cached && typeof cached === "object" ? cached : {}),
      csfdId: csfdId ? Number(csfdId) : null,
      lastAttemptAt: now,
      lastErrorAt: now,
      lastError: String(e?.message || e),
    };

    if (cachedSuccess) return cachedSuccess;
    return null;
  }
}

function pickDupRules(def, defaults) {
  const d = defaults?.dupRules ?? {};
  const r = def?.dupRules ?? {};
  return {
    hardBlockTop: Number.isFinite(r.hardBlockTop)
      ? r.hardBlockTop
      : Number.isFinite(d.hardBlockTop)
        ? d.hardBlockTop
        : 45,
    penaltyPerHit: Number.isFinite(r.penaltyPerHit)
      ? r.penaltyPerHit
      : Number.isFinite(d.penaltyPerHit)
        ? d.penaltyPerHit
        : 80,
  };
}

function sourceSnapshotPath(meta) {
  const key = stableStringify(meta);
  const hash = crypto.createHash("sha1").update(key).digest("hex");
  return path.join(SOURCE_SNAPSHOT_DIR, `${hash}.json`);
}

function normalizeStoredCandidate(item) {
  return {
    imdb: String(item?.imdb || "").trim(),
    title: String(item?.title || item?.name || "").trim(),
    year: Number.isFinite(Number(item?.year)) ? Number(item.year) : undefined,
    traktSignal: Number.isFinite(Number(item?.traktSignal))
      ? Number(item.traktSignal)
      : 0,
    genres: uniqLower(Array.isArray(item?.genres) ? item.genres : []),
  };
}

function tmdbMediaTypeOfListType(listType) {
  return String(listType || "").trim().toLowerCase() === "series" ? "tv" : "movie";
}

function tmdbMapKey(listType, tmdbId) {
  return `${tmdbMediaTypeOfListType(listType)}:${Number(tmdbId)}`;
}

function isFreshTs(ts, ttlDays) {
  const t = Number(ts);
  return Number.isFinite(t) && t > 0 && Date.now() - t < ttlDays * DAY_MS;
}

async function fetchTmdbGenresMap({ listType, tmdb, timeoutMs, tmdbGenresCache }) {
  const media = tmdbMediaTypeOfListType(listType);
  if (tmdbGenresCache[media]) return tmdbGenresCache[media];

  if (!tmdb?.accessToken && !tmdb?.apiKey) {
    throw new Error(
      "TMDB source configured, but missing tmdb access token or api_key in secrets/env.",
    );
  }

  const pathName = media === "tv" ? "/genre/tv/list" : "/genre/movie/list";
  const url = buildTmdbUrl(pathName, { language: "en-US" }, tmdb.apiKey || "");
  const headers = { "Content-Type": "application/json" };
  if (tmdb.accessToken) headers.Authorization = `Bearer ${tmdb.accessToken}`;

  const res = await fetchWithTimeout(
    url,
    { method: "GET", headers },
    timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status} for ${url}\n${text}`);
  }
  const json = await res.json();
  const list = Array.isArray(json?.genres) ? json.genres : [];

  const idToSlug = new Map();
  const slugToId = new Map();
  for (const g of list) {
    const id = Number(g?.id);
    if (!Number.isFinite(id)) continue;
    const slug = slugifyGenreName(g?.name || "");
    if (!slug) continue;
    idToSlug.set(id, slug);
    if (!slugToId.has(slug)) slugToId.set(slug, id);
  }

  const out = { idToSlug, slugToId };
  tmdbGenresCache[media] = out;
  return out;
}

async function fetchTmdbExternalImdbId({ listType, tmdbId, tmdb, timeoutMs }) {
  const media = tmdbMediaTypeOfListType(listType);
  const pathName = `/${media}/${Number(tmdbId)}/external_ids`;
  const url = buildTmdbUrl(pathName, {}, tmdb.apiKey || "");
  const headers = { "Content-Type": "application/json" };
  if (tmdb.accessToken) headers.Authorization = `Bearer ${tmdb.accessToken}`;

  const res = await fetchWithTimeout(
    url,
    { method: "GET", headers },
    timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status} for ${url}\n${text}`);
  }

  const json = await res.json();
  const imdb = String(json?.imdb_id || "").trim();
  return imdb.startsWith("tt") ? imdb : "";
}

async function resolveTmdbImdbId({
  listType,
  tmdbId,
  tmdb,
  tmdbImdbMap,
  timeoutMs,
  sleepMs,
}) {
  const key = tmdbMapKey(listType, tmdbId);
  const cached = tmdbImdbMap[key];

  if (cached && typeof cached === "object") {
    const cachedImdb = String(cached.imdb || "").trim();
    if (cachedImdb.startsWith("tt") && isFreshTs(cached.lastOkAt, TMDB_MAP_OK_TTL_DAYS)) {
      return cachedImdb;
    }
    if (!cachedImdb && isFreshTs(cached.lastNotFoundAt, TMDB_MAP_NOT_FOUND_TTL_DAYS)) {
      return "";
    }
  }

  if (!tmdb?.accessToken && !tmdb?.apiKey) return "";

  try {
    const imdb = await fetchTmdbExternalImdbId({
      listType,
      tmdbId,
      tmdb,
      timeoutMs,
    });
    await sleep(Math.min(Math.max(Number(sleepMs) || 0, 0), 80));

    const now = Date.now();
    if (imdb) {
      tmdbImdbMap[key] = {
        imdb,
        lastAttemptAt: now,
        lastOkAt: now,
      };
      return imdb;
    }

    tmdbImdbMap[key] = {
      imdb: "",
      lastAttemptAt: now,
      lastNotFoundAt: now,
    };
    return "";
  } catch (e) {
    const msg = String(e?.message || e);
    const now = Date.now();

    tmdbImdbMap[key] = {
      ...(cached && typeof cached === "object" ? cached : {}),
      lastAttemptAt: now,
      lastErrorAt: now,
      lastError: msg,
    };

    if (msg.includes("TMDB 401") || msg.includes("TMDB 403")) {
      throw e;
    }

    const cachedImdb = String(cached?.imdb || "").trim();
    return cachedImdb.startsWith("tt") ? cachedImdb : "";
  }
}

async function saveSourceSnapshot(meta, items) {
  const p = sourceSnapshotPath(meta);
  await writeJsonAtomic(p, {
    savedAt: nowIso(),
    meta,
    items: (items || []).map((x) => normalizeStoredCandidate(x)),
  });
}

async function loadSourceSnapshot(meta, maxAgeDays) {
  const p = sourceSnapshotPath(meta);
  const snap = await readJsonSafe(p, null);
  if (!snap || !Array.isArray(snap.items)) return null;

  const savedTs = Date.parse(snap.savedAt || "");
  if (!Number.isFinite(savedTs)) return null;

  const ageMs = Date.now() - savedTs;
  if (ageMs > maxAgeDays * DAY_MS) return null;

  return {
    savedAt: snap.savedAt,
    items: snap.items.map((x) => normalizeStoredCandidate(x)).filter((x) => x.imdb),
  };
}

function resolveModeSettings(def, defaults) {
  const mode = normalizeModeName(def?.mode ?? defaults?.listMode ?? "balanced");
  const preset = MODE_PRESETS[mode] || MODE_PRESETS.balanced;

  const globalStability =
    defaults?.stability && typeof defaults.stability === "object"
      ? defaults.stability
      : {};
  const localStability =
    def?.stability && typeof def.stability === "object" ? def.stability : {};

  const globalDiversity =
    defaults?.diversity && typeof defaults.diversity === "object"
      ? defaults.diversity
      : {};
  const localDiversity =
    def?.diversity && typeof def.diversity === "object" ? def.diversity : {};

  const globalNovelty =
    defaults?.novelty && typeof defaults.novelty === "object"
      ? defaults.novelty
      : {};
  const localNovelty =
    def?.novelty && typeof def.novelty === "object" ? def.novelty : {};

  const globalSources =
    defaults?.sources && typeof defaults.sources === "object"
      ? defaults.sources
      : {};
  const localSources =
    def?.sourcePolicy && typeof def.sourcePolicy === "object"
      ? def.sourcePolicy
      : {};

  const stability = {
    stableCoreRatio: clamp(
      toNumber(
        localStability.stableCoreRatio ?? globalStability.stableCoreRatio,
        preset.stability.stableCoreRatio,
      ),
      0,
      0.95,
    ),
    maxOverlapRatio: clamp(
      toNumber(
        localStability.maxOverlapRatio ?? globalStability.maxOverlapRatio,
        preset.stability.maxOverlapRatio,
      ),
      0,
      1,
    ),
    newEntrantMinRatio: clamp(
      toNumber(
        localStability.newEntrantMinRatio ??
          globalStability.newEntrantMinRatio,
        preset.stability.newEntrantMinRatio,
      ),
      0,
      1,
    ),
    rotationPeriod:
      String(
        localStability.rotationPeriod ??
          globalStability.rotationPeriod ??
          preset.stability.rotationPeriod,
      )
        .trim()
        .toLowerCase() === "week"
        ? "week"
        : "day",
    coreReinforceBoost: toNumber(
      localStability.coreReinforceBoost ?? globalStability.coreReinforceBoost,
      preset.stability.coreReinforceBoost,
    ),
    explorationJitter: toNumber(
      localStability.explorationJitter ?? globalStability.explorationJitter,
      preset.stability.explorationJitter,
    ),
    noveltyRotationWeight: toNumber(
      localStability.noveltyRotationWeight ??
        globalStability.noveltyRotationWeight,
      preset.stability.noveltyRotationWeight,
    ),
    newEntryPriorityBoost: toNumber(
      localStability.newEntryPriorityBoost ??
        globalStability.newEntryPriorityBoost,
      preset.stability.newEntryPriorityBoost,
    ),
  };

  const diversity = {
    topWindow: toPositiveInt(
      localDiversity.topWindow ?? globalDiversity.topWindow,
      preset.diversity.topWindow,
    ),
    maxPrimaryGenreTop: toPositiveInt(
      localDiversity.maxPrimaryGenreTop ?? globalDiversity.maxPrimaryGenreTop,
      preset.diversity.maxPrimaryGenreTop,
    ),
    maxPerDecadeTop: toPositiveInt(
      localDiversity.maxPerDecadeTop ?? globalDiversity.maxPerDecadeTop,
      preset.diversity.maxPerDecadeTop,
    ),
    maxPerFranchiseTop: toPositiveInt(
      localDiversity.maxPerFranchiseTop ?? globalDiversity.maxPerFranchiseTop,
      preset.diversity.maxPerFranchiseTop,
    ),
  };

  const novelty = {
    newBoost: toNumber(
      localNovelty.newBoost ?? globalNovelty.newBoost,
      preset.novelty.newBoost,
    ),
    agingPerDay: toNumber(
      localNovelty.agingPerDay ?? globalNovelty.agingPerDay,
      preset.novelty.agingPerDay,
    ),
    agingMax: toNumber(
      localNovelty.agingMax ?? globalNovelty.agingMax,
      preset.novelty.agingMax,
    ),
    seenPenalty: toNumber(
      localNovelty.seenPenalty ?? globalNovelty.seenPenalty,
      preset.novelty.seenPenalty,
    ),
    exposurePenaltyPerShow: toNumber(
      localNovelty.exposurePenaltyPerShow ??
        globalNovelty.exposurePenaltyPerShow,
      preset.novelty.exposurePenaltyPerShow,
    ),
    exposurePenaltyCap: toNumber(
      localNovelty.exposurePenaltyCap ?? globalNovelty.exposurePenaltyCap,
      preset.novelty.exposurePenaltyCap,
    ),
  };

  const sources = {
    snapshotTtlDays: toPositiveNumber(
      localSources.snapshotTtlDays ?? globalSources.snapshotTtlDays,
      preset.sources.snapshotTtlDays,
    ),
    snapshotWeight: clamp(
      toNumber(
        localSources.snapshotWeight ?? globalSources.snapshotWeight,
        preset.sources.snapshotWeight,
      ),
      0.1,
      1,
    ),
    scoreWeight: toNumber(
      localSources.scoreWeight ?? globalSources.scoreWeight,
      preset.sources.scoreWeight,
    ),
  };

  const debugItems = toBool(
    def?.debugItems ??
      defaults?.debugItems ??
      String(process.env.LISTS_DEBUG_ITEMS || "").trim() === "1",
    false,
  );

  return { mode, stability, diversity, novelty, sources, debugItems };
}

function resolveSourceDefs(def, defaults, fallbackPages) {
  const raw =
    Array.isArray(def?.sources) && def.sources.length
      ? def.sources
      : def?.source
        ? [def.source]
        : [];

  const out = [];
  const seen = new Set();
  const basePages = toPositiveInt(
    def?.candidatePages ?? defaults?.candidatePages,
    fallbackPages,
  );

  const normalizeSourceProvider = (providerRaw, sourcePath) => {
    const p = String(providerRaw || "")
      .trim()
      .toLowerCase();
    if (p === "trakt" || p === "tmdb") return p;
    if (
      sourcePath.startsWith("/movie/") ||
      sourcePath.startsWith("/tv/") ||
      sourcePath.startsWith("/trending/movie/") ||
      sourcePath.startsWith("/trending/tv/") ||
      sourcePath.startsWith("/discover/movie") ||
      sourcePath.startsWith("/discover/tv")
    ) {
      return "tmdb";
    }
    return "trakt";
  };

  for (let i = 0; i < raw.length; i++) {
    const src = raw[i];
    const sourceObj =
      typeof src === "string"
        ? { path: src }
        : src && typeof src === "object"
          ? src
          : null;
    if (!sourceObj) continue;

    let sourcePath = String(sourceObj.path || "").trim();
    if (!sourcePath) continue;
    if (!sourcePath.startsWith("/")) sourcePath = `/${sourcePath}`;
    const provider = normalizeSourceProvider(sourceObj.provider, sourcePath);

    const id = String(sourceObj.id || sourcePath || `src-${i + 1}`).trim();
    const weight = toPositiveNumber(sourceObj.weight, 1);
    const candidatePages = toPositiveInt(sourceObj.candidatePages, basePages);
    const key = `${provider}::${id}::${sourcePath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id,
      provider,
      path: sourcePath,
      weight,
      candidatePages,
    });
  }

  return out;
}

async function collectSourceItems({
  clientId,
  tmdb,
  tmdbImdbMap,
  tmdbGenresCache,
  listId,
  listType,
  sourceDef,
  apiFilters,
  pageLimit,
  timeoutMs,
  sleepMs,
  includeSet,
  excludeSet,
  sourcePolicy,
}) {
  const snapshotMeta = {
    listId,
    listType,
    provider: sourceDef.provider || "trakt",
    path: sourceDef.path,
    filters: apiFilters,
  };

  const unique = new Map();
  let liveError = "";

  try {
    if (sourceDef.provider === "tmdb") {
      const tmdbGenres = await fetchTmdbGenresMap({
        listType,
        tmdb,
        timeoutMs,
        tmdbGenresCache,
      });
      const tmdbFilters = buildTmdbFilters(
        apiFilters,
        listType,
        tmdbGenres.slugToId,
      );

      for (let page = 1; page <= sourceDef.candidatePages; page++) {
        const data = await fetchTmdbPage({
          accessToken: tmdb?.accessToken || "",
          apiKey: tmdb?.apiKey || "",
          pathname: sourceDef.path,
          filters: tmdbFilters,
          page,
          timeoutMs,
        });

        for (const raw of Array.isArray(data) ? data : []) {
          const base = normalizeTmdbItem(raw, listType, tmdbGenres.idToSlug);
          if (!base) continue;
          if (includeSet.size && !hasAnyIntersection(base.genres, includeSet))
            continue;
          if (excludeSet.size && hasAnyIntersection(base.genres, excludeSet))
            continue;

          const imdb = await resolveTmdbImdbId({
            listType,
            tmdbId: base.tmdbId,
            tmdb,
            tmdbImdbMap,
            timeoutMs,
            sleepMs,
          });
          if (!imdb) continue;

          const item = {
            imdb,
            title: base.title,
            year: base.year,
            traktSignal: base.traktSignal,
            genres: base.genres,
          };
          if (!unique.has(item.imdb)) unique.set(item.imdb, item);
        }

        await sleep(sleepMs);
      }
    } else {
      for (let page = 1; page <= sourceDef.candidatePages; page++) {
        const data = await fetchTraktPage({
          clientId,
          pathname: sourceDef.path,
          filters: apiFilters,
          page,
          limit: pageLimit,
          timeoutMs,
        });

        for (const raw of Array.isArray(data) ? data : []) {
          const it = normalizeTraktItem(raw, listType);
          if (!it) continue;
          if (includeSet.size && !hasAnyIntersection(it.genres, includeSet))
            continue;
          if (excludeSet.size && hasAnyIntersection(it.genres, excludeSet))
            continue;
          if (!unique.has(it.imdb)) unique.set(it.imdb, it);
        }

        await sleep(sleepMs);
      }
    }

    const items = Array.from(unique.values());
    await saveSourceSnapshot(snapshotMeta, items);
    return {
      items,
      status: "live",
      usedSnapshot: false,
      error: "",
      snapshotAt: "",
    };
  } catch (e) {
    liveError = String(e?.message || e);
  }

  const snap = await loadSourceSnapshot(
    snapshotMeta,
    sourcePolicy.snapshotTtlDays,
  );
  if (snap?.items?.length) {
    console.warn(
      `[SOURCE] ${sourceDef.provider || "trakt"}:${sourceDef.path} live failed -> using snapshot (${snap.savedAt}): ${liveError}`,
    );
    return {
      items: snap.items,
      status: "snapshot",
      usedSnapshot: true,
      error: liveError,
      snapshotAt: snap.savedAt,
    };
  }

  console.warn(
    `[SOURCE] ${sourceDef.provider || "trakt"}:${sourceDef.path} failed and no snapshot available: ${liveError}`,
  );
  return {
    items: [],
    status: "failed",
    usedSnapshot: false,
    error: liveError,
    snapshotAt: "",
  };
}

function primaryGenreOf(genres) {
  if (!Array.isArray(genres) || genres.length === 0) return "unknown";
  const g = String(genres[0] || "")
    .trim()
    .toLowerCase();
  return g || "unknown";
}

function decadeOf(year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return "unknown";
  const d = Math.floor(y / 10) * 10;
  return `${d}s`;
}

function franchiseKeyOf(name) {
  const raw = String(name || "")
    .trim()
    .toLowerCase();
  if (!raw) return "unknown";

  const base = raw
    .replace(/\b(part|chapter|episode|season)\b.*$/i, "")
    .replace(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)\b/gi, " ")
    .replace(/\b\d+\b/g, " ")
    .split(/[:\-–—]/)[0]
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return base || raw;
}

function createDiversityState() {
  return {
    genre: new Map(),
    decade: new Map(),
    franchise: new Map(),
  };
}

function mapInc(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function diversityAccepts(item, state, slot, diversityCfg, strict = true) {
  if (slot >= diversityCfg.topWindow) return true;

  const margin = strict ? 0 : 1;

  if (diversityCfg.maxPrimaryGenreTop > 0) {
    const c = state.genre.get(item.primaryGenre) || 0;
    if (c >= diversityCfg.maxPrimaryGenreTop + margin) return false;
  }
  if (diversityCfg.maxPerDecadeTop > 0) {
    const c = state.decade.get(item.decade) || 0;
    if (c >= diversityCfg.maxPerDecadeTop + margin) return false;
  }
  if (diversityCfg.maxPerFranchiseTop > 0) {
    const c = state.franchise.get(item.franchiseKey) || 0;
    if (c >= diversityCfg.maxPerFranchiseTop + margin) return false;
  }

  return true;
}

function diversityTrack(item, state, slot, diversityCfg) {
  if (slot >= diversityCfg.topWindow) return;
  mapInc(state.genre, item.primaryGenre);
  mapInc(state.decade, item.decade);
  mapInc(state.franchise, item.franchiseKey);
}

function computeNoveltySignals(
  imdb,
  listHistory,
  exposureState,
  noveltyCfg,
  nowTs,
) {
  const rec = listHistory?.items?.[imdb] || null;
  const exp = exposureState?.items?.[imdb] || null;

  let noveltyBoost = 0;
  let isNew = false;
  let seenCount = 0;
  let daysSinceSeen = null;

  if (!rec) {
    isNew = true;
    noveltyBoost += noveltyCfg.newBoost;
  } else {
    seenCount = toPositiveInt(rec.seenCount, 0);
    const lastSeenTs = Date.parse(rec.lastSeenAt || rec.firstSeenAt || "");
    if (Number.isFinite(lastSeenTs)) {
      daysSinceSeen = Math.max(0, (nowTs - lastSeenTs) / DAY_MS);
      noveltyBoost += clamp(
        daysSinceSeen * noveltyCfg.agingPerDay,
        0,
        noveltyCfg.agingMax,
      );
    }
    noveltyBoost -= seenCount * noveltyCfg.seenPenalty;
  }

  const shownCount = toPositiveInt(exp?.shownCount, 0);
  const exposurePenalty = clamp(
    shownCount * noveltyCfg.exposurePenaltyPerShow,
    0,
    noveltyCfg.exposurePenaltyCap,
  );

  return {
    noveltyBoost,
    exposurePenalty,
    isNew,
    seenCount,
    shownCount,
    daysSinceSeen,
  };
}

function bumpListHistory(listHistory, pickedItems, atIso) {
  listHistory.version = 1;
  listHistory.lastRunAt = atIso;
  if (!listHistory.items || typeof listHistory.items !== "object")
    listHistory.items = {};

  for (const it of pickedItems) {
    const imdb = String(it?.imdb || "").trim();
    if (!imdb) continue;

    const prev = listHistory.items[imdb] || {
      firstSeenAt: atIso,
      seenCount: 0,
    };

    listHistory.items[imdb] = {
      ...prev,
      firstSeenAt: prev.firstSeenAt || atIso,
      lastSeenAt: atIso,
      seenCount: toPositiveInt(prev.seenCount, 0) + 1,
      lastName: it.name || prev.lastName,
      lastYear: it.year || prev.lastYear,
    };
  }
}

function bumpExposure(exposureState, pickedItems, atIso) {
  exposureState.version = 1;
  exposureState.lastRunAt = atIso;
  if (!exposureState.items || typeof exposureState.items !== "object")
    exposureState.items = {};

  for (const it of pickedItems) {
    const imdb = String(it?.imdb || "").trim();
    if (!imdb) continue;

    const prev = exposureState.items[imdb] || { shownCount: 0 };
    exposureState.items[imdb] = {
      ...prev,
      shownCount: toPositiveInt(prev.shownCount, 0) + 1,
      lastShownAt: atIso,
      lastName: it.name || prev.lastName,
      lastYear: it.year || prev.lastYear,
    };
  }
}

function pruneStateMapByLast(stateObj, field, maxEntries = 12000) {
  const entries = Object.entries(stateObj || {});
  if (entries.length <= maxEntries) return stateObj || {};

  entries.sort((a, b) => {
    const ta = Date.parse(a?.[1]?.[field] || "") || 0;
    const tb = Date.parse(b?.[1]?.[field] || "") || 0;
    return tb - ta;
  });

  const trimmed = Object.create(null);
  for (let i = 0; i < maxEntries; i++) {
    const e = entries[i];
    if (!e) break;
    trimmed[e[0]] = e[1];
  }
  return trimmed;
}

function selectEntriesWithStrategy({
  entries,
  prevItems,
  finalSize,
  listId,
  settings,
}) {
  const prevSet = new Set(
    (prevItems || [])
      .map((x) => String(x?.imdb || "").trim())
      .filter(Boolean),
  );

  const coreSize = Math.max(
    0,
    Math.min(finalSize, Math.round(finalSize * settings.stability.stableCoreRatio)),
  );
  const overlapCap = Math.max(
    coreSize,
    Math.min(finalSize, Math.floor(finalSize * settings.stability.maxOverlapRatio)),
  );
  const targetNewEntrants = Math.max(
    0,
    Math.min(finalSize, Math.ceil(finalSize * settings.stability.newEntrantMinRatio)),
  );

  const prevTopSet = new Set(
    (prevItems || [])
      .slice(0, Math.max(1, coreSize))
      .map((x) => String(x?.imdb || "").trim())
      .filter(Boolean),
  );

  const selected = [];
  const selectedSet = new Set();
  const diversityState = createDiversityState();
  let overlapCount = 0;
  let newEntrants = 0;

  function add(item) {
    selected.push(item);
    selectedSet.add(item.imdb);
    if (prevSet.has(item.imdb)) overlapCount += 1;
    else newEntrants += 1;
    diversityTrack(item, diversityState, selected.length - 1, settings.diversity);
  }

  function fillPool(pool, opts = {}) {
    for (const item of pool) {
      if (selected.length >= finalSize) break;
      if (selectedSet.has(item.imdb)) continue;
      if (opts.onlyNonPrev && prevSet.has(item.imdb)) continue;
      if (
        opts.enforceOverlapCap &&
        prevSet.has(item.imdb) &&
        overlapCount >= overlapCap
      ) {
        continue;
      }
      if (
        !diversityAccepts(
          item,
          diversityState,
          selected.length,
          settings.diversity,
          opts.strictDiversity !== false,
        )
      ) {
        continue;
      }
      add(item);
      if (opts.stopWhenTargetNew && newEntrants >= targetNewEntrants) break;
    }
  }

  const corePool = [...entries]
    .map((x) => ({
      ...x,
      coreScore:
        x.totalScore +
        (prevTopSet.has(x.imdb) ? settings.stability.coreReinforceBoost : 0),
    }))
    .sort((a, b) => b.coreScore - a.coreScore);

  fillPool(corePool, {
    strictDiversity: true,
    enforceOverlapCap: false,
  });
  if (selected.length < coreSize) {
    fillPool(corePool, {
      strictDiversity: false,
      enforceOverlapCap: false,
    });
  }

  const periodKey =
    settings.stability.rotationPeriod === "week" ? weekKeyUTC() : dayKeyUTC();

  const rotationPool = entries
    .filter((x) => !selectedSet.has(x.imdb))
    .map((x) => {
      const jitter01 = deterministicJitter(`${listId}|${periodKey}|${x.imdb}`);
      const signedJitter = (jitter01 * 2 - 1) * settings.stability.explorationJitter;
      const noveltyCarry =
        x.novelty.noveltyBoost * settings.stability.noveltyRotationWeight;
      const newEntryBonus = x.novelty.isNew
        ? settings.stability.newEntryPriorityBoost
        : 0;
      return {
        ...x,
        rotationScore: x.totalScore + signedJitter + noveltyCarry + newEntryBonus,
      };
    })
    .sort((a, b) => b.rotationScore - a.rotationScore);

  if (newEntrants < targetNewEntrants) {
    const nonPrev = rotationPool.filter((x) => !prevSet.has(x.imdb));
    fillPool(nonPrev, {
      onlyNonPrev: true,
      strictDiversity: true,
      enforceOverlapCap: true,
      stopWhenTargetNew: true,
    });
    if (newEntrants < targetNewEntrants) {
      fillPool(nonPrev, {
        onlyNonPrev: true,
        strictDiversity: false,
        enforceOverlapCap: true,
        stopWhenTargetNew: true,
      });
    }
  }

  fillPool(rotationPool, {
    strictDiversity: true,
    enforceOverlapCap: true,
  });
  fillPool(rotationPool, {
    strictDiversity: false,
    enforceOverlapCap: true,
  });
  fillPool(rotationPool, {
    strictDiversity: false,
    enforceOverlapCap: false,
  });

  const picked = selected.slice(0, finalSize);
  const overlapRatio = picked.length ? overlapCount / picked.length : 0;
  const newEntrantRatio = picked.length ? newEntrants / picked.length : 0;

  return {
    picked,
    metrics: {
      coreSize,
      overlapCap,
      overlapCount,
      overlapRatio,
      newEntrants,
      newEntrantRatio,
      targetNewEntrants,
      periodKey,
    },
  };
}

function buildWhySummary(item, listType) {
  const parts = [];
  if (listType === "movie" && Number.isFinite(item.csfdRating)) {
    parts.push(`CSFD ${Math.round(item.csfdRating)}%`);
  }
  parts.push(`score ${item.totalScore.toFixed(1)}`);
  parts.push(`src ${item.sourceCount}`);
  parts.push(item.novelty.isNew ? "new" : `seen ${item.novelty.seenCount}`);
  return parts.join(" | ");
}

async function generateOneList({
  clientId,
  tmdb,
  tmdbImdbMap,
  tmdbGenresCache,
  def,
  defaults,
  csfdMap,
  usedCountsByType,
  exposureState,
}) {
  const listType = def.type || "movie";

  const candidatePages = toPositiveInt(
    def.candidatePages ?? defaults.candidatePages,
    5,
  );
  const pageLimit = toPositiveInt(def.pageLimit ?? defaults.pageLimit, 100);
  const finalSize = toPositiveInt(def.finalSize ?? defaults.finalSize, 140);
  const sleepMs = toPositiveInt(def.sleepMs ?? defaults.sleepMs, 120);
  const timeoutMs = toPositiveInt(
    def.timeoutMs ?? defaults.timeoutMs,
    DEFAULT_TIMEOUT_MS,
  );
  const ttlDays = toPositiveNumber(
    def.csfdCacheTtlDays ?? defaults.csfdCacheTtlDays,
    30,
  );

  const settings = resolveModeSettings(def, defaults);
  const sourceDefs = resolveSourceDefs(def, defaults, candidatePages);
  const dupRules = pickDupRules(def, defaults);

  const filters = def.filters ?? {};
  const includeGenres = uniqLower(parseCsv(filters.genres || ""));
  const excludeGenres = uniqLower(
    parseCsv(filters.genresExclude || filters.excludeGenres || ""),
  );
  const includeSet = new Set(includeGenres);
  const excludeSet = new Set(excludeGenres);

  const apiFilters = { ...(filters || {}) };
  delete apiFilters.genresExclude;
  delete apiFilters.excludeGenres;

  const outPath = path.join(LIST_DIR, `${def.id}.json`);
  const prev = (await fileExists(outPath)) ? await readJsonSafe(outPath, null) : null;
  const prevItems = Array.isArray(prev?.items) ? prev.items : [];

  const historyPath = listHistoryPath(def.id);
  const listHistory = await readJsonSafe(historyPath, {
    version: 1,
    lastRunAt: null,
    items: {},
  });
  if (!listHistory.items || typeof listHistory.items !== "object") {
    listHistory.items = {};
  }

  console.log(
    `\n=== GENERATING: ${def.id} (${def.name ?? ""}) type=${listType} mode=${settings.mode} ===`,
  );
  console.log(
    `sources=${sourceDefs.map((s) => `${s.provider}:${s.path}*${s.weight}`).join(", ")} | final=${finalSize} | pages=${candidatePages} | limit=${pageLimit}`,
  );
  if (includeGenres.length) console.log("includeGenres:", includeGenres.join(","));
  if (excludeGenres.length) console.log("excludeGenres:", excludeGenres.join(","));

  const sourceReports = [];
  const aggregated = new Map();

  for (const sourceDef of sourceDefs) {
    const collected = await collectSourceItems({
      clientId,
      tmdb,
      tmdbImdbMap,
      tmdbGenresCache,
      listId: def.id,
      listType,
      sourceDef,
      apiFilters,
      pageLimit,
      timeoutMs,
      sleepMs,
      includeSet,
      excludeSet,
      sourcePolicy: settings.sources,
    });

    sourceReports.push({
      id: sourceDef.id,
      provider: sourceDef.provider,
      path: sourceDef.path,
      weight: sourceDef.weight,
      status: collected.status,
      itemCount: collected.items.length,
      error: collected.error || undefined,
      snapshotAt: collected.snapshotAt || undefined,
      candidatePages: sourceDef.candidatePages,
    });

    if (!collected.items.length) continue;

    const effectiveWeight =
      sourceDef.weight *
      (collected.usedSnapshot ? settings.sources.snapshotWeight : 1);

    const total = collected.items.length;
    for (let idx = 0; idx < total; idx++) {
      const it = collected.items[idx];
      const rankPct = (total - idx) / total;
      const rankScore = rankPct * 100;

      if (!aggregated.has(it.imdb)) {
        aggregated.set(it.imdb, {
          imdb: it.imdb,
          title: it.title,
          year: it.year,
          genres: uniqLower(it.genres || []),
          traktSignal: Number(it.traktSignal || 0),
          fusionScore: 0,
          sourceWeight: 0,
          sourceHits: {},
        });
      }

      const cur = aggregated.get(it.imdb);
      cur.fusionScore += rankScore * effectiveWeight;
      cur.sourceWeight += effectiveWeight;
      cur.traktSignal = Math.max(cur.traktSignal, Number(it.traktSignal || 0));
      cur.genres = uniqLower([...(cur.genres || []), ...(it.genres || [])]);
      cur.sourceHits[sourceDef.id] = {
        provider: sourceDef.provider,
        rank: idx + 1,
        total,
        status: collected.status,
        weight: Number(effectiveWeight.toFixed(3)),
      };
    }
  }

  const candidates = Array.from(aggregated.values());
  if (!candidates.length) {
    console.warn(`[WARN] ${def.id}: no candidates after source fusion.`);
    if (prevItems.length) {
      const atIso = nowIso();
      bumpListHistory(listHistory, prevItems, atIso);
      await writeJsonAtomic(historyPath, listHistory);
      bumpExposure(exposureState, prevItems, atIso);
      const usedCounts = usedCountsByType.get(listType);
      for (const x of prevItems) {
        const imdb = String(x?.imdb || "").trim();
        if (!imdb) continue;
        usedCounts.set(imdb, (usedCounts.get(imdb) || 0) + 1);
      }
      console.log(`[FALLBACK] ${def.id}: keeping previous list output.`);
      return {
        id: def.id,
        keptPrevious: true,
        written: false,
        selected: prevItems.length,
        overlapRatio: 1,
      };
    }
    throw new Error(`No candidates for list ${def.id} and no previous output.`);
  }

  const scored = [];
  const nowTs = Date.now();
  let processed = 0;

  for (const cand of candidates) {
    processed++;
    if (processed % 25 === 0) {
      console.log(`  scoring ${processed}/${candidates.length}...`);
    }

    const novelty = computeNoveltySignals(
      cand.imdb,
      listHistory,
      exposureState,
      settings.novelty,
      nowTs,
    );
    const sourceScoreNormalized =
      cand.sourceWeight > 0 ? cand.fusionScore / cand.sourceWeight : 0;
    const sourceBoost = sourceScoreNormalized * settings.sources.scoreWeight;

    const usedCounts = usedCountsByType.get(listType);
    const hits = usedCounts.get(cand.imdb) || 0;
    const duplicatePenalty = hits * dupRules.penaltyPerHit;

    if (listType === "movie") {
      const cs = await getCsfdInfo(cand, csfdMap, sleepMs, ttlDays);
      if (!cs?.rating) continue;

      const rules = def.csfdRules || {};
      if (Number.isFinite(rules.minRating) && cs.rating < rules.minRating)
        continue;
      if (
        Number.isFinite(rules.minCount) &&
        (cs.ratingCount || 0) < rules.minCount
      ) {
        continue;
      }
      if (
        Number.isFinite(rules.maxCount) &&
        (cs.ratingCount || 0) > rules.maxCount
      ) {
        continue;
      }

      const baseScore = computeBaseScoreMovie({
        rating: cs.rating,
        ratingCount: cs.ratingCount,
        traktSignal: cand.traktSignal,
      });

      const totalScore =
        baseScore +
        sourceBoost +
        novelty.noveltyBoost -
        novelty.exposurePenalty -
        duplicatePenalty;

      const displayName = cs.name || cand.title || cand.imdb;
      const displayYear = cs.year || cand.year;
      const ratingInfo = csfdRatingText(cs.rating, cs.ratingCount);

      scored.push({
        imdb: cand.imdb,
        name: displayName,
        year: displayYear,
        genres: cand.genres || [],
        primaryGenre: primaryGenreOf(cand.genres),
        decade: decadeOf(displayYear),
        franchiseKey: franchiseKeyOf(displayName),
        releaseInfo: displayYear
          ? `${displayYear} • ${ratingInfo}`
          : ratingInfo,
        csfdId: cs.csfdId,
        csfdRating: cs.rating,
        csfdRatingCount: cs.ratingCount,
        sourceHits: cand.sourceHits,
        sourceCount: Object.keys(cand.sourceHits || {}).length,
        sourceScoreNormalized,
        baseScore,
        totalScore,
        hits,
        novelty,
        debug: {
          baseScore,
          sourceBoost,
          sourceScoreNormalized,
          noveltyBoost: novelty.noveltyBoost,
          exposurePenalty: novelty.exposurePenalty,
          duplicatePenalty,
          sourceHits: cand.sourceHits,
          mode: settings.mode,
        },
      });
    } else {
      const baseScore = computeScoreSeries({
        year: cand.year,
        traktSignal: cand.traktSignal,
      });

      const totalScore =
        baseScore +
        sourceBoost +
        novelty.noveltyBoost -
        novelty.exposurePenalty -
        duplicatePenalty;

      const displayName = cand.title || cand.imdb;

      scored.push({
        imdb: cand.imdb,
        name: displayName,
        year: cand.year,
        genres: cand.genres || [],
        primaryGenre: primaryGenreOf(cand.genres),
        decade: decadeOf(cand.year),
        franchiseKey: franchiseKeyOf(displayName),
        releaseInfo: cand.year ? String(cand.year) : undefined,
        sourceHits: cand.sourceHits,
        sourceCount: Object.keys(cand.sourceHits || {}).length,
        sourceScoreNormalized,
        baseScore,
        totalScore,
        hits,
        novelty,
        debug: {
          baseScore,
          sourceBoost,
          sourceScoreNormalized,
          noveltyBoost: novelty.noveltyBoost,
          exposurePenalty: novelty.exposurePenalty,
          duplicatePenalty,
          sourceHits: cand.sourceHits,
          mode: settings.mode,
        },
      });
    }
  }

  if (!scored.length) {
    console.warn(`[WARN] ${def.id}: no scored entries after filtering.`);
    if (prevItems.length) {
      const atIso = nowIso();
      bumpListHistory(listHistory, prevItems, atIso);
      await writeJsonAtomic(historyPath, listHistory);
      bumpExposure(exposureState, prevItems, atIso);
      const usedCounts = usedCountsByType.get(listType);
      for (const x of prevItems) {
        const imdb = String(x?.imdb || "").trim();
        if (!imdb) continue;
        usedCounts.set(imdb, (usedCounts.get(imdb) || 0) + 1);
      }
      return {
        id: def.id,
        keptPrevious: true,
        written: false,
        selected: prevItems.length,
        overlapRatio: 1,
      };
    }
    throw new Error(`No scored entries for list ${def.id}.`);
  }

  scored.sort((a, b) => b.totalScore - a.totalScore);

  const { picked, metrics } = selectEntriesWithStrategy({
    entries: scored,
    prevItems,
    finalSize,
    listId: def.id,
    settings,
  });

  for (const x of picked) {
    const usedCounts = usedCountsByType.get(listType);
    usedCounts.set(x.imdb, (usedCounts.get(x.imdb) || 0) + 1);
  }

  const dupPicked = picked.filter((x) => (x.hits || 0) > 0).length;

  const includeDebug = settings.debugItems;
  const outItems = picked.map((x) => {
    const base = {
      imdb: x.imdb,
      name: x.name,
      year: x.year,
      genres: x.genres || [],
      releaseInfo: x.releaseInfo,
      why: buildWhySummary(x, listType),
    };

    if (listType === "movie") {
      base.csfdId = x.csfdId;
      base.csfdRating = x.csfdRating;
      base.csfdRatingCount = x.csfdRatingCount;
    }

    if (includeDebug) {
      base.debug = {
        ...x.debug,
        finalScore: Number(x.totalScore.toFixed(3)),
      };
    }

    return base;
  });

  const out = {
    id: def.id,
    name: def.name,
    type: listType,
    mode: settings.mode,
    engineVersion: ENGINE_VERSION,
    generatedAt: nowIso(),
    source: def.source ?? null,
    sources: sourceReports,
    filters: def.filters ?? {},
    strategy: {
      stableCoreRatio: settings.stability.stableCoreRatio,
      maxOverlapRatio: settings.stability.maxOverlapRatio,
      newEntrantMinRatio: settings.stability.newEntrantMinRatio,
      topWindow: settings.diversity.topWindow,
      rotationPeriod: settings.stability.rotationPeriod,
    },
    stats: {
      candidates: candidates.length,
      scored: scored.length,
      selected: outItems.length,
      overlapRatio: Number(metrics.overlapRatio.toFixed(4)),
      newEntrantRatio: Number(metrics.newEntrantRatio.toFixed(4)),
      dupPicked,
      usedSnapshots: sourceReports.filter((s) => s.status === "snapshot")
        .length,
    },
    items: outItems,
  };

  const atIso = nowIso();
  bumpListHistory(listHistory, outItems, atIso);
  listHistory.items = pruneStateMapByLast(listHistory.items, "lastSeenAt", 12000);
  await writeJsonAtomic(historyPath, listHistory);
  bumpExposure(exposureState, outItems, atIso);

  if (prev && sameSignature(prev, out)) {
    console.log(`🟨 ${def.id}: UNCHANGED -> skip write`);
  } else {
    await writeJsonAtomic(outPath, out);
    console.log(`🟩 ${def.id}: CHANGED -> written`);
  }

  console.log(
    `✅ ${def.id}: candidates=${candidates.length}, scored=${scored.length}, kept=${outItems.length}, overlap=${(metrics.overlapRatio * 100).toFixed(1)}%, new=${(metrics.newEntrantRatio * 100).toFixed(1)}%, dupPicked=${dupPicked}`,
  );

  return {
    id: def.id,
    keptPrevious: false,
    written: !prev || !sameSignature(prev, out),
    selected: outItems.length,
    overlapRatio: metrics.overlapRatio,
  };
}

function hasSourceInDef(def) {
  const srcPath = String(def?.source?.path || "").trim();
  if (srcPath) return true;

  if (Array.isArray(def?.sources) && def.sources.length) {
    return def.sources.some((s) => {
      if (typeof s === "string") return String(s || "").trim().length > 0;
      if (!s || typeof s !== "object") return false;
      return String(s.path || "").trim().length > 0;
    });
  }

  return false;
}

function validateConfig(lists, secrets) {
  const err = (m) => new Error(m);

  if (!lists || typeof lists !== "object")
    throw err("Missing /data/config/lists.trakt.json or invalid JSON.");
  if (!Array.isArray(lists.lists))
    throw err("lists.trakt.json: missing lists[] array.");

  if (!secrets || typeof secrets !== "object")
    throw err("Missing /data/config/secrets.json or invalid JSON.");
  if (!secrets.trakt || typeof secrets.trakt !== "object")
    throw err("secrets.json: missing trakt object.");
  if (!String(secrets.trakt.client_id || "").trim())
    throw err("secrets.json: missing trakt.client_id.");
  if (!String(secrets.trakt.client_secret || "").trim())
    throw err("secrets.json: missing trakt.client_secret.");

  for (const def of lists.lists) {
    if (!def || typeof def !== "object") throw err("List definition must be object.");
    if (!String(def.id || "").trim()) throw err("List is missing id.");
    if (!String(def.name || "").trim()) throw err(`List ${def.id}: missing name.`);
    if (!hasSourceInDef(def))
      throw err(`List ${def.id}: missing source.path or sources[].path.`);

    const srcDefs =
      Array.isArray(def?.sources) && def.sources.length
        ? def.sources
        : def?.source
          ? [def.source]
          : [];
    for (const src of srcDefs) {
      if (!src || typeof src !== "object") continue;
      const provider = String(src.provider || "")
        .trim()
        .toLowerCase();
      if (provider && provider !== "trakt" && provider !== "tmdb") {
        throw err(
          `List ${def.id}: unsupported source.provider '${src.provider}'. Use trakt|tmdb.`,
        );
      }
    }
  }
}

async function main() {
  await ensureDirs();

  const { clientId } = await getTraktKeys();
  const tmdb = await getTmdbKeys();
  if (!clientId) {
    throw new Error(
      "Missing Trakt Client ID (set env vars or /data/config/secrets.json).",
    );
  }

  console.log("TRAKT_CLIENT_ID set:", !!clientId);
  console.log(
    "TMDB auth:",
    tmdb.accessToken ? "access_token" : tmdb.apiKey ? "api_key" : "none",
  );
  console.log("Config path:", CONFIG_PATH);

  const config = await readJsonSafe(CONFIG_PATH, null);
  const secrets = await readJsonSafe(
    path.join(DATA_DIR, "config", "secrets.json"),
    null,
  );
  validateConfig(config, secrets);

  const defaults = config.defaults ?? {};
  console.log(
    "Loaded lists:",
    config.lists.map((x) => `${x.id}(${x.type || "movie"})`).join(", "),
  );

  const csfdMap = await readJsonSafe(CSFD_MAP_PATH, {});
  const tmdbImdbMap = await readJsonSafe(TMDB_IMDB_MAP_PATH, {});
  const exposureState = await readJsonSafe(EXPOSURE_PATH, {
    version: 1,
    lastRunAt: null,
    items: {},
  });
  if (!exposureState.items || typeof exposureState.items !== "object") {
    exposureState.items = {};
  }

  console.log("CSFD cache entries:", Object.keys(csfdMap).length);
  console.log("TMDB->IMDb cache entries:", Object.keys(tmdbImdbMap).length);
  console.log("Exposure entries:", Object.keys(exposureState.items).length);

  const tmdbGenresCache = {
    movie: null,
    tv: null,
  };

  const usedCountsByType = new Map([
    ["movie", new Map()],
    ["series", new Map()],
  ]);

  const summaries = [];
  for (const def of config.lists) {
    const summary = await generateOneList({
      clientId,
      tmdb,
      tmdbImdbMap,
      tmdbGenresCache,
      def,
      defaults,
      csfdMap,
      usedCountsByType,
      exposureState,
    });
    summaries.push(summary);
  }

  exposureState.items = pruneStateMapByLast(
    exposureState.items,
    "lastShownAt",
    15000,
  );

  await writeJsonAtomic(CSFD_MAP_PATH, csfdMap);
  await writeJsonAtomic(TMDB_IMDB_MAP_PATH, tmdbImdbMap);
  await writeJsonAtomic(EXPOSURE_PATH, exposureState);

  console.log("\nSummary:");
  for (const s of summaries) {
    console.log(
      `- ${s.id}: selected=${s.selected}, written=${s.written}, overlap=${(Number(s.overlapRatio || 0) * 100).toFixed(1)}%${s.keptPrevious ? " (fallback previous)" : ""}`,
    );
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  console.error(e);
  process.exit(1);
});
