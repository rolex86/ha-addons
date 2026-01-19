// tools/config-ui/server.js
// Minimal config UI server (no dependencies) for editing lists.trakt.json + secrets.json directly on disk.

const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const url = require("url");
const { exec, spawn } = require("child_process");

// ---------------------------
// PATHS
// ---------------------------
// Code lives in /app; configs/lists should persist in /data in HA add-on
const DATA_DIR = process.env.DATA_DIR || "/data";
const CONFIG_DIR = path.join(DATA_DIR, "config");
const LISTS_PATH = path.join(CONFIG_DIR, "lists.trakt.json");
const SECRETS_PATH = path.join(CONFIG_DIR, "secrets.json");

// UI assets are inside the add-on app folder
const ROOT = path.join(__dirname, "..", ".."); // /app (project root in image)
const UI_DIR = __dirname;
const INDEX_PATH = path.join(UI_DIR, "index.html");
const CLIENT_PATH = path.join(UI_DIR, "client.js");

// Bind/port: use 0.0.0.0 so it works from LAN (RPi). Set HOST=127.0.0.1 if you want local-only.
const HOST = process.env.CONFIG_UI_HOST || "0.0.0.0";
const PORT = Number(process.env.CONFIG_UI_PORT || 7788);

// Optional simple token protection (recommended on RPi):
// export CONFIG_UI_TOKEN="some-password"
const TOKEN = (process.env.CONFIG_UI_TOKEN || "").trim();

// Trakt genres cache TTL (ms)
const TRAKT_GENRES_TTL_MS = Number(
  process.env.TRAKT_GENRES_TTL_MS || 24 * 60 * 60 * 1000,
); // 24h

// ---------------------------
// UPDATE/RUNNER (enrich + rebuild)
// ---------------------------
// Set command that should run full update process.
// Example:
//   CONFIG_UI_UPDATE_CMD="node tools/update-lists.js"
const UPDATE_CMD = String(
  process.env.CONFIG_UI_UPDATE_CMD || "node tools/update-lists.js",
).trim();

const updateState = {
  running: false,
  startedAt: 0,
  endedAt: 0,
  exitCode: null,
  pid: null,
  progress: { label: "", done: 0, total: 0 },
  lines: [],
  clients: new Set(), // SSE clients
};

function pushUpdateLine(line) {
  const s = String(line || "").replace(/\r?\n$/, "");
  if (!s) return;

  // keep last N lines
  updateState.lines.push(s);
  if (updateState.lines.length > 2500)
    updateState.lines.splice(0, updateState.lines.length - 2500);

  // Try to parse structured progress:
  // 1) "PROGRESS {"label":"xyz","done":20,"total":500}"
  if (s.startsWith("PROGRESS ")) {
    const raw = s.slice("PROGRESS ".length).trim();
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === "object") {
        updateState.progress.label = String(
          j.label || updateState.progress.label || "",
        );
        if (Number.isFinite(Number(j.done)))
          updateState.progress.done = Number(j.done);
        if (Number.isFinite(Number(j.total)))
          updateState.progress.total = Number(j.total);
      }
    } catch {}
  } else {
    // 2) Generic: "... 20/500 ..." (best effort)
    const m = s.match(/(.{0,40})\s(\d{1,6})\s*\/\s*(\d{1,6})/);
    if (m) {
      const prefix = String(m[1] || "").trim();
      updateState.progress.label = prefix || updateState.progress.label || "";
      updateState.progress.done = Number(m[2]);
      updateState.progress.total = Number(m[3]);
    }
  }

  // Broadcast to SSE clients
  for (const res of updateState.clients) {
    try {
      res.write(
        `data: ${JSON.stringify({
          line: s,
          at: Date.now(),
          progress: updateState.progress,
        })}\n\n`,
      );
    } catch {}
  }
}

function startUpdateProcess() {
  if (updateState.running) {
    const e = new Error("Update už běží.");
    e.code = "ALREADY_RUNNING";
    throw e;
  }

  updateState.running = true;
  updateState.startedAt = Date.now();
  updateState.endedAt = 0;
  updateState.exitCode = null;
  updateState.pid = null;
  updateState.progress = { label: "", done: 0, total: 0 };

  pushUpdateLine(
    `== UPDATE START ${new Date(updateState.startedAt).toISOString()} ==`,
  );
  pushUpdateLine(`CMD: ${UPDATE_CMD}`);

  // IMPORTANT:
  // - run in /app (code)
  // - ensure DATA_DIR=/data so scripts use persistent storage
  // - detached:true => can kill the whole process group on STOP (Linux/HA)
  const child = spawn(UPDATE_CMD, {
    cwd: ROOT,
    shell: true,
    detached: true,
    env: { ...process.env, DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });

  updateState.pid = child.pid;

  child.stdout.on("data", (buf) => {
    const text = buf.toString("utf8");
    text.split(/\r?\n/).forEach((ln) => pushUpdateLine(ln));
  });
  child.stderr.on("data", (buf) => {
    const text = buf.toString("utf8");
    text.split(/\r?\n/).forEach((ln) => pushUpdateLine(ln));
  });

  child.on("close", (code) => {
    updateState.running = false;
    updateState.endedAt = Date.now();
    updateState.exitCode =
      code === null || code === undefined ? null : Number(code);

    pushUpdateLine(
      `== UPDATE END code=${updateState.exitCode} ${new Date(updateState.endedAt).toISOString()} ==`,
    );

    // notify clients that it's done
    for (const res of updateState.clients) {
      try {
        res.write(
          `event: done\ndata: ${JSON.stringify({ ok: code === 0, code })}\n\n`,
        );
      } catch {}
    }
  });

  return { pid: child.pid };
}

function stopUpdateProcess() {
  if (!updateState.running) return false;
  if (!updateState.pid) return false;

  // Kill whole process group (Linux/HA): negative pid targets group
  try {
    process.kill(-updateState.pid, "SIGTERM");
    pushUpdateLine("== UPDATE STOP requested (SIGTERM) ==");
    return true;
  } catch (e) {
    // Fallback: try killing just pid
    try {
      process.kill(updateState.pid, "SIGTERM");
      pushUpdateLine("== UPDATE STOP requested (SIGTERM pid-only fallback) ==");
      return true;
    } catch (e2) {
      pushUpdateLine(
        "== UPDATE STOP failed: " + String(e2?.message || e2) + " ==",
      );
      return false;
    }
  }
}

// ---------------------------
// helpers
// ---------------------------
function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(html);
}

async function readJsonSafe(p, fallback = null) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(p, obj) {
  const tmp = p + ".tmp";
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, p);
}

function requireToken(req) {
  if (!TOKEN) return true;
  const parsed = url.parse(req.url, true);
  const qToken = parsed?.query?.token ? String(parsed.query.token) : "";
  const hToken = String(req.headers["x-config-token"] || "");
  return (qToken && qToken === TOKEN) || (hToken && hToken === TOKEN);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---------------------------
// normalization + validation
// ---------------------------
function normalizeListsConfig(lists) {
  if (!lists || typeof lists !== "object") return lists;

  if (!lists.defaults || typeof lists.defaults !== "object")
    lists.defaults = {};
  if (!lists.defaults.dupRules || typeof lists.defaults.dupRules !== "object")
    lists.defaults.dupRules = {};
  if (!Array.isArray(lists.lists)) lists.lists = [];
  // smartPicks is optional
  if (lists.smartPicks && typeof lists.smartPicks !== "object")
    lists.smartPicks = null;

  for (const l of lists.lists) {
    if (!l || typeof l !== "object") continue;

    // normalize source.path
    if (!l.source || typeof l.source !== "object") l.source = { path: "" };
    if (typeof l.source.path !== "string")
      l.source.path = String(l.source.path || "");
    l.source.path = l.source.path.trim();
    if (l.source.path && !l.source.path.startsWith("/"))
      l.source.path = "/" + l.source.path;

    // normalize type
    const rawType = (l.type ?? "").toString().trim().toLowerCase();
    const rawPath = (l.source.path ?? "").toString().trim().toLowerCase();

    let t = rawType;
    if (t === "movies") t = "movie";
    if (t === "movie") t = "movie";
    if (t === "film" || t === "films") t = "movie";

    if (t === "shows" || t === "show" || t === "tv") t = "series";
    if (t === "series") t = "series";

    // infer if missing/invalid
    if (t !== "movie" && t !== "series") {
      t = rawPath.startsWith("/shows/") ? "series" : "movie";
    }
    l.type = t;

    // normalize filters
    if (l.filters && typeof l.filters !== "object") l.filters = {};
    if (!l.filters) l.filters = {};

    // normalize ids/names
    if (typeof l.id !== "string") l.id = String(l.id || "").trim();
    if (typeof l.name !== "string") l.name = String(l.name || "").trim();
  }

  return lists;
}

function isValidListsConfig(obj) {
  if (!obj || typeof obj !== "object") return "Config není objekt.";
  if (!obj.defaults || typeof obj.defaults !== "object")
    return "Chybí defaults.";
  if (!Array.isArray(obj.lists)) return "Chybí lists[].";

  for (const l of obj.lists) {
    if (!l || typeof l !== "object") return "List není objekt.";
    if (!l.id || typeof l.id !== "string") return "List musí mít id.";
    if (!l.name || typeof l.name !== "string")
      return `List ${l.id || "(unknown)"}: chybí name.`;
    if (!l.type || !["movie", "series"].includes(l.type))
      return `List ${l.id}: type musí být movie/series.`;
    if (!l.source || typeof l.source !== "object" || !l.source.path)
      return `List ${l.id}: chybí source.path.`;
    if (l.filters && typeof l.filters !== "object")
      return `List ${l.id}: filters musí být objekt.`;
  }
  return null;
}

function isValidSecrets(obj) {
  if (!obj || typeof obj !== "object") return "Secrets není objekt.";
  if (!obj.trakt || typeof obj.trakt !== "object")
    return "Chybí secrets.trakt.";
  if (typeof obj.trakt.client_id !== "string")
    return "secrets.trakt.client_id musí být string.";
  if (typeof obj.trakt.client_secret !== "string")
    return "secrets.trakt.client_secret musí být string.";
  return null;
}

// ---------------------------
// Trakt genres (server-side)
// ---------------------------
const traktGenresCache = {
  movie: { at: 0, data: null, err: "" },
  series: { at: 0, data: null, err: "" },
};

function normType(qType) {
  const t = String(qType || "")
    .trim()
    .toLowerCase();
  if (t === "show" || t === "shows" || t === "series") return "series";
  return "movie";
}

async function getTraktClientId() {
  const secretsFallback = { trakt: { client_id: "", client_secret: "" } };
  const secrets = await readJsonSafe(SECRETS_PATH, secretsFallback);
  return String(secrets?.trakt?.client_id || "").trim();
}

async function fetchTraktGenres(type) {
  const clientId = await getTraktClientId();
  if (!clientId) {
    const e = new Error("Chybí Trakt client_id v /data/config/secrets.json");
    e.code = "NO_TRAKT_CLIENT_ID";
    throw e;
  }

  // Trakt endpoint: /genres/movies or /genres/shows
  const pathPart = type === "series" ? "shows" : "movies";
  const endpoint = `https://api.trakt.tv/genres/${pathPart}`;

  const res = await fetch(endpoint, {
    method: "GET",
    headers: {
      "content-type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": clientId,
      "user-agent": "stremio-config-ui/0.0.1",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const e = new Error(
      `Trakt genres error ${res.status}: ${text || res.statusText}`,
    );
    e.code = "TRAKT_HTTP";
    throw e;
  }

  const json = await res.json();
  const genres = Array.isArray(json) ? json : [];

  const cleaned = genres
    .map((g) => ({
      slug: String(g?.slug || "")
        .trim()
        .toLowerCase(),
      name: String(g?.name || g?.slug || "").trim(),
    }))
    .filter((g) => g.slug);

  cleaned.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return cleaned;
}

async function getGenresCached(type) {
  const bucket =
    type === "series" ? traktGenresCache.series : traktGenresCache.movie;
  const now = Date.now();

  if (bucket.data && now - bucket.at < TRAKT_GENRES_TTL_MS) {
    return { genres: bucket.data, cached: true, ttlMs: TRAKT_GENRES_TTL_MS };
  }

  try {
    const genres = await fetchTraktGenres(type);
    bucket.data = genres;
    bucket.at = now;
    bucket.err = "";
    return { genres, cached: false, ttlMs: TRAKT_GENRES_TTL_MS };
  } catch (e) {
    bucket.err = String(e?.message || e);
    if (bucket.data && bucket.data.length) {
      return {
        genres: bucket.data,
        cached: true,
        stale: true,
        error: bucket.err,
        ttlMs: TRAKT_GENRES_TTL_MS,
      };
    }
    throw e;
  }
}

// ---------------------------
// server handler
// ---------------------------
async function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";

  // Preflight (optional)
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-config-token",
      "cache-control": "no-store",
    });
    return res.end();
  }

  // Static UI
  if (
    req.method === "GET" &&
    (pathname === "/" || pathname === "/index.html")
  ) {
    const html = await fs.readFile(INDEX_PATH, "utf8");
    return sendHtml(res, 200, html);
  }
  if (req.method === "GET" && pathname === "/client.js") {
    const js = await fs.readFile(CLIENT_PATH, "utf8");
    return sendText(res, 200, js, {
      "content-type": "application/javascript; charset=utf-8",
    });
  }

  // Token gate for API
  if (pathname.startsWith("/api/")) {
    if (!requireToken(req)) {
      return sendJson(
        res,
        401,
        {
          error:
            "Unauthorized. Set correct token (CONFIG_UI_TOKEN / input field).",
        },
        { "access-control-allow-origin": "*" },
      );
    }
  }

  // Health
  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(
      res,
      200,
      { ok: true },
      { "access-control-allow-origin": "*" },
    );
  }

  // UPDATE: status
  if (req.method === "GET" && pathname === "/api/update-status") {
    return sendJson(
      res,
      200,
      {
        ok: true,
        running: updateState.running,
        startedAt: updateState.startedAt,
        endedAt: updateState.endedAt,
        exitCode: updateState.exitCode,
        pid: updateState.pid,
        progress: updateState.progress,
        lastLine: updateState.lines.length
          ? updateState.lines[updateState.lines.length - 1]
          : "",
      },
      { "access-control-allow-origin": "*" },
    );
  }

  // UPDATE: stream (SSE)
  if (req.method === "GET" && pathname === "/api/update-stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });

    // Keep-alive ping (helps with proxies / long idle)
    const keepAlive = setInterval(() => {
      try {
        res.write(":keep-alive\n\n");
      } catch {}
    }, 15000);

    // initial dump last ~200 lines
    const start = Math.max(0, updateState.lines.length - 200);
    for (let i = start; i < updateState.lines.length; i++) {
      res.write(
        `data: ${JSON.stringify({
          line: updateState.lines[i],
          at: Date.now(),
          progress: updateState.progress,
        })}\n\n`,
      );
    }
    res.write(
      `event: status\ndata: ${JSON.stringify({
        running: updateState.running,
        progress: updateState.progress,
      })}\n\n`,
    );

    updateState.clients.add(res);
    req.on("close", () => {
      clearInterval(keepAlive);
      updateState.clients.delete(res);
    });
    return;
  }

  // UPDATE: run
  if (req.method === "POST" && pathname === "/api/run-update") {
    try {
      const out = startUpdateProcess();
      return sendJson(
        res,
        200,
        { ok: true, ...out },
        { "access-control-allow-origin": "*" },
      );
    } catch (e) {
      const msg = String(e?.message || e);
      const status = e?.code === "ALREADY_RUNNING" ? 409 : 500;
      return sendJson(
        res,
        status,
        { ok: false, error: msg },
        { "access-control-allow-origin": "*" },
      );
    }
  }

  // UPDATE: stop
  if (req.method === "POST" && pathname === "/api/stop-update") {
    const ok = stopUpdateProcess();
    return sendJson(
      res,
      200,
      { ok: true, stopped: ok },
      { "access-control-allow-origin": "*" },
    );
  }

  // Trakt genres (server-side proxy)
  if (req.method === "GET" && pathname === "/api/trakt-genres") {
    const type = normType(parsed?.query?.type);
    try {
      const out = await getGenresCached(type);
      return sendJson(
        res,
        200,
        { ok: true, type, ...out },
        { "access-control-allow-origin": "*" },
      );
    } catch (e) {
      return sendJson(
        res,
        500,
        { ok: false, error: String(e?.message || e), type },
        { "access-control-allow-origin": "*" },
      );
    }
  }

  // Restart addon server (no PM2; uses node tools/restart-addon.js)
  if (req.method === "POST" && pathname === "/api/restart-addon") {
    exec(
      "node tools/restart-addon.js",
      { cwd: ROOT, env: { ...process.env, DATA_DIR } },
      (err, stdout, stderr) => {
        if (err) {
          return sendJson(
            res,
            500,
            { error: String(err.message || err), stdout, stderr },
            { "access-control-allow-origin": "*" },
          );
        }
        return sendJson(
          res,
          200,
          { ok: true, stdout, stderr },
          { "access-control-allow-origin": "*" },
        );
      },
    );
    return;
  }

  // GET config
  if (req.method === "GET" && pathname === "/api/config") {
    const listsFallback = {
      defaults: {
        candidatePages: 5,
        pageLimit: 100,
        finalSize: 140,
        sleepMs: 120,
        timeoutMs: 15000,
        csfdCacheTtlDays: 30,
        dupRules: { hardBlockTop: 45, penaltyPerHit: 80 },
      },
      lists: [],
      smartPicks: { enabled: true, defaultSize: 10, profiles: [] },
    };

    const secretsFallback = { trakt: { client_id: "", client_secret: "" } };

    let lists = await readJsonSafe(LISTS_PATH, listsFallback);
    let secrets = await readJsonSafe(SECRETS_PATH, secretsFallback);

    // normalize on read
    lists = normalizeListsConfig(lists);
    if (!secrets || typeof secrets !== "object") secrets = secretsFallback;
    if (!secrets.trakt || typeof secrets.trakt !== "object")
      secrets.trakt = secretsFallback.trakt;
    if (typeof secrets.trakt.client_id !== "string")
      secrets.trakt.client_id = String(secrets.trakt.client_id || "");
    if (typeof secrets.trakt.client_secret !== "string")
      secrets.trakt.client_secret = String(secrets.trakt.client_secret || "");

    return sendJson(
      res,
      200,
      { lists, secrets },
      { "access-control-allow-origin": "*" },
    );
  }

  // POST config (save both lists + secrets)
  if (req.method === "POST" && pathname === "/api/config") {
    const raw = await readBody(req);
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      return sendJson(
        res,
        400,
        { error: "Invalid JSON" },
        { "access-control-allow-origin": "*" },
      );
    }

    let lists = body?.lists;
    const secrets = body?.secrets;

    lists = normalizeListsConfig(lists);

    const listsErr = isValidListsConfig(lists);
    if (listsErr)
      return sendJson(
        res,
        400,
        { error: listsErr },
        { "access-control-allow-origin": "*" },
      );

    const secErr = isValidSecrets(secrets);
    if (secErr)
      return sendJson(
        res,
        400,
        { error: secErr },
        { "access-control-allow-origin": "*" },
      );

    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await writeJsonAtomic(LISTS_PATH, lists);
    await writeJsonAtomic(SECRETS_PATH, secrets);

    // invalidate genres cache
    traktGenresCache.movie.at = 0;
    traktGenresCache.series.at = 0;

    return sendJson(
      res,
      200,
      {
        ok: true,
        wrote: {
          lists: LISTS_PATH,
          secrets: SECRETS_PATH,
        },
      },
      { "access-control-allow-origin": "*" },
    );
  }

  return sendJson(
    res,
    404,
    { error: "Not found" },
    { "access-control-allow-origin": "*" },
  );
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("CONFIG-UI ERROR:", e);
      sendJson(
        res,
        500,
        { error: String(e?.message || e) },
        { "access-control-allow-origin": "*" },
      );
    });
  })
  .listen(PORT, HOST, () => {
    const shownHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log(`Config UI running on http://${shownHost}:${PORT}`);
    console.log(`Config path: ${CONFIG_DIR}`);
    console.log(
      `Token protection: ${
        TOKEN ? "ENABLED" : "DISABLED (set CONFIG_UI_TOKEN for LAN safety)"
      }`,
    );
    console.log(`Trakt genres cache TTL: ${TRAKT_GENRES_TTL_MS} ms`);
    console.log(`Update cmd: ${UPDATE_CMD}`);
    console.log(`DATA_DIR: ${DATA_DIR}`);
  });
