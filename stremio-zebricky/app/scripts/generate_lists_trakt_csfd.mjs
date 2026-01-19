import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csfd } from "node-csfd-api";
import { getTraktKeys } from "./_secrets.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || "/data";
const LIST_DIR = path.join(DATA_DIR, "lists");
const CONFIG_PATH = path.join(DATA_DIR, "config", "lists.trakt.json");
const CACHE_DIR = path.join(DATA_DIR, "runtime", "cache");

const CSFD_MAP_PATH = path.join(CACHE_DIR, "csfd_map.json");

const TRAKT_BASE = "https://api.trakt.tv";
const DEFAULT_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDirs() {
  await fs.mkdir(LIST_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
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

function stableListSignature(obj) {
  return {
    id: obj.id,
    type: obj.type,
    // bereme pořadí jako relevantní; pokud chceš ignorovat pořadí, dej .sort()
    items: (obj.items || []).map((x) => x.imdb),
    source: obj.source,
    filters: obj.filters,
  };
}

function sameSignature(a, b) {
  return (
    JSON.stringify(stableListSignature(a)) ===
    JSON.stringify(stableListSignature(b))
  );
}

function buildUrl(pathname, params = {}) {
  const url = new URL(TRAKT_BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
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
  const url = buildUrl(pathname, params);

  console.log(`[TRAKT] GET ${pathname} page=${page} limit=${limit}`);

  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        "Content-Type": "application/json",
        "trakt-api-key": clientId,
        "trakt-api-version": "2",
        "user-agent": "stremio-local-addon/0.0.6",
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
    )
      return true;
  }
  return false;
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

  // DŮLEŽITÉ: potřebujeme genres pro lokální exclude filtr
  const genres = Array.isArray(obj?.genres) ? uniqLower(obj.genres) : [];

  return { imdb, title, year, traktSignal, genres };
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
  return `ČSFD: ${Math.round(rating)}%${cnt}`;
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

  if (cached?.last) {
    const ageMs = Date.now() - cached.last;
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    if (ageMs < ttlMs && cached.csfdId !== undefined) {
      return cached.csfdId
        ? {
            csfdId: cached.csfdId,
            rating: cached.rating,
            ratingCount: cached.ratingCount,
            name: cached.name,
            year: cached.year,
          }
        : null;
    }
  }

  let csfdId = cached?.csfdId ?? null;

  try {
    if (!csfdId) csfdId = await findCsfdIdBySearch(title, year, sleepMs);

    if (!csfdId) {
      csfdMap[imdb] = { csfdId: null, last: Date.now() };
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
      last: Date.now(),
    };

    return { csfdId: Number(csfdId), rating, ratingCount, name, year: y };
  } catch {
    csfdMap[imdb] = {
      csfdId: csfdId ? Number(csfdId) : null,
      last: Date.now(),
    };
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

async function generateOneList({
  clientId,
  def,
  defaults,
  csfdMap,
  usedCountsByType,
}) {
  const listType = def.type || "movie";

  const candidatePages = def.candidatePages ?? defaults.candidatePages ?? 5;
  const pageLimit = def.pageLimit ?? defaults.pageLimit ?? 100;
  const finalSize = def.finalSize ?? defaults.finalSize ?? 140;
  const sleepMs = def.sleepMs ?? defaults.sleepMs ?? 120;
  const timeoutMs = def.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlDays = def.csfdCacheTtlDays ?? defaults.csfdCacheTtlDays ?? 30;

  const filters = def.filters ?? {};
  const source = def.source;
  const dupRules = pickDupRules(def, defaults);

  // Include genres (Trakt query) + Exclude genres (local filter)
  const includeGenres = uniqLower(parseCsv(filters.genres || ""));
  const excludeGenres = uniqLower(
    parseCsv(
      filters.genresExclude ||
        filters.excludeGenres || // kompatibilita, kdyby ses rozhodl pojmenovat jinak
        "",
    ),
  );
  const excludeSet = new Set(excludeGenres);

  // Do Trakt API NEposílej exclude klíče (Trakt je nezná)
  const apiFilters = { ...(filters || {}) };
  delete apiFilters.genresExclude;
  delete apiFilters.excludeGenres;

  console.log(
    `\n=== GENERATING: ${def.id} (${def.name ?? ""}) type=${listType} ===`,
  );
  console.log(
    `source: ${source?.path} | pages=${candidatePages} | limit=${pageLimit} | final=${finalSize}`,
  );
  if (Object.keys(filters).length) console.log("filters:", filters);
  if (includeGenres.length)
    console.log("includeGenres:", includeGenres.join(","));
  if (excludeGenres.length)
    console.log("excludeGenres:", excludeGenres.join(","));
  console.log(
    `dupRules: hardBlockTop=${dupRules.hardBlockTop}, penaltyPerHit=${dupRules.penaltyPerHit}`,
  );

  const candidates = new Map();

  for (let page = 1; page <= candidatePages; page++) {
    const data = await fetchTraktPage({
      clientId,
      pathname: source.path,
      filters: apiFilters,
      page,
      limit: pageLimit,
      timeoutMs,
    });

    for (const raw of data) {
      const it = normalizeTraktItem(raw, listType);
      if (!it.imdb || !String(it.imdb).startsWith("tt")) continue;

      // Local exclude: pokud item má některý zakázaný žánr, zahodíme ho hned
      if (excludeSet.size && hasAnyIntersection(it.genres, excludeSet))
        continue;

      if (!candidates.has(it.imdb)) candidates.set(it.imdb, it);
    }

    console.log(`  [TRAKT] candidates so far: ${candidates.size}`);
    await sleep(sleepMs);
  }

  const enriched = [];
  let processed = 0;

  for (const it of candidates.values()) {
    processed++;
    if (processed % 25 === 0)
      console.log(`  progress ${processed}/${candidates.size}...`);

    if (listType === "movie") {
      const cs = await getCsfdInfo(it, csfdMap, sleepMs, ttlDays);
      if (!cs?.rating) continue;

      const rules = def.csfdRules || {};
      if (Number.isFinite(rules.minRating) && cs.rating < rules.minRating)
        continue;
      if (
        Number.isFinite(rules.minCount) &&
        (cs.ratingCount || 0) < rules.minCount
      )
        continue;
      if (
        Number.isFinite(rules.maxCount) &&
        (cs.ratingCount || 0) > rules.maxCount
      )
        continue;

      const baseScore = computeBaseScoreMovie({
        rating: cs.rating,
        ratingCount: cs.ratingCount,
        traktSignal: it.traktSignal,
      });

      const usedCounts = usedCountsByType.get("movie");
      const hits = usedCounts.get(it.imdb) || 0;
      const adjustedScore = baseScore - hits * dupRules.penaltyPerHit;

      enriched.push({
        imdb: it.imdb,
        name: cs.name,
        year: cs.year,
        csfdId: cs.csfdId,
        csfdRating: cs.rating,
        csfdRatingCount: cs.ratingCount,
        adjustedScore,
        hits,
        releaseInfo: cs.year
          ? `${cs.year} • ${csfdRatingText(cs.rating, cs.ratingCount)}`
          : csfdRatingText(cs.rating, cs.ratingCount),
      });
    } else {
      const score = computeScoreSeries({
        year: it.year,
        traktSignal: it.traktSignal,
      });

      const usedCounts = usedCountsByType.get("series");
      const hits = usedCounts.get(it.imdb) || 0;
      const adjustedScore = score - hits * dupRules.penaltyPerHit;

      enriched.push({
        imdb: it.imdb,
        name: it.title,
        year: it.year,
        adjustedScore,
        hits,
        releaseInfo: it.year ? String(it.year) : undefined,
      });
    }
  }

  enriched.sort(
    (a, b) => (b.adjustedScore ?? -Infinity) - (a.adjustedScore ?? -Infinity),
  );

  const usedCounts = usedCountsByType.get(listType);
  const picked = [];
  const pickedSet = new Set();

  for (const x of enriched) {
    if (picked.length >= finalSize) break;
    if (pickedSet.has(x.imdb)) continue;

    const alreadyUsed = (usedCounts.get(x.imdb) || 0) > 0;
    if (picked.length < dupRules.hardBlockTop && alreadyUsed) continue;

    picked.push(x);
    pickedSet.add(x.imdb);
  }

  if (picked.length < finalSize) {
    for (const x of enriched) {
      if (picked.length >= finalSize) break;
      if (pickedSet.has(x.imdb)) continue;
      picked.push(x);
      pickedSet.add(x.imdb);
    }
  }

  for (const x of picked) {
    usedCounts.set(x.imdb, (usedCounts.get(x.imdb) || 0) + 1);
  }

  const out = {
    id: def.id,
    name: def.name,
    type: listType,
    generatedAt: new Date().toISOString(),
    source: def.source,
    filters: def.filters ?? {},
    items: picked.map((x) => ({
      imdb: x.imdb,
      name: x.name,
      year: x.year,
      releaseInfo: x.releaseInfo,
      csfdId: x.csfdId,
      csfdRating: x.csfdRating,
      csfdRatingCount: x.csfdRatingCount,
    })),
  };

  const outPath = path.join(LIST_DIR, `${def.id}.json`);

  // ✅ Odlehčení: když se items (a klíčové parametry) nezměnily, nepiš nic
  let prev = null;
  if (await fileExists(outPath)) {
    prev = await readJsonSafe(outPath, null);
  }

  if (prev && sameSignature(prev, out)) {
    console.log(`🟨 ${def.id}: UNCHANGED -> skip write`);
  } else {
    await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
    console.log(`🟩 ${def.id}: CHANGED -> written`);
  }

  const dupPicked = picked.filter((x) => (x.hits || 0) > 0).length;
  console.log(
    `✅ ${def.id}: candidates=${candidates.size}, kept=${picked.length}, dupPicked=${dupPicked}`,
  );
}

async function main() {
  await ensureDirs();

  const { clientId } = await getTraktKeys();
  if (!clientId)
    throw new Error(
      "Chybí Trakt Client ID (nastav env nebo config/secrets.json).",
    );

  console.log("TRAKT_CLIENT_ID set:", !!clientId);
  console.log("Config path:", CONFIG_PATH);

  const config = await readJsonSafe(CONFIG_PATH, null);
  if (!config?.lists?.length)
    throw new Error(`Chybí nebo je prázdný config: ${CONFIG_PATH}`);

  const defaults = config.defaults ?? {};
  console.log(
    "Loaded lists:",
    config.lists.map((x) => `${x.id}(${x.type || "movie"})`).join(", "),
  );

  const csfdMap = await readJsonSafe(CSFD_MAP_PATH, {});
  console.log("CSFD cache entries:", Object.keys(csfdMap).length);

  const usedCountsByType = new Map([
    ["movie", new Map()],
    ["series", new Map()],
  ]);

  for (const def of config.lists) {
    await generateOneList({
      clientId,
      def,
      defaults,
      csfdMap,
      usedCountsByType,
    });
  }

  await fs.writeFile(CSFD_MAP_PATH, JSON.stringify(csfdMap, null, 2), "utf8");
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  console.error(e);
  process.exit(1);
});
