const fs = require("node:fs");
const path = require("node:path");
const cron = require("node-cron");
const express = require("express");
const { loadConfig, redactConfig } = require("./config");
const { createLogger } = require("./logger");
const { createDatabase } = require("./database");
const { createScanner } = require("./scanner");
const { buildStreamResponse, sendFileStream, verifyFileReadable } = require("./stream");
const { hashText } = require("./metadata");

const DATA_DIR = process.env.DATA_DIR || "/data";
const config = loadConfig();
const logger = createLogger(config.logging.level);
const database = createDatabase(DATA_DIR);
const scanner = createScanner({ config, database, logger, dataDir: DATA_DIR });
const app = express();

let intervalTimer = null;
let cronTask = null;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

function ensureRuntimeDirs() {
  for (const relativePath of ["posters", "backdrops", "metadata", "logs"]) {
    fs.mkdirSync(path.join(DATA_DIR, relativePath), { recursive: true });
  }
}

function isPrivateIp(ipAddress) {
  const normalized = String(ipAddress || "")
    .replace(/^::ffff:/, "")
    .replace(/^\[|\]$/g, "");

  if (!normalized) {
    return false;
  }

  if (normalized === "127.0.0.1" || normalized === "::1") {
    return true;
  }

  if (normalized.startsWith("10.") || normalized.startsWith("192.168.")) {
    return true;
  }

  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) {
    return true;
  }

  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }

  return false;
}

function getClientIp(req) {
  const remoteAddress = req.socket.remoteAddress || req.ip || "";
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded && isPrivateIp(remoteAddress)) {
    return String(forwarded).split(",")[0].trim();
  }
  return req.ip || remoteAddress || "";
}

function buildSeriesGroupId(item) {
  if (item.imdb_id) {
    return item.imdb_id;
  }

  const seed = `${item.title || "series"}:${item.year || ""}`;
  return `nas_series_show_${hashText(seed)}`;
}

function buildPosterUrl(assetPath) {
  if (!assetPath) {
    return null;
  }

  if (/^https?:\/\//i.test(assetPath)) {
    return assetPath;
  }

  return `${config.server.public_base_url}${assetPath.startsWith("/") ? assetPath : `/${assetPath}`}`;
}

function buildManifest() {
  const catalogs = config.media.paths.map((entry) => ({
    type: entry.type,
    id: entry.catalog_id,
    name: entry.type === "movie" ? "NAS Filmy" : "NAS Seriály",
    extra: [
      {
        name: "search",
        isRequired: false
      }
    ]
  }));

  return {
    id: "local.nas.stremio.bridge",
    version: "0.1.0",
    name: "NAS Stremio Bridge",
    description: "Local NAS media catalog served from Home Assistant",
    types: ["movie", "series"],
    catalogs,
    resources: [
      "catalog",
      "meta",
      {
        name: "stream",
        types: ["movie", "series"],
        idPrefixes: ["tt", "nas_"]
      }
    ],
    idPrefixes: ["tt", "nas_"],
    behaviorHints: {
      configurable: false
    }
  };
}

function buildMovieMeta(item) {
  return {
    id: item.stremio_id,
    type: "movie",
    name: item.title,
    poster: buildPosterUrl(item.poster_path),
    background: buildPosterUrl(item.backdrop_path),
    description: item.overview || "",
    releaseInfo: item.year ? String(item.year) : "",
    year: item.year || undefined
  };
}

function buildSeriesMeta(groupId, rows) {
  const first = rows[0];
  const videos = rows
    .filter((row) => row.season && row.episode)
    .map((row) => ({
      id: row.stremio_id,
      title: row.title,
      season: row.season,
      episode: row.episode,
      released: row.year ? `${row.year}-01-01` : undefined
    }));

  return {
    id: groupId,
    type: "series",
    name: first.title,
    poster: buildPosterUrl(first.poster_path),
    background: buildPosterUrl(first.backdrop_path),
    description: first.overview || "",
    releaseInfo: first.year ? String(first.year) : "",
    videos
  };
}

function maybeTriggerCatalogScan() {
  if (!config.scan.scan_on_catalog_open) {
    return;
  }

  scanner.runScan().catch((error) => {
    logger.warn(`Background scan trigger failed: ${error.message}`);
  });
}

function groupSeriesRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const groupId = buildSeriesGroupId(row);
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
    }
    groups.get(groupId).push(row);
  }
  return groups;
}

function normalizeSearchValue(rawValue) {
  return String(rawValue || "").trim();
}

function formatTimestamp(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) {
    return "n/a";
  }

  return new Date(value * 1000).toISOString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHomePage(status) {
  const manifestUrl = `${config.server.public_base_url}/manifest.json`;
  const catalogs = config.media.paths.map((entry) => `${entry.type}: ${entry.catalog_id} -> ${entry.path}`);
  return `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NAS Stremio Bridge</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f3efe6;
      --card: #fffaf1;
      --ink: #1f2933;
      --muted: #52606d;
      --line: #d9cbb5;
      --accent: #0f766e;
      --accent-2: #b45309;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(180, 83, 9, 0.12), transparent 28%),
        radial-gradient(circle at bottom right, rgba(15, 118, 110, 0.15), transparent 30%),
        var(--bg);
    }
    main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 48px; }
    .hero {
      display: grid;
      gap: 18px;
      margin-bottom: 22px;
    }
    .hero h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 3.5rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }
    .hero p { margin: 0; max-width: 70ch; color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin-bottom: 16px;
    }
    .card {
      background: rgba(255, 250, 241, 0.92);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 18px;
      box-shadow: 0 10px 30px rgba(31, 41, 51, 0.05);
    }
    .eyebrow {
      margin: 0 0 8px;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--accent-2);
    }
    .value {
      font-size: 1.7rem;
      font-weight: 700;
      margin: 0 0 4px;
    }
    .small { color: var(--muted); font-size: 0.95rem; }
    .mono {
      font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
      overflow-wrap: anywhere;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 14px 0;
    }
    button, input {
      border-radius: 12px;
      border: 1px solid var(--line);
      padding: 12px 14px;
      font: inherit;
    }
    input { min-width: min(100%, 320px); background: #fff; }
    button {
      background: var(--accent);
      color: white;
      cursor: pointer;
      border: none;
      font-weight: 600;
    }
    button.secondary { background: #334e68; }
    button.ghost { background: #fff; color: var(--ink); border: 1px solid var(--line); }
    a { color: var(--accent); }
    ul { margin: 0; padding-left: 18px; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      min-height: 110px;
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <p class="eyebrow">Home Assistant Add-on</p>
      <h1>NAS Stremio Bridge</h1>
      <p>Lokální Stremio add-on server pro NAS knihovnu. Katalog, metadata i search jedou z SQLite cache, NAS se čte až při scanu nebo při skutečném přehrávání souboru.</p>
    </section>

    <section class="grid">
      <article class="card">
        <p class="eyebrow">Manifest</p>
        <p class="value"><a class="mono" href="${escapeHtml(manifestUrl)}">${escapeHtml(manifestUrl)}</a></p>
        <p class="small">Přidej tuto URL do Stremia.</p>
      </article>
      <article class="card">
        <p class="eyebrow">Scanner</p>
        <p class="value">${status.scanner_running ? "Running" : "Idle"}</p>
        <p class="small">Poslední úspěšný scan: ${escapeHtml(formatTimestamp(status.last_successful_scan_at))}</p>
      </article>
      <article class="card">
        <p class="eyebrow">Příští scan</p>
        <p class="value">${escapeHtml(formatTimestamp(status.next_scheduled_scan_at))}</p>
        <p class="small">Režim: ${escapeHtml(config.scan.mode)}</p>
      </article>
    </section>

    <section class="grid">
      <article class="card">
        <p class="eyebrow">Knihovna</p>
        <p class="small">Filmy: ${escapeHtml(status.movies_total)}</p>
        <p class="small">Seriály: ${escapeHtml(status.series_total)}</p>
        <p class="small">Epizody: ${escapeHtml(status.episodes_total)}</p>
        <p class="small">Nejasné položky: ${escapeHtml(status.unmatched_total)}</p>
      </article>
      <article class="card">
        <p class="eyebrow">Admin API</p>
        <p class="small">Povoleno: ${config.security.expose_admin_api ? "ano" : "ne"}</p>
        <p class="small">Token nastavený: ${config.security.admin_token ? "ano" : "ne"}</p>
        <p class="small">LAN only: ${config.security.allow_lan_only ? "ano" : "ne"}</p>
      </article>
      <article class="card">
        <p class="eyebrow">Katalogy</p>
        <ul>${catalogs.map((entry) => `<li class="small mono">${escapeHtml(entry)}</li>`).join("")}</ul>
      </article>
    </section>

    <section class="card">
      <p class="eyebrow">Quick Actions</p>
      <div class="toolbar">
        <input id="adminToken" type="password" placeholder="Bearer token pro /admin API">
        <button type="button" id="scanButton">Spustit light scan</button>
        <button type="button" class="secondary" id="statusButton">Načíst admin status</button>
        <button type="button" class="ghost" id="unmatchedButton">Načíst unmatched</button>
      </div>
      <pre id="output">Ready.</pre>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById("adminToken");
    const output = document.getElementById("output");
    const storageKey = "nas-stremio-bridge-admin-token";
    tokenInput.value = localStorage.getItem(storageKey) || "";
    tokenInput.addEventListener("input", () => localStorage.setItem(storageKey, tokenInput.value));

    async function callApi(path, options = {}) {
      const headers = Object.assign({}, options.headers || {});
      if (tokenInput.value) {
        headers.Authorization = "Bearer " + tokenInput.value;
      }
      const response = await fetch(path, Object.assign({}, options, { headers }));
      const text = await response.text();
      try {
        return { ok: response.ok, status: response.status, body: JSON.parse(text) };
      } catch (_) {
        return { ok: response.ok, status: response.status, body: text };
      }
    }

    document.getElementById("scanButton").addEventListener("click", async () => {
      output.textContent = "Spoustim scan...";
      const result = await callApi("/admin/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scan_type: "light", force_metadata_refresh: false })
      });
      output.textContent = JSON.stringify(result, null, 2);
    });

    document.getElementById("statusButton").addEventListener("click", async () => {
      output.textContent = "Nacitam status...";
      const result = await callApi("/admin/status");
      output.textContent = JSON.stringify(result, null, 2);
    });

    document.getElementById("unmatchedButton").addEventListener("click", async () => {
      output.textContent = "Nacitam unmatched...";
      const result = await callApi("/admin/unmatched");
      output.textContent = JSON.stringify(result, null, 2);
    });
  </script>
</body>
</html>`;
}

function adminEnabled(req, res, next) {
  if (!config.security.expose_admin_api) {
    res.status(404).json({ error: "Admin API is disabled" });
    return;
  }

  if (!config.security.admin_token) {
    res.status(503).json({ error: "Admin API token is not configured" });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const expected = `Bearer ${config.security.admin_token}`;
  if (authHeader !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

function updateCronNextRunState() {
  if (!cronTask || typeof cronTask.getNextRun !== "function") {
    database.setState("next_scheduled_scan_at", "0");
    return;
  }

  const nextRun = cronTask.getNextRun();
  const nextTs = nextRun instanceof Date ? Math.floor(nextRun.getTime() / 1000) : 0;
  database.setState("next_scheduled_scan_at", String(nextTs || 0));
}

function computeNextIntervalDate(fromDate = new Date()) {
  const nextDate = new Date(fromDate.getTime());
  const amount = Number(config.scan.interval_value) || 1;
  const unit = config.scan.interval_unit;

  switch (unit) {
    case "minutes":
      nextDate.setMinutes(nextDate.getMinutes() + amount);
      break;
    case "hours":
      nextDate.setHours(nextDate.getHours() + amount);
      break;
    case "days":
      nextDate.setDate(nextDate.getDate() + amount);
      break;
    case "weeks":
      nextDate.setDate(nextDate.getDate() + (amount * 7));
      break;
    case "months":
      nextDate.setMonth(nextDate.getMonth() + amount);
      break;
    case "years":
      nextDate.setFullYear(nextDate.getFullYear() + amount);
      break;
    default:
      nextDate.setMonth(nextDate.getMonth() + amount);
  }

  return nextDate;
}

function scheduleNextIntervalScan(targetDate) {
  if (intervalTimer) {
    clearTimeout(intervalTimer);
    intervalTimer = null;
  }

  if (config.scan.mode !== "interval") {
    database.setState("next_scheduled_scan_at", "0");
    return;
  }

  const nextDate = targetDate instanceof Date ? targetDate : computeNextIntervalDate(new Date());
  const nextTimestamp = Math.floor(nextDate.getTime() / 1000);
  database.setState("next_scheduled_scan_at", String(nextTimestamp));

  const targetMs = nextDate.getTime();

  const armTimer = () => {
    const remainingMs = targetMs - Date.now();
    if (remainingMs <= 1000) {
      intervalTimer = setTimeout(async () => {
        try {
          const result = await scanner.runScan();
          await result.promise;
        } catch (error) {
          logger.error(`Scheduled interval scan failed: ${error.message}`);
        } finally {
          const lastSuccessfulScanAt = Number(database.getState("last_successful_scan_at") || 0);
          const baseDate = lastSuccessfulScanAt > 0 ? new Date(lastSuccessfulScanAt * 1000) : new Date();
          scheduleNextIntervalScan(computeNextIntervalDate(baseDate));
        }
      }, 1000);
      return;
    }

    intervalTimer = setTimeout(() => {
      armTimer();
    }, Math.min(MAX_TIMEOUT_MS, remainingMs));
  };

  armTimer();
}

function setupScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }

  if (config.scan.mode === "interval") {
    const storedNextScanAt = Number(database.getState("next_scheduled_scan_at") || 0);
    const targetDate = storedNextScanAt > 0 ? new Date(storedNextScanAt * 1000) : computeNextIntervalDate(new Date());
    scheduleNextIntervalScan(targetDate);
    return;
  }

  database.setState("next_scheduled_scan_at", "0");

  if (config.scan.mode === "cron") {
    cronTask = cron.schedule(config.scan.cron, async () => {
      updateCronNextRunState();
      try {
        const result = await scanner.runScan();
        await result.promise;
      } catch (error) {
        logger.error(`Scheduled cron scan failed: ${error.message}`);
      }
    });
    updateCronNextRunState();
  }
}

function observeScanResult(result) {
  if (!result || !result.promise) {
    return;
  }

  result.promise.finally(() => {
    if (config.scan.mode === "interval") {
      const lastSuccessfulScanAt = Number(database.getState("last_successful_scan_at") || 0);
      const baseDate = lastSuccessfulScanAt > 0 ? new Date(lastSuccessfulScanAt * 1000) : new Date();
      scheduleNextIntervalScan(computeNextIntervalDate(baseDate));
      return;
    }

    if (config.scan.mode === "cron") {
      updateCronNextRunState();
    }
  }).catch(() => {});
}

function bindMiddleware() {
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  if (config.server.enable_cors) {
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });
  }

  if (config.security.allow_lan_only) {
    app.use((req, res, next) => {
      const clientIp = getClientIp(req);
      if (!isPrivateIp(clientIp)) {
        res.status(403).json({ error: "LAN-only mode enabled" });
        return;
      }
      next();
    });
  }

  app.use("/posters", express.static(path.join(DATA_DIR, "posters"), { fallthrough: false, maxAge: "7d" }));
  app.use("/backdrops", express.static(path.join(DATA_DIR, "backdrops"), { fallthrough: false, maxAge: "7d" }));
}

function bindRoutes() {
  app.get("/manifest.json", (req, res) => {
    res.json(buildManifest());
  });

  app.get("/catalog/movie/:catalogId.json", (req, res) => {
    maybeTriggerCatalogScan();
    const catalog = config.media.paths.find((entry) => entry.catalog_id === req.params.catalogId && entry.type === "movie");
    if (!catalog) {
      res.status(404).json({ error: "Unknown movie catalog" });
      return;
    }

    const items = database.listMoviesByCatalogPath(catalog.path);
    res.json({
      metas: items.map((item) => ({
        id: item.stremio_id,
        type: "movie",
        name: item.title,
        poster: buildPosterUrl(item.poster_path),
        year: item.year || undefined
      }))
    });
  });

  app.get("/catalog/movie/:catalogId/search=:search.json", (req, res) => {
    maybeTriggerCatalogScan();
    const catalog = config.media.paths.find((entry) => entry.catalog_id === req.params.catalogId && entry.type === "movie");
    if (!catalog) {
      res.status(404).json({ error: "Unknown movie catalog" });
      return;
    }

    const searchValue = normalizeSearchValue(req.params.search);
    const items = searchValue ? database.searchMoviesByCatalogPath(catalog.path, searchValue) : [];
    res.json({
      metas: items.map((item) => ({
        id: item.stremio_id,
        type: "movie",
        name: item.title,
        poster: buildPosterUrl(item.poster_path),
        year: item.year || undefined
      }))
    });
  });

  app.get("/catalog/series/:catalogId.json", (req, res) => {
    maybeTriggerCatalogScan();
    const catalog = config.media.paths.find((entry) => entry.catalog_id === req.params.catalogId && entry.type === "series");
    if (!catalog) {
      res.status(404).json({ error: "Unknown series catalog" });
      return;
    }

    const rows = database.listSeriesByCatalogPath(catalog.path);
    const groups = groupSeriesRows(rows);

    res.json({
      metas: [...groups.entries()].map(([groupId, groupRows]) => ({
        id: groupId,
        type: "series",
        name: groupRows[0].title,
        poster: buildPosterUrl(groupRows[0].poster_path),
        year: groupRows[0].year || undefined
      }))
    });
  });

  app.get("/catalog/series/:catalogId/search=:search.json", (req, res) => {
    maybeTriggerCatalogScan();
    const catalog = config.media.paths.find((entry) => entry.catalog_id === req.params.catalogId && entry.type === "series");
    if (!catalog) {
      res.status(404).json({ error: "Unknown series catalog" });
      return;
    }

    const searchValue = normalizeSearchValue(req.params.search);
    const rows = searchValue ? database.searchSeriesByCatalogPath(catalog.path, searchValue) : [];
    const groups = groupSeriesRows(rows);

    res.json({
      metas: [...groups.entries()].map(([groupId, groupRows]) => ({
        id: groupId,
        type: "series",
        name: groupRows[0].title,
        poster: buildPosterUrl(groupRows[0].poster_path),
        year: groupRows[0].year || undefined
      }))
    });
  });

  app.get("/meta/movie/:id.json", (req, res) => {
    const item = database.findMovieByAnyId(req.params.id);
    if (!item || !item.is_available) {
      res.status(404).json({ error: "Movie not found" });
      return;
    }

    res.json({ meta: buildMovieMeta(item) });
  });

  app.get("/meta/series/:id.json", (req, res) => {
    const rows = database.listAllAvailableSeries().filter((row) => buildSeriesGroupId(row) === req.params.id);
    if (!rows.length) {
      res.status(404).json({ error: "Series not found" });
      return;
    }

    res.json({ meta: buildSeriesMeta(req.params.id, rows) });
  });

  app.get("/stream/movie/:id.json", (req, res) => {
    const item = database.findMovieByAnyId(req.params.id);
    if (!item || !item.is_available) {
      res.status(404).json({ error: "Movie stream not found" });
      return;
    }

    const streamInfo = database.getStreamByFileId(item.file_id) || {};
    res.json(buildStreamResponse(config.server.public_base_url, item, streamInfo));
  });

  app.get("/stream/series/:id.json", (req, res) => {
    const item = database.findSeriesEpisodeByAnyId(req.params.id);
    if (!item || !item.is_available) {
      res.status(404).json({ error: "Series episode stream not found" });
      return;
    }

    const streamInfo = database.getStreamByFileId(item.file_id) || {};
    res.json(buildStreamResponse(config.server.public_base_url, item, streamInfo));
  });

  app.get("/file/:fileId", async (req, res) => {
    const fileRecord = database.getFileById(req.params.fileId);
    if (!fileRecord || !fileRecord.is_available) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    try {
      if (config.streaming.verify_file_exists_on_play) {
        await verifyFileReadable(fileRecord.path);
      }
      await sendFileStream(req, res, fileRecord, config);
    } catch (error) {
      if (error.code === "ENOENT") {
        res.status(404).json({ error: "File not found on disk" });
        return;
      }

      logger.error(`Streaming failed for ${fileRecord.file_id}: ${error.message}`);
      res.status(500).json({ error: "Streaming failed" });
    }
  });

  app.get("/admin/status", adminEnabled, (req, res) => {
    res.json(database.getStatus(config.media.paths.map((entry) => entry.path)));
  });

  app.post("/admin/scan", adminEnabled, async (req, res) => {
    try {
      const result = await scanner.runScan(req.body || {});
      observeScanResult(result);
      res.status(result.started ? 202 : 200).json({
        started: result.started,
        scanner_running: scanner.isRunning()
      });
    } catch (error) {
      logger.error(`Manual scan trigger failed: ${error.message}`);
      res.status(500).json({ error: "Failed to trigger scan" });
    }
  });

  app.get("/admin/unmatched", adminEnabled, (req, res) => {
    const items = database.listUnmatched().map((item) => ({
      file_id: item.file_id,
      item_id: item.item_id,
      path: item.path,
      media_type: item.media_type,
      title: item.title,
      year: item.year,
      season: item.season,
      episode: item.episode,
      imdb_id: item.imdb_id,
      tmdb_id: item.tmdb_id,
      match_source: item.match_source,
      match_confidence: item.match_confidence
    }));

    res.json({ items });
  });

  app.post("/admin/match/:fileId", adminEnabled, (req, res) => {
    const payload = req.body || {};
    if (!payload.type || !payload.title) {
      res.status(400).json({ error: "type and title are required" });
      return;
    }

    const item = database.applyManualMatch(req.params.fileId, payload);
    if (!item) {
      res.status(404).json({ error: "File not found for manual match" });
      return;
    }

    res.json({ ok: true, item });
  });

  app.post("/admin/refresh-metadata/:itemId", adminEnabled, async (req, res) => {
    try {
      const item = await scanner.refreshItemMetadata(req.params.itemId);
      res.json({ ok: true, item });
    } catch (error) {
      if (error.message === "Item not found") {
        res.status(404).json({ error: "Item not found" });
        return;
      }
      if (error.message === "Underlying file record not found") {
        res.status(404).json({ error: "Underlying file record not found" });
        return;
      }
      logger.error(`Metadata refresh failed: ${error.message}`);
      res.status(500).json({ error: "Failed to refresh metadata" });
    }
  });

  app.get(["/", "/admin/ui", "/admin/ui/unmatched"], (req, res) => {
    const status = database.getStatus(config.media.paths.map((entry) => entry.path));
    res.type("html").send(renderHomePage(status));
  });

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      scanner_running: scanner.isRunning()
    });
  });

  app.use((error, req, res, next) => {
    if (!error) {
      next();
      return;
    }

    if (error.status === 404) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    logger.error(`Unhandled error: ${error.message}`);
    res.status(500).json({ error: "Internal server error" });
  });

  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });
}

async function bootstrap() {
  ensureRuntimeDirs();
  bindMiddleware();
  bindRoutes();
  setupScheduler();

  logger.info("Configuration loaded", redactConfig(config));
  logger.info(`Manifest URL: ${config.server.public_base_url}/manifest.json`);

  if (config.scan.run_on_startup) {
    try {
      const result = await scanner.runScan();
      observeScanResult(result);
      if (result.started) {
        result.promise.catch((error) => logger.error(`Startup scan failed: ${error.message}`));
      }
    } catch (error) {
      logger.error(`Failed to start startup scan: ${error.message}`);
    }
  }

  const port = config.server.port;
  app.listen(port, () => {
    logger.info(`HTTP server listening on ${port}`);
  });
}

bootstrap().catch((error) => {
  logger.error(`Fatal startup error: ${error.stack || error.message}`);
  process.exit(1);
});
