import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIST_DIR = path.join(__dirname, "..", "lists");

// malá pauza mezi requesty (ať nejsi “agresivní”)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCinemetaMeta(type, imdbId) {
  // Cinemeta endpoint (veřejný)
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const res = await fetch(url, { headers: { "user-agent": "stremio-local-addon/0.0.1" } });
  if (!res.ok) throw new Error(`Cinemeta ${res.status} for ${type} ${imdbId}`);
  const data = await res.json();
  return data?.meta;
}

async function enrichFile(file) {
  const fullPath = path.join(LIST_DIR, file);
  const raw = await fs.readFile(fullPath, "utf8");
  const json = JSON.parse(raw);

  const items = json.items ?? [];
  let changed = 0;

  for (const it of items) {
    if (!it.imdb || !it.imdb.startsWith("tt")) continue;
    if (it.poster) continue; // už je obohacené

    const meta = await fetchCinemetaMeta("movie", it.imdb);
    if (!meta) continue;

    it.name = it.name ?? meta.name;
    it.year = it.year ?? meta.releaseInfo;
    it.poster = meta.poster;
    it.background = meta.background || meta.banner;
    it.genres = meta.genres;
    it.description = meta.description;

    changed++;
    await sleep(120); // jemné tempo
  }

  if (changed > 0) {
    await fs.writeFile(fullPath, JSON.stringify(json, null, 2), "utf8");
  }

  return { file, changed };
}

async function main() {
  const files = (await fs.readdir(LIST_DIR)).filter((f) => f.endsWith(".json"));
  const results = [];
  for (const f of files) {
    results.push(await enrichFile(f));
  }
  console.log("Done:", results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
