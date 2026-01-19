import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csfd } from "node-csfd-api";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIST_DIR = path.join(__dirname, "..", "lists");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toHttps(url) {
  if (!url) return url;
  if (url.startsWith("//")) return "https:" + url;
  return url;
}

function formatCountK(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1000000) return `${Math.round(n / 100000) / 10}M`; // 1.2M
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;      // 120k / 6.7k
  return String(n);
}

async function fetchCinemetaMeta(type, imdbId) {
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const res = await fetch(url, { headers: { "user-agent": "stremio-local-addon/0.0.1" } });
  if (!res.ok) throw new Error(`Cinemeta ${res.status} for ${type} ${imdbId}`);
  const data = await res.json();
  return data?.meta;
}

// najde ČSFD ID přes search (když item nemá csfdId)
async function findCsfdIdBySearch(name, year) {
  const q = name?.trim();
  if (!q) return null;

  const results = await csfd.search(q);
  // search vrací mimo jiné results.movies[] s {id,title,year,...} :contentReference[oaicite:3]{index=3}
  const movies = results?.movies || [];

  // 1) přesná shoda roku
  if (year) {
    const exact = movies.find((m) => String(m.year) === String(year));
    if (exact?.id) return exact.id;
  }

  // 2) první rozumný výsledek
  if (movies[0]?.id) return movies[0].id;

  return null;
}

function buildCsfdRatingText(rating, ratingCount) {
  if (!Number.isFinite(rating)) return "";
  const count = Number.isFinite(ratingCount) ? ` (${formatCountK(ratingCount)})` : "";
  return `ČSFD: ${Math.round(rating)}%${count}`;
}

async function enrichItemCsfdFirst(it) {
  // musí mít imdb pro Stremio ID (tt...), ČSFD je jen enrichment
  if (!it.imdb || !it.imdb.startsWith("tt")) return { ok: false, reason: "missing_imdb" };

  let csfdId = it.csfdId;

  try {
    if (!csfdId) {
      csfdId = await findCsfdIdBySearch(it.name, it.year);
      if (csfdId) it.csfdId = csfdId;
      await sleep(120);
    }

    if (csfdId) {
      // csfd.movie(id) vrací title/year/descriptions/genres/rating/ratingCount/poster/photo... :contentReference[oaicite:4]{index=4}
      const m = await csfd.movie(Number(csfdId));
      await sleep(120);

      const csfdPoster = m.poster && !String(m.poster).startsWith("data:")
        ? toHttps(m.poster)
        : null;

      const bg = toHttps(m.photo) || csfdPoster;

      const ratingText = buildCsfdRatingText(m.rating, m.ratingCount);

      // primárně CZ popis z ČSFD: descriptions je pole, bereme první
      const descBase = Array.isArray(m.descriptions) && m.descriptions.length ? m.descriptions[0] : "";
      const desc = ratingText ? (descBase ? `${descBase}\n\n${ratingText}` : ratingText) : descBase;

      it.name = m.title || it.name;
      it.year = m.year || it.year;
      it.poster = csfdPoster || it.poster;
      it.background = bg || it.background;
      it.genres = (Array.isArray(m.genres) && m.genres.length) ? m.genres : it.genres;
      it.description = desc || it.description;

      // releaseInfo, aby se rating často ukázal i v katalogu pod názvem (záleží na klientovi)
      it.releaseInfo = (it.year && ratingText) ? `${it.year} • ${ratingText}` : (it.year || it.releaseInfo);

      return { ok: true, source: "csfd" };
    }
  } catch (e) {
    // spadne ČSFD → fallback na Cinemeta níže
  }

  // fallback Cinemeta
  try {
    if (!it.poster || !it.description || !it.genres) {
      const meta = await fetchCinemetaMeta("movie", it.imdb);
      await sleep(120);
      if (meta) {
        it.name = it.name ?? meta.name;
        it.year = it.year ?? meta.releaseInfo;
        it.poster = it.poster ?? meta.poster;
        it.background = it.background ?? (meta.background || meta.banner);
        it.genres = it.genres ?? meta.genres;
        it.description = it.description ?? meta.description;
        it.releaseInfo = it.releaseInfo ?? it.year;
        return { ok: true, source: "cinemeta" };
      }
    }
  } catch (e) {}

  return { ok: false, reason: "not_enriched" };
}

async function enrichFile(file) {
  const fullPath = path.join(LIST_DIR, file);
  const raw = await fs.readFile(fullPath, "utf8");
  const json = JSON.parse(raw);

  const items = json.items ?? [];
  let changed = 0;
  const stats = { csfd: 0, cinemeta: 0, skipped: 0 };

  for (const it of items) {
    // obohacuj jen pokud chybí poster/description/genres (ať to zbytečně neběží pořád)
    const needs = !it.poster || !it.description || !it.genres || !it.releaseInfo;
    if (!needs) {
      stats.skipped++;
      continue;
    }

    const before = JSON.stringify(it);
    const res = await enrichItemCsfdFirst(it);
    const after = JSON.stringify(it);

    if (before !== after) changed++;
    if (res.ok && res.source === "csfd") stats.csfd++;
    else if (res.ok && res.source === "cinemeta") stats.cinemeta++;
  }

  if (changed > 0) {
    await fs.writeFile(fullPath, JSON.stringify(json, null, 2), "utf8");
  }

  return { file, changed, stats };
}

async function main() {
  const files = (await fs.readdir(LIST_DIR)).filter((f) => f.endsWith(".json"));
  const results = [];
  for (const f of files) results.push(await enrichFile(f));
  console.log("Done:", results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
