import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// HA-friendly persistent paths
const DATA_DIR = process.env.DATA_DIR || "/data";
const CONFIG_PATH = path.join(DATA_DIR, "config", "lists.trakt.json");
const SECRETS_PATH = path.join(DATA_DIR, "config", "secrets.json");
const LIST_DIR = path.join(DATA_DIR, "lists");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJsonSafe(p, fallback = null) {
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
  const tmp = p + ".tmp";
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, p);
}

function todayKeyLocal() {
  // stabilní per-day
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function hashStrToUint32(str) {
  // FNV-1a
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseYearRange(s) {
  const v = String(s || "").trim();
  const m = v.match(/^(\d{4})\s*-\s*(\d{4})$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

function parseGenresCsv(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function overlapsAny(arrA, arrB) {
  if (!arrA?.length || !arrB?.length) return false;
  const setB = new Set(arrB.map((x) => String(x).toLowerCase()));
  for (const a of arrA) {
    if (setB.has(String(a).toLowerCase())) return true;
  }
  return false;
}

function inferTypeFromPath(p) {
  const s = String(p || "").toLowerCase();
  if (s.startsWith("/shows/")) return "series";
  if (s.startsWith("/movies/")) return "movie";
  return null;
}

async function traktFetch(pathname, clientId, { page = 1, limit = 100, timeoutMs = 15000 } = {}) {
  const url = new URL(`https://api.trakt.tv${pathname}`);
  url.searchParams.set("extended", "full");
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": clientId,
        "user-agent": "stremio-smart-picks/0.0.6",
      },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Trakt ${res.status} ${pathname} :: ${txt.slice(0, 200)}`);
    }

    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

function normalizeCandidate(item, type) {
  // Trakt response může být {movie:{...}} nebo {show:{...}} nebo přímo movie/show
  const obj = item?.movie || item?.show || item;
  const ids = obj?.ids || {};
  const imdb = ids?.imdb;

  if (!imdb || typeof imdb !== "string" || !imdb.startsWith("tt")) return null;

  const name = obj?.title || obj?.name;
  const year = obj?.year;
  const genres = Array.isArray(obj?.genres) ? obj.genres : [];

  return {
    imdb,
    name: name || imdb,
    year: Number.isFinite(Number(year)) ? Number(year) : undefined,
    genres,
    // releaseInfo vyplníme pro Stremio listy
    releaseInfo: Number.isFinite(Number(year)) ? String(year) : undefined,
  };
}

function applyFilters(cands, profile) {
  const yr = parseYearRange(profile?.filters?.years);
  const wantGenres = parseGenresCsv(profile?.filters?.genres);

  return cands.filter((c) => {
    if (yr && Number.isFinite(c.year)) {
      if (c.year < yr.min || c.year > yr.max) return false;
    } else if (yr) {
      // když nemá rok, necháme radši projít
    }

    if (wantGenres.length) {
      // chceme alespoň jeden shodný žánr
      if (!overlapsAny(c.genres || [], wantGenres)) return false;
    }

    return true;
  });
}

async function loadLocalListItems(listId) {
  const p = path.join(LIST_DIR, `${listId}.json`);
  const json = await readJsonSafe(p, null);
  const items = Array.isArray(json?.items) ? json.items : [];

  return items
    .filter((it) => it?.imdb && String(it.imdb).startsWith("tt"))
    .map((it) => ({
      imdb: it.imdb,
      name: it.name || it.imdb,
      year: Number.isFinite(Number(it.year)) ? Number(it.year) : undefined,
      genres: Array.isArray(it.genres) ? it.genres : [],
      releaseInfo: it.releaseInfo || (it.year ? String(it.year) : undefined),
      // necháme už existující obohacení, pokud je:
      poster: it.poster,
      background: it.background,
      description: it.description,
      csfdRating: it.csfdRating,
      csfdRatingCount: it.csfdRatingCount,
      imdbRating: it.imdbRating,
      runtime: it.runtime,
    }));
}

function pickDaily(cands, profileId, size) {
  const seed = hashStrToUint32(`${todayKeyLocal()}::${profileId}`);
  const rnd = mulberry32(seed);

  // vážený výběr: trochu preferuj “lepší” (pokud existuje csfdRating), ale pořád random
  const scored = cands.map((c) => {
    const base = Number.isFinite(c.csfdRating) ? c.csfdRating : 65;
    const jitter = rnd() * 20; // random rozptyl
    const penalty = Number.isFinite(c.csfdRatingCount)
      ? Math.min(10, (c.csfdRatingCount / 100000) * 10)
      : 0;
    return { c, s: base + jitter - penalty };
  });

  scored.sort((a, b) => b.s - a.s);

  const out = [];
  const seen = new Set();

  for (const { c } of scored) {
    if (seen.has(c.imdb)) continue;
    seen.add(c.imdb);
    out.push(c);
    if (out.length >= size) break;
  }
  return out;
}

function mergeDedupe(...arrays) {
  const map = new Map();
  for (const arr of arrays) {
    for (const c of arr || []) {
      if (!c?.imdb) continue;
      if (!map.has(c.imdb)) map.set(c.imdb, c);
      else {
        // když už existuje, zkus doplnit chybějící fields
        const cur = map.get(c.imdb);
        map.set(c.imdb, { ...c, ...cur, ...c }); // preferuje “c”, ale zachová co už bylo
      }
    }
  }
  return Array.from(map.values());
}

function stableSignature(obj) {
  return {
    id: obj?.id,
    type: obj?.type,
    // pořadí je relevantní (daily picks)
    items: Array.isArray(obj?.items) ? obj.items.map((x) => x?.imdb).filter(Boolean) : [],
  };
}

function sameSignature(a, b) {
  return JSON.stringify(stableSignature(a)) === JSON.stringify(stableSignature(b));
}

async function main() {
  const cfg = await readJsonSafe(CONFIG_PATH, null);
  if (!cfg) throw new Error(`Missing config: ${CONFIG_PATH}`);

  const secrets = await readJsonSafe(SECRETS_PATH, { trakt: { client_id: "", client_secret: "" } });
  const clientId = String(secrets?.trakt?.client_id || "").trim();
  if (!clientId) throw new Error(`Missing secrets.trakt.client_id in ${SECRETS_PATH}`);

  const sp = cfg.smartPicks;
  if (!sp?.enabled) {
    console.log("Smart Picks disabled (smartPicks.enabled=false). Nothing to do.");
    return;
  }

  const defaults = cfg.defaults || {};
  const sleepMs = Number.isFinite(Number(defaults.sleepMs)) ? Number(defaults.sleepMs) : 120;
  const timeoutMs = Number.isFinite(Number(defaults.timeoutMs)) ? Number(defaults.timeoutMs) : 15000;

  const profiles = Array.isArray(sp.profiles) ? sp.profiles : [];
  const defaultSize = Number.isFinite(Number(sp.defaultSize)) ? Number(sp.defaultSize) : 10;

  await fs.mkdir(LIST_DIR, { recursive: true });

  for (const profile of profiles) {
    const pid = String(profile?.id || "").trim();
    const ptype = String(profile?.type || "").trim();
    if (!pid) continue;
    if (ptype !== "movie" && ptype !== "series") continue;

    const size = Number.isFinite(Number(profile.size)) ? Number(profile.size) : defaultSize;

    let fromTrakt = Array.isArray(profile.fromTrakt) ? profile.fromTrakt : [];
    let fromLists = Array.isArray(profile.fromLists) ? profile.fromLists : [];

    const hasAnyFilter =
      !!String(profile?.filters?.years || "").trim() ||
      !!String(profile?.filters?.genres || "").trim() ||
      (Array.isArray(profile?.includeGenres) && profile.includeGenres.length) ||
      (Array.isArray(profile?.excludeGenres) && profile.excludeGenres.length);

    // fallback: když uživatel odškrtne vše a nechá jen žánry/roky,
    // vezmeme aspoň široké Trakt seedy, aby bylo z čeho filtrovat.
    if (!fromTrakt.length && !fromLists.length && hasAnyFilter) {
      fromTrakt =
        ptype === "series"
          ? ["/shows/trending", "/shows/popular"]
          : ["/movies/trending", "/movies/popular"];
      console.log(`  [fallback] no sources selected -> using ${fromTrakt.join(", ")}`);
    }

    console.log(`\n[SmartPicks] ${pid} (${ptype}) size=${size}`);
    console.log(`  fromTrakt: ${fromTrakt.length ? fromTrakt.join(", ") : "(none)"}`);
    console.log(`  fromLists: ${fromLists.length ? fromLists.join(", ") : "(none)"}`);

    // 1) local candidates
    const localAll = [];
    for (const lid of fromLists) {
      try {
        const items = await loadLocalListItems(lid);
        localAll.push(...items);
      } catch (e) {
        console.warn(`  WARN: failed to read list ${lid}: ${e?.message || e}`);
      }
    }

    // 2) trakt candidates
    const traktAll = [];
    for (const src of fromTrakt) {
      const srcPath = String(src || "").trim();
      if (!srcPath.startsWith("/")) continue;

      const inferred = inferTypeFromPath(srcPath);
      if (inferred && inferred !== ptype) {
        console.warn(`  WARN: skipping ${srcPath} because it looks like ${inferred}, profile is ${ptype}`);
        continue;
      }

      // pages/limit per profile overrides, fallback defaults
      const candidatePages = Number.isFinite(Number(profile.candidatePages))
        ? Number(profile.candidatePages)
        : (Number.isFinite(Number(defaults.candidatePages)) ? Number(defaults.candidatePages) : 5);

      const pageLimit = Number.isFinite(Number(profile.pageLimit))
        ? Number(profile.pageLimit)
        : (Number.isFinite(Number(defaults.pageLimit)) ? Number(defaults.pageLimit) : 100);

      for (let p = 1; p <= candidatePages; p++) {
        try {
          const data = await traktFetch(srcPath, clientId, { page: p, limit: pageLimit, timeoutMs });
          await sleep(sleepMs);

          for (const row of Array.isArray(data) ? data : []) {
            const cand = normalizeCandidate(row, ptype);
            if (cand) traktAll.push(cand);
          }
        } catch (e) {
          console.warn(`  WARN: trakt fetch failed ${srcPath} page=${p}: ${e?.message || e}`);
          break;
        }
      }
    }

    // merge + filter
    let merged = mergeDedupe(localAll, traktAll);
    merged = applyFilters(merged, profile);

    // volitelně soft CSFD filtry (pokud už položky mají csfdRating z dřívějška)
    if (ptype === "movie" && profile.csfdRules) {
      const minRating = Number.isFinite(Number(profile.csfdRules.minRating)) ? Number(profile.csfdRules.minRating) : null;
      const minCount = Number.isFinite(Number(profile.csfdRules.minCount)) ? Number(profile.csfdRules.minCount) : null;
      const maxCount = Number.isFinite(Number(profile.csfdRules.maxCount)) ? Number(profile.csfdRules.maxCount) : null;

      merged = merged.filter((c) => {
        // pokud rating/count neznáme, necháme projít (dofiltrované po enrich v dalších bězích)
        if (minRating !== null && Number.isFinite(c.csfdRating) && c.csfdRating < minRating) return false;
        if (minCount !== null && Number.isFinite(c.csfdRatingCount) && c.csfdRatingCount < minCount) return false;
        if (maxCount !== null && Number.isFinite(c.csfdRatingCount) && c.csfdRatingCount > maxCount) return false;
        return true;
      });
    }

    const picked = pickDaily(merged, pid, size);

    const out = {
      id: pid,
      name: profile.name || pid,
      type: ptype,
      generatedAt: new Date().toISOString(),
      items: picked.map((c) => ({
        imdb: c.imdb,
        name: c.name,
        year: c.year,
        genres: c.genres,
        releaseInfo: c.releaseInfo || (c.year ? String(c.year) : undefined),
        poster: c.poster,
        background: c.background,
        description: c.description,
        csfdRating: c.csfdRating,
        csfdRatingCount: c.csfdRatingCount,
        imdbRating: c.imdbRating,
        runtime: c.runtime,
      })),
    };

    const outPath = path.join(LIST_DIR, `${pid}.json`);

    // ✅ Odlehčení: když se items nezměnily, nepiš (generatedAt by jinak vždy změnilo soubor)
    let prev = null;
    if (await fileExists(outPath)) {
      prev = await readJsonSafe(outPath, null);
    }

    if (prev && sameSignature(prev, out)) {
      console.log(`  🟨 ${pid}: UNCHANGED -> skip write (items=${out.items.length}, candidates=${merged.length})`);
    } else {
      await writeJsonAtomic(outPath, out);
      console.log(`  🟩 ${pid}: CHANGED -> written (items=${out.items.length}, candidates=${merged.length})`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
