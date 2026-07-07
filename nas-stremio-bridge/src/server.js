const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const cron = require("node-cron");
const express = require("express");
const { loadConfig, redactConfig } = require("./config");
const { createLogger } = require("./logger");
const { createDatabase } = require("./database");
const { createScanner } = require("./scanner");
const { runAudit, findingsToDelimited, findingsToTopText } = require("./audit");
const { buildStreamResponse, pickPrimaryCandidate, sendFileStream, verifyFileReadable } = require("./stream");
const { extractImdbIdFromText, hashText } = require("./metadata");
const packageJson = require("../package.json");

const DATA_DIR = process.env.DATA_DIR || "/data";
const config = loadConfig();
const logger = createLogger(config.logging.level);
let database = createDatabase(DATA_DIR);
let scanner = createScanner({ config, database, logger, dataDir: DATA_DIR });
const app = express();
const ADDON_VERSION = process.env.ADDON_VERSION || packageJson.version || "0.2.0";

let intervalTimer = null;
let cronTask = null;
let maintenanceMode = false;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

function ensureRuntimeDirs() {
  for (const relativePath of ["posters", "backdrops", "metadata", "logs", "db_backups"]) {
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

function buildMovieGroupId(item) {
  return item.stremio_id || item.imdb_id || item.item_id || item.file_id;
}

function groupMovieRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const groupId = buildMovieGroupId(row);
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
    }
    groups.get(groupId).push(row);
  }
  return groups;
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
    version: ADDON_VERSION,
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
  const uniqueEpisodes = new Map();
  for (const row of rows.filter((entry) => entry.season && entry.episode)) {
    const episodeId = row.stremio_id || `${groupId}:${row.season}:${row.episode}`;
    if (uniqueEpisodes.has(episodeId)) {
      continue;
    }
    uniqueEpisodes.set(episodeId, {
      id: episodeId,
      title: row.title,
      season: row.season,
      episode: row.episode,
      released: row.year ? `${row.year}-01-01` : undefined
    });
  }

  return {
    id: groupId,
    type: "series",
    name: first.title,
    poster: buildPosterUrl(first.poster_path),
    background: buildPosterUrl(first.backdrop_path),
    description: first.overview || "",
    releaseInfo: first.year ? String(first.year) : "",
    videos: [...uniqueEpisodes.values()]
  };
}

function maybeTriggerCatalogScan() {
  if (!config.scan.scan_on_catalog_open || maintenanceMode) {
    return;
  }

  scanner.runScan()
    .then((result) => {
      observeScanResult(result);
    })
    .catch((error) => {
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

function pickSortedCandidate(rows) {
  return pickPrimaryCandidate(rows);
}

function buildMovieCatalogEntries(rows) {
  const groups = groupMovieRows(rows);
  return [...groups.entries()].map(([groupId, groupRows]) => {
    const primary = pickSortedCandidate(groupRows);
    return {
      id: groupId,
      type: "movie",
      name: primary.title,
      poster: buildPosterUrl(primary.poster_path),
      year: primary.year || undefined
    };
  });
}

function analyzeIgnorePath(targetPath) {
  const normalized = String(targetPath || "").toLowerCase();
  const matches = (config.media.ignore_patterns || []).filter((pattern) => normalized.includes(String(pattern || "").toLowerCase()));
  return {
    ignored: matches.length > 0,
    matches
  };
}

function refreshRuntimeObjects() {
  database = createDatabase(DATA_DIR);
  scanner = createScanner({ config, database, logger, dataDir: DATA_DIR });
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function buildAuditPayload(options = {}) {
  const includeUnavailable = parseBoolean(options.include_unavailable, false);
  const audit = runAudit(database.listItemsForAudit(includeUnavailable), {
    limit: options.limit,
    reason: options.reason,
    min_severity: options.min_severity
  });
  return {
    generated_at: audit.generated_at,
    summary: audit.summary,
    filtered_summary: audit.filtered_summary,
    filters: {
      include_unavailable: includeUnavailable,
      reason: options.reason ? String(options.reason) : "",
      min_severity: Number(options.min_severity || 0)
    },
    items: audit.findings
  };
}

function storeAuditSummary(payload) {
  database.setState("last_audit_summary_json", JSON.stringify({
    generated_at: payload.generated_at,
    ...payload.summary
  }));
}

function runAndStoreAudit(limit = 500) {
  const payload = buildAuditPayload({ limit });
  storeAuditSummary(payload);
  return payload;
}

function normalizeSearchValue(rawValue) {
  return String(rawValue || "").trim();
}

function extractAuditOptions(source = {}) {
  return {
    limit: source.limit,
    reason: source.reason,
    min_severity: source.min_severity,
    include_unavailable: source.include_unavailable
  };
}

function ensureReadyForMutation(res) {
  if (!maintenanceMode) {
    return true;
  }

  res.status(409).json({ error: "Maintenance in progress" });
  return false;
}

async function rebuildDatabaseAndStartScan(options = {}) {
  if (scanner.isRunning()) {
    throw new Error("Scanner is currently running");
  }

  maintenanceMode = true;
  const dbBasePath = path.join(DATA_DIR, "index.db");
  const backupRoot = path.join(DATA_DIR, "db_backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupRoot, stamp);

  try {
    await fsp.mkdir(backupDir, { recursive: true });

    for (const suffix of ["", "-wal", "-shm"]) {
      const sourcePath = `${dbBasePath}${suffix}`;
      try {
        await fsp.access(sourcePath, fs.constants.F_OK);
        await fsp.copyFile(sourcePath, path.join(backupDir, path.basename(sourcePath)));
      } catch (_) {
        continue;
      }
    }

    database.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      const targetPath = `${dbBasePath}${suffix}`;
      await fsp.rm(targetPath, { force: true });
    }

    refreshRuntimeObjects();

    const result = await scanner.runScan({
      scan_type: options.scan_type || "light",
      force_metadata_refresh: Boolean(options.force_metadata_refresh)
    });
    observeScanResult(result);

    return {
      ok: true,
      backup_dir: backupDir,
      started: result.started,
      scanner_running: scanner.isRunning()
    };
  } finally {
    maintenanceMode = false;
  }
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
  const latestScan = status.latest_scan_run || {};
  const auditSummary = status.last_audit_summary || { total: 0, critical_total: 0, by_reason: {} };
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
    .stack {
      display: grid;
      gap: 12px;
    }
    .split {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }
    .results {
      display: grid;
      gap: 10px;
    }
    .result {
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255,255,255,0.72);
    }
    button, input, select {
      border-radius: 12px;
      border: 1px solid var(--line);
      padding: 12px 14px;
      font: inherit;
    }
    input, select { min-width: min(100%, 320px); background: #fff; }
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
    .warn {
      border-color: rgba(180, 83, 9, 0.5);
      background: rgba(254, 243, 199, 0.5);
    }
    .notice {
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.72);
    }
    .notice.warn {
      border-color: rgba(180, 83, 9, 0.5);
      background: rgba(254, 243, 199, 0.55);
    }
    .scroll-x {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }
    th, td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      color: var(--accent-2);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .pill {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(15, 118, 110, 0.12);
      color: var(--ink);
      font-size: 0.78rem;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <p class="eyebrow">Home Assistant Add-on</p>
      <h1>NAS Stremio Bridge</h1>
      <p>Lokální Stremio add-on server pro NAS knihovnu. Katalog, metadata i search jedou z SQLite cache, NAS se čte až při scanu nebo při skutečném přehrávání souboru.</p>
      <article class="card ${auditSummary.total ? "warn" : ""}">
        <p class="eyebrow">Match Audit</p>
        <p class="value">${escapeHtml(auditSummary.total || 0)}</p>
        <p class="small">Kriticke: ${escapeHtml(auditSummary.critical_total || 0)}</p>
        <p class="small">Naposledy: ${escapeHtml(auditSummary.generated_at || "n/a")}</p>
      </article>
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
      <article class="card">
        <p class="eyebrow">Posledni scan</p>
        <p class="small">Nalezeno: ${escapeHtml(latestScan.files_seen || 0)}</p>
        <p class="small">Nove: ${escapeHtml(latestScan.files_added || 0)}</p>
        <p class="small">Zmenene: ${escapeHtml(latestScan.files_updated || 0)}</p>
        <p class="small">Unavailable: ${escapeHtml(latestScan.files_missing || 0)}</p>
        <p class="small">Ignorovane: ${escapeHtml(latestScan.files_ignored || 0)}</p>
      </article>
      <article class="card">
        <p class="eyebrow">Match Statistiky</p>
        <p class="small">Auto-matched: ${escapeHtml(latestScan.auto_matched || 0)}</p>
        <p class="small">Manual or IMDb: ${escapeHtml(latestScan.manual_imdb_matched || 0)}</p>
        <p class="small">Podezrele: ${escapeHtml(latestScan.suspicious_total || 0)}</p>
        <p class="small">Chyby: ${escapeHtml(latestScan.errors || 0)}</p>
      </article>
      <article class="card">
        <p class="eyebrow">Latest Scan Error Log</p>
        <pre>${escapeHtml(latestScan.error_log || "n/a")}</pre>
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
      <div class="toolbar">
        <button type="button" id="auditButton">Run audit</button>
        <button type="button" class="secondary" id="downloadTsvButton">Download TSV</button>
        <button type="button" class="secondary" id="downloadCsvButton">Download CSV</button>
        <button type="button" class="ghost" id="downloadTopButton">Download top 100</button>
        <button type="button" id="rebuildButton">Backup DB + Clean rebuild</button>
      </div>
      <pre id="output">Ready.</pre>
    </section>
    <section class="grid">
      <article class="card">
        <p class="eyebrow">Manual Match</p>
        <div class="stack">
          <div class="toolbar">
            <input id="searchQuery" type="text" placeholder="Vyhledat titul, IMDb nebo cestu">
            <button type="button" id="searchButton">Vyhledat polozku</button>
          </div>
          <div id="searchResults" class="results"></div>
          <div class="split">
            <input id="selectedFileId" type="text" placeholder="file_id" readonly>
            <input id="selectedItemId" type="text" placeholder="item_id" readonly>
            <select id="selectedType">
              <option value="movie">movie</option>
              <option value="series">series</option>
            </select>
            <input id="selectedTitle" type="text" placeholder="title">
            <input id="selectedYear" type="text" placeholder="year">
            <input id="selectedSeason" type="text" placeholder="season">
            <input id="selectedEpisode" type="text" placeholder="episode">
            <input id="selectedImdb" type="text" placeholder="IMDb ID">
          </div>
          <div class="toolbar">
            <button type="button" id="remapButton">Premapovat</button>
            <button type="button" id="applyImdbFetchButton">Apply IMDb + fetch metadata</button>
            <button type="button" class="secondary" id="refreshMetadataButton">Refresh metadata</button>
          </div>
        </div>
      </article>
      <article class="card">
        <p class="eyebrow">Ignore Patterns</p>
        <p class="small mono">${escapeHtml((config.media.ignore_patterns || []).join(", "))}</p>
        <div class="toolbar">
          <input id="ignorePath" type="text" placeholder="Otestovat cestu nebo nazev souboru">
          <button type="button" id="ignoreTestButton">Otestovat ignore</button>
        </div>
      </article>
    </section>
    <section class="card">
      <p class="eyebrow">Audit Browser</p>
      <div class="toolbar">
        <select id="auditReason">
          <option value="">Vsechny reasons</option>
          <option value="IMDB_CONFLICT">IMDB_CONFLICT</option>
          <option value="KNOWN_BAD_MATCH">KNOWN_BAD_MATCH</option>
          <option value="MISSING_DB_META">MISSING_DB_META</option>
          <option value="YEAR_CONFLICT">YEAR_CONFLICT</option>
          <option value="TITLE_LOW_SIM">TITLE_LOW_SIM</option>
        </select>
        <select id="auditSeverity">
          <option value="0">Vsechny severity</option>
          <option value="90">90+ critical</option>
          <option value="85">85+ high</option>
          <option value="60">60+ medium</option>
          <option value="30">30+ low</option>
        </select>
        <select id="auditIncludeUnavailable">
          <option value="false">Jen available</option>
          <option value="true">Vcetne unavailable</option>
        </select>
        <button type="button" id="loadAuditButton">Nacist audit</button>
      </div>
      <div id="auditNotice" class="notice ${auditSummary.total ? "warn" : ""}">
        ${auditSummary.total
          ? `${escapeHtml(auditSummary.total)} polozek vypada podezrele. Filtruj je nize nebo stahni export.`
          : "Posledni audit nevykazuje zadne podezrele polozky."}
      </div>
      <div class="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              <th>Reason</th>
              <th>Titul</th>
              <th>IMDb</th>
              <th>Match</th>
              <th>Cesta</th>
            </tr>
          </thead>
          <tbody id="auditTableBody">
            <tr><td colspan="6" class="small">Audit se nacte po kliknuti na "Nacist audit".</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById("adminToken");
    const output = document.getElementById("output");
    const searchResults = document.getElementById("searchResults");
    const auditNotice = document.getElementById("auditNotice");
    const auditTableBody = document.getElementById("auditTableBody");
    const storageKey = "nas-stremio-bridge-admin-token";
    tokenInput.value = localStorage.getItem(storageKey) || "";
    tokenInput.addEventListener("input", () => localStorage.setItem(storageKey, tokenInput.value));

    const fields = {
      fileId: document.getElementById("selectedFileId"),
      itemId: document.getElementById("selectedItemId"),
      type: document.getElementById("selectedType"),
      title: document.getElementById("selectedTitle"),
      year: document.getElementById("selectedYear"),
      season: document.getElementById("selectedSeason"),
      episode: document.getElementById("selectedEpisode"),
      imdb: document.getElementById("selectedImdb")
    };

    const auditControls = {
      reason: document.getElementById("auditReason"),
      severity: document.getElementById("auditSeverity"),
      includeUnavailable: document.getElementById("auditIncludeUnavailable")
    };

    tokenInput.addEventListener("change", () => {
      if (tokenInput.value) {
        loadAudit().catch(() => {});
      }
    });

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

    async function downloadFromApi(path, filename) {
      const headers = {};
      if (tokenInput.value) {
        headers.Authorization = "Bearer " + tokenInput.value;
      }
      const response = await fetch(path, { headers });
      if (!response.ok) {
        output.textContent = await response.text();
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    }

    function fillSelectedItem(item) {
      fields.fileId.value = item.file_id || "";
      fields.itemId.value = item.item_id || "";
      fields.type.value = item.media_type || "movie";
      fields.title.value = item.title || "";
      fields.year.value = item.year || "";
      fields.season.value = item.season || "";
      fields.episode.value = item.episode || "";
      fields.imdb.value = item.imdb_id || "";
    }

    function renderSearchResults(items) {
      searchResults.innerHTML = "";
      if (!items.length) {
        searchResults.innerHTML = "<p class='small'>Nic nenalezeno.</p>";
        return;
      }

      items.forEach((item) => {
        const node = document.createElement("div");
        node.className = "result";
        node.innerHTML = "<p class='small'><strong>" + (item.title || item.path) + "</strong></p>"
          + "<p class='small mono'>" + item.path + "</p>"
          + "<p class='small'>IMDb: " + (item.imdb_id || "n/a") + " | match: " + (item.match_source || "n/a") + " | available: " + item.is_available + "</p>";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Vybrat";
        button.addEventListener("click", () => fillSelectedItem(item));
        node.appendChild(button);
        searchResults.appendChild(node);
      });
    }

    function currentAuditQuery(limitOverride = 200) {
      const params = new URLSearchParams();
      if (auditControls.reason.value) {
        params.set("reason", auditControls.reason.value);
      }
      if (auditControls.severity.value && auditControls.severity.value !== "0") {
        params.set("min_severity", auditControls.severity.value);
      }
      params.set("include_unavailable", auditControls.includeUnavailable.value);
      params.set("limit", String(limitOverride));
      return params.toString();
    }

    function renderAuditRows(items) {
      auditTableBody.innerHTML = "";
      if (!items.length) {
        auditTableBody.innerHTML = "<tr><td colspan='6' class='small'>Zadny vysledek pro zvoleny filtr.</td></tr>";
        return;
      }

      items.forEach((item) => {
        const row = document.createElement("tr");
        row.innerHTML = "<td><span class='pill'>" + item.severity + "</span></td>"
          + "<td><span class='pill'>" + item.reason + "</span></td>"
          + "<td>" + (item.title || "") + (item.year ? " (" + item.year + ")" : "") + "</td>"
          + "<td class='mono'>" + (item.imdb_id || "n/a") + "</td>"
          + "<td>" + (item.match_source || "n/a") + "</td>"
          + "<td class='mono'>" + (item.path || "") + "</td>";
        row.addEventListener("click", () => {
          if (item.file_id) {
            fillSelectedItem({
              file_id: item.file_id,
              item_id: item.item_id,
              media_type: item.media_type,
              title: item.title,
              year: item.year,
              imdb_id: item.imdb_id
            });
          }
        });
        auditTableBody.appendChild(row);
      });
    }

    async function loadAudit() {
      auditNotice.textContent = "Nacitam audit...";
      const result = await callApi("/admin/audit?" + currentAuditQuery(200));
      output.textContent = JSON.stringify(result, null, 2);
      if (!result.ok || !result.body) {
        auditNotice.textContent = "Audit se nepodarilo nacist.";
        auditNotice.className = "notice warn";
        return;
      }

      const summary = result.body.filtered_summary || result.body.summary || { total: 0, critical_total: 0 };
      if (summary.total > 0) {
        auditNotice.textContent = "Audit nasel " + summary.total + " podezrelych polozek"
          + (summary.critical_total ? ", z toho " + summary.critical_total + " kritickych." : ".");
        auditNotice.className = "notice warn";
      } else {
        auditNotice.textContent = "Pro zvoleny filtr audit nic podezreleho nenasel.";
        auditNotice.className = "notice";
      }

      renderAuditRows(Array.isArray(result.body.items) ? result.body.items : []);
    }

    async function waitForScannerIdle(maxAttempts = 40) {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const status = await callApi("/admin/status");
        if (status.ok && status.body && !status.body.scanner_running) {
          return status.body;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      return null;
    }

    document.getElementById("scanButton").addEventListener("click", async () => {
      output.textContent = "Spoustim scan...";
      const result = await callApi("/admin/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scan_type: "light", force_metadata_refresh: false })
      });
      output.textContent = JSON.stringify(result, null, 2);
      if (result.ok) {
        const finalStatus = await waitForScannerIdle();
        if (finalStatus && finalStatus.last_audit_summary && finalStatus.last_audit_summary.total > 0) {
          auditNotice.textContent = "Scan hotovy, ale " + finalStatus.last_audit_summary.total + " polozek vypada podezrele.";
          auditNotice.className = "notice warn";
        }
        loadAudit().catch(() => {});
      }
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

    document.getElementById("auditButton").addEventListener("click", async () => {
      output.textContent = "Spoustim audit...";
      const result = await callApi("/admin/audit/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: 500,
          reason: auditControls.reason.value || "",
          min_severity: Number(auditControls.severity.value || 0),
          include_unavailable: auditControls.includeUnavailable.value === "true"
        })
      });
      output.textContent = JSON.stringify(result, null, 2);
      if (result.ok) {
        renderAuditRows(Array.isArray(result.body.items) ? result.body.items : []);
        const summary = result.body.filtered_summary || result.body.summary || { total: 0, critical_total: 0 };
        auditNotice.textContent = summary.total > 0
          ? "Audit nasel " + summary.total + " podezrelych polozek."
          : "Pro zvoleny filtr audit nic podezreleho nenasel.";
        auditNotice.className = summary.total > 0 ? "notice warn" : "notice";
      }
    });

    document.getElementById("downloadTsvButton").addEventListener("click", async () => {
      await downloadFromApi("/admin/audit/export.tsv?" + currentAuditQuery(1000), "audit.tsv");
    });

    document.getElementById("downloadCsvButton").addEventListener("click", async () => {
      await downloadFromApi("/admin/audit/export.csv?" + currentAuditQuery(1000), "audit.csv");
    });

    document.getElementById("downloadTopButton").addEventListener("click", async () => {
      await downloadFromApi("/admin/audit/top.txt?" + currentAuditQuery(100), "top-suspicious.txt");
    });

    document.getElementById("searchButton").addEventListener("click", async () => {
      const query = document.getElementById("searchQuery").value.trim();
      output.textContent = "Vyhledavam polozky...";
      const result = await callApi("/admin/items/search?q=" + encodeURIComponent(query));
      output.textContent = JSON.stringify(result, null, 2);
      if (result.ok && result.body && Array.isArray(result.body.items)) {
        renderSearchResults(result.body.items);
      }
    });

    document.getElementById("remapButton").addEventListener("click", async () => {
      if (!fields.fileId.value) {
        output.textContent = "Nejdriv vyber polozku.";
        return;
      }
      output.textContent = "Ukladam manual match...";
      const result = await callApi("/admin/match/" + encodeURIComponent(fields.fileId.value), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: fields.type.value,
          title: fields.title.value,
          year: fields.year.value ? Number(fields.year.value) : null,
          season: fields.season.value ? Number(fields.season.value) : null,
          episode: fields.episode.value ? Number(fields.episode.value) : null,
          imdb_id: fields.imdb.value || null
        })
      });
      output.textContent = JSON.stringify(result, null, 2);
      if (result.ok && result.body && result.body.item) {
        fillSelectedItem(result.body.item);
      }
    });

    document.getElementById("applyImdbFetchButton").addEventListener("click", async () => {
      if (!fields.fileId.value || !fields.imdb.value) {
        output.textContent = "Vyber polozku a zadej IMDb ID.";
        return;
      }
      output.textContent = "Aplikuji IMDb a dotahuji metadata...";
      const result = await callApi("/admin/match/" + encodeURIComponent(fields.fileId.value) + "/apply-imdb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imdb_id: fields.imdb.value })
      });
      output.textContent = JSON.stringify(result, null, 2);
      if (result.ok && result.body && result.body.item) {
        fillSelectedItem(result.body.item);
        loadAudit().catch(() => {});
      }
    });

    document.getElementById("refreshMetadataButton").addEventListener("click", async () => {
      if (!fields.itemId.value) {
        output.textContent = "Nejdriv vyber polozku.";
        return;
      }
      output.textContent = "Obnovuji metadata...";
      const result = await callApi("/admin/refresh-metadata/" + encodeURIComponent(fields.itemId.value), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_from_ids: true })
      });
      output.textContent = JSON.stringify(result, null, 2);
    });

    document.getElementById("ignoreTestButton").addEventListener("click", async () => {
      output.textContent = "Testuji ignore patterns...";
      const result = await callApi("/admin/ignore-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: document.getElementById("ignorePath").value })
      });
      output.textContent = JSON.stringify(result, null, 2);
    });

    document.getElementById("rebuildButton").addEventListener("click", async () => {
      if (!confirm("Opravdu udelat backup DB a clean rebuild?")) {
        return;
      }
      output.textContent = "Spoustim clean rebuild DB...";
      const result = await callApi("/admin/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scan_type: "light", force_metadata_refresh: false })
      });
      output.textContent = JSON.stringify(result, null, 2);
      if (result.ok) {
        const finalStatus = await waitForScannerIdle();
        if (finalStatus && finalStatus.last_audit_summary && finalStatus.last_audit_summary.total > 0) {
          auditNotice.textContent = "Clean rebuild dokoncen, ale audit nasel " + finalStatus.last_audit_summary.total + " podezrelych polozek.";
          auditNotice.className = "notice warn";
        }
        loadAudit().catch(() => {});
      }
    });

    document.getElementById("loadAuditButton").addEventListener("click", async () => {
      await loadAudit();
    });

    if (tokenInput.value) {
      loadAudit().catch(() => {});
    }
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
        if (maintenanceMode) {
          scheduleNextIntervalScan(computeNextIntervalDate(new Date()));
          return;
        }
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
      if (maintenanceMode) {
        updateCronNextRunState();
        return;
      }
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

  result.promise
    .then(() => {
      const auditPayload = runAndStoreAudit();
      logger.info(`Post-scan audit summary: total=${auditPayload.summary.total}, critical=${auditPayload.summary.critical_total}`);
    })
    .catch((error) => {
      logger.warn(`Post-scan audit skipped: ${error.message}`);
    })
    .finally(() => {
      if (config.scan.mode === "interval") {
        const lastSuccessfulScanAt = Number(database.getState("last_successful_scan_at") || 0);
        const baseDate = lastSuccessfulScanAt > 0 ? new Date(lastSuccessfulScanAt * 1000) : new Date();
        scheduleNextIntervalScan(computeNextIntervalDate(baseDate));
        return;
      }

      if (config.scan.mode === "cron") {
        updateCronNextRunState();
      }
    })
    .catch(() => {});
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
      metas: buildMovieCatalogEntries(items)
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
      metas: buildMovieCatalogEntries(items)
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
    const candidates = database.listMovieCandidatesByAnyId(req.params.id);
    const item = pickPrimaryCandidate(candidates);
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
    const candidates = database.listMovieCandidatesByAnyId(req.params.id);
    const item = pickPrimaryCandidate(candidates);
    if (!item || !item.is_available) {
      res.status(404).json({ error: "Movie stream not found" });
      return;
    }

    res.json(buildStreamResponse(config.server.public_base_url, candidates, config));
  });

  app.get("/stream/series/:id.json", (req, res) => {
    const candidates = database.listSeriesEpisodeCandidatesByAnyId(req.params.id);
    const item = pickPrimaryCandidate(candidates);
    if (!item || !item.is_available) {
      res.status(404).json({ error: "Series episode stream not found" });
      return;
    }

    res.json(buildStreamResponse(config.server.public_base_url, candidates, config));
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
    res.json({
      ...database.getStatus(config.media.paths.map((entry) => entry.path)),
      maintenance_mode: maintenanceMode
    });
  });

  app.get("/admin/config", adminEnabled, (req, res) => {
    res.json({
      config: redactConfig(config),
      ignore_patterns: config.media.ignore_patterns,
      stream_title_options: {
        show_filename_in_title: config.streaming.show_filename_in_title,
        show_folder_in_title: config.streaming.show_folder_in_title
      }
    });
  });

  app.post("/admin/scan", adminEnabled, async (req, res) => {
    if (!ensureReadyForMutation(res)) {
      return;
    }

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

  app.post("/admin/ignore-test", adminEnabled, (req, res) => {
    const targetPath = String((req.body && req.body.path) || "");
    if (!targetPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    res.json({
      path: targetPath,
      ...analyzeIgnorePath(targetPath)
    });
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
    if (!ensureReadyForMutation(res)) {
      return;
    }

    const payload = req.body || {};
    if (!payload.type || !payload.title) {
      res.status(400).json({ error: "type and title are required" });
      return;
    }

    const fileRecord = database.getFileById(req.params.fileId);
    if (!fileRecord) {
      res.status(404).json({ error: "File not found for manual match" });
      return;
    }

    const explicitImdbId = extractImdbIdFromText(fileRecord.path);
    if (explicitImdbId && payload.imdb_id && explicitImdbId !== String(payload.imdb_id).toLowerCase()) {
      res.status(400).json({ error: "Explicit IMDb in file path conflicts with requested IMDb remap" });
      return;
    }

    const item = database.applyManualMatch(req.params.fileId, payload);
    if (!item) {
      res.status(404).json({ error: "File not found for manual match" });
      return;
    }

    res.json({ ok: true, item });
  });

  app.post("/admin/match/:fileId/apply-imdb", adminEnabled, async (req, res) => {
    if (!ensureReadyForMutation(res)) {
      return;
    }

    const payload = req.body || {};
    const imdbId = String(payload.imdb_id || "").trim().toLowerCase();
    if (!/^tt\d{7,10}$/.test(imdbId)) {
      res.status(400).json({ error: "Valid imdb_id is required" });
      return;
    }

    const fileRecord = database.getFileById(req.params.fileId);
    if (!fileRecord) {
      res.status(404).json({ error: "File not found for IMDb apply" });
      return;
    }

    const explicitImdbId = extractImdbIdFromText(fileRecord.path);
    if (explicitImdbId && explicitImdbId !== imdbId) {
      res.status(400).json({ error: "Explicit IMDb in file path conflicts with requested IMDb remap" });
      return;
    }

    const existingItem = database.getItemByFileId(req.params.fileId);
    if (!existingItem) {
      res.status(404).json({ error: "Item not found for IMDb apply" });
      return;
    }

    const matched = database.applyManualMatch(req.params.fileId, {
      type: existingItem.media_type,
      title: existingItem.title || path.basename(fileRecord.path, fileRecord.extension),
      year: existingItem.year,
      season: existingItem.season,
      episode: existingItem.episode,
      imdb_id: imdbId
    });
    if (!matched) {
      res.status(404).json({ error: "Item not found for IMDb apply" });
      return;
    }

    try {
      const refreshed = await scanner.refreshItemMetadata(matched.item_id, {
        manualMatchBehavior: "refresh_from_ids"
      });
      res.json({ ok: true, item: refreshed });
    } catch (error) {
      logger.error(`IMDb apply+fetch failed: ${error.message}`);
      res.status(500).json({ error: "Failed to fetch metadata for IMDb remap" });
    }
  });

  app.post("/admin/refresh-metadata/:itemId", adminEnabled, async (req, res) => {
    if (!ensureReadyForMutation(res)) {
      return;
    }

    try {
      const item = await scanner.refreshItemMetadata(req.params.itemId, {
        manualMatchBehavior: parseBoolean(req.body && req.body.refresh_from_ids, false) ? "refresh_from_ids" : "preserve"
      });
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

  app.get("/admin/items/search", adminEnabled, (req, res) => {
    const query = normalizeSearchValue(req.query.q);
    if (!query) {
      res.json({ items: [] });
      return;
    }

    const items = database.searchItems(query, req.query.limit || 50);
    res.json({ items });
  });

  app.post("/admin/audit/run", adminEnabled, (req, res) => {
    const payload = buildAuditPayload(extractAuditOptions(req.body || {}));
    storeAuditSummary(payload);
    res.json(payload);
  });

  app.get("/admin/audit", adminEnabled, (req, res) => {
    const payload = buildAuditPayload(extractAuditOptions(req.query || {}));
    res.json(payload);
  });

  app.get("/admin/audit/export.tsv", adminEnabled, (req, res) => {
    const payload = buildAuditPayload(extractAuditOptions(req.query || {}));
    res.type("text/tab-separated-values");
    res.setHeader("Content-Disposition", "attachment; filename=\"audit.tsv\"");
    res.send(findingsToDelimited(payload.items, "\t"));
  });

  app.get("/admin/audit/export.csv", adminEnabled, (req, res) => {
    const payload = buildAuditPayload(extractAuditOptions(req.query || {}));
    res.type("text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"audit.csv\"");
    res.send(findingsToDelimited(payload.items, ","));
  });

  app.get("/admin/audit/top.txt", adminEnabled, (req, res) => {
    const payload = buildAuditPayload(extractAuditOptions({ ...(req.query || {}), limit: req.query.limit || 100 }));
    res.type("text/plain");
    res.setHeader("Content-Disposition", "attachment; filename=\"top-suspicious.txt\"");
    res.send(findingsToTopText(payload.items, req.query.limit || 100));
  });

  app.post("/admin/rebuild", adminEnabled, async (req, res) => {
    if (!ensureReadyForMutation(res)) {
      return;
    }

    try {
      const result = await rebuildDatabaseAndStartScan(req.body || {});
      res.status(202).json(result);
    } catch (error) {
      logger.error(`DB rebuild failed: ${error.message}`);
      res.status(500).json({ error: "Failed to rebuild database" });
    }
  });

  app.get(["/", "/admin/ui", "/admin/ui/unmatched", "/admin/ui/audit", "/admin/ui/match-audit"], (req, res) => {
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

  try {
    if (database.listItemsForAudit(false).length) {
      runAndStoreAudit();
    }
  } catch (error) {
    logger.warn(`Initial audit skipped: ${error.message}`);
  }

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
