// app/server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const https = require("https");

const {
  DATA_DIR,
  getOptions,
  loadRecipesConfig,
  saveRecipesConfig,
} = require("./lib/config");
const {
  createClient,
  ensureAccessToken,
  saveTokens,
  loadTokens,
} = require("./lib/spotify");
const { openDb, getExcludedSet, recordUsed, prune } = require("./lib/history");
const {
  generateTracksWithMeta,
  replacePlaylistItems,
} = require("./lib/generator");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Static UI
app.use(
  "/",
  express.static(path.join(__dirname, "public"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
    },
  }),
);

const db = openDb();

let lastRun = {
  at: null,
  ok: null,
  summary: null,
  error: null,
};

// --- run lock ---
let runInProgress = false;

// --- run logger (in-memory ring buffer) ---
const RUN_LOG_MAX = 1500;
let runSeq = 0;

let runState = {
  running: false,
  run_id: null,
  started_at: null,
  finished_at: null,
  ok: null,
  error: null,
};

let runLogs = []; // { i, ts, run_id, level, msg }

function logRun(level, msg, run_id = runState.run_id) {
  const line = {
    i: runLogs.length ? runLogs[runLogs.length - 1].i + 1 : 1,
    ts: Date.now(),
    run_id,
    level,
    msg: String(msg),
  };
  runLogs.push(line);
  if (runLogs.length > RUN_LOG_MAX) runLogs = runLogs.slice(-RUN_LOG_MAX);
  console.log(`[runlog][${level}] ${line.msg}`);
  return line;
}

function formatErr(e) {
  const status = e?.statusCode || e?.status || null;

  const headers = e?.headers || e?.response?.headers || null;
  const retry_after =
    headers?.["retry-after"] ||
    headers?.["Retry-After"] ||
    e?.body?.error?.retry_after ||
    null;

  const body = e?.body || e?.response?.body || null;

  const message =
    e?.body?.error?.message ||
    e?.body?.error_description ||
    e?.message ||
    (typeof e === "string" ? e : null) ||
    (body ? JSON.stringify(body) : null) ||
    String(e);

  return { status, message, retry_after, body };
}

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method: "GET",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let body = null;
          try {
            body = data ? JSON.parse(data) : {};
          } catch {
            body = { raw: data };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body });
          } else {
            const err = new Error("spotify_http_error");
            err.status = res.statusCode;
            err.body = body;
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function requireToken(req, res, next) {
  const opts = getOptions();
  if (!opts.api_token) return next();

  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token || token !== opts.api_token) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

/* ---------------- Spotify retry helper (server-side) ---------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function spRetry(fn, { maxRetries = 6, baseDelayMs = 400 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.statusCode || e?.status;
      const headers = e?.headers || e?.response?.headers;
      const ra = headers?.["retry-after"] || headers?.["Retry-After"];
      const retryAfterMs = ra ? Number(ra) * 1000 : null;

      const isRetryable =
        status === 429 || status === 502 || status === 503 || status === 504;

      if (!isRetryable || attempt >= maxRetries) throw e;

      const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
      const waitMs = retryAfterMs ?? backoff;

      await sleep(waitMs);
      attempt += 1;
    }
  }
}

// Fetch current track IDs from a target playlist (to avoid repeats even after DB reset)
async function fetchPlaylistTrackIdSet(
  sp,
  playlistId,
  { maxItems = 10000 } = {},
) {
  const pid = String(playlistId || "").trim();
  const set = new Set();

  if (!pid) return set;

  let offset = 0;
  const limit = 100;

  while (set.size < maxItems) {
    const resp = await spRetry(() =>
      sp.getPlaylistTracks(pid, {
        limit,
        offset,
        fields: "items(track(id)),next",
      }),
    );

    const items = resp.body?.items || [];
    for (const it of items) {
      const id = it?.track?.id || null;
      if (id) set.add(id);
      if (set.size >= maxItems) break;
    }

    if (!resp.body?.next) break;
    offset += limit;

    // hard safety
    if (offset > maxItems + 500) break;
  }

  return set;
}

/* ---------------- endpoints ---------------- */

app.get("/api/status", async (req, res) => {
  const opts = getOptions();
  const tokens = loadTokens();

  res.json({
    ok: true,
    port: opts.port,
    base_url: opts.base_url,
    market: opts.market,
    external_keys: {
      lastfm: Boolean(opts.lastfm_api_key),
      tastedive: Boolean(opts.tastedive_api_key),
      audiodb: Boolean(opts.audiodb_api_key),
      songkick: Boolean(opts.songkick_api_key),
    },
    auth: {
      has_refresh_token: Boolean(tokens.refresh_token),
      refreshed_at: tokens.refreshed_at || null,
    },
    last_run: lastRun,
    run_state: runState,
  });
});

// Run status + logs (polling)
app.get("/api/run/status", requireToken, async (req, res) => {
  res.json({ ok: true, state: runState });
});

app.get("/api/run/logs", requireToken, async (req, res) => {
  const since = Number(req.query.since || 0);
  const run_id = req.query.run_id ? Number(req.query.run_id) : null;

  const lines = runLogs.filter((l) => {
    if (since && l.i <= since) return false;
    if (run_id && l.run_id !== run_id) return false;
    return true;
  });

  res.json({
    ok: true,
    latest_i: runLogs.length ? runLogs[runLogs.length - 1].i : since,
    lines,
  });
});

app.post("/api/run/logs/clear", requireToken, async (req, res) => {
  runLogs = [];
  res.json({ ok: true });
});

// Debug: who am I?
app.get("/api/debug/me", requireToken, async (req, res) => {
  const sp = createClient();
  try {
    const okTok = await ensureAccessToken(sp);
    if (!okTok.ok)
      return res.status(400).json({ ok: false, error: "not_authorized" });

    const me = await sp.getMe();
    res.json({ ok: true, me: me.body });
  } catch (e) {
    const fe = formatErr(e);
    res.status(500).json({ ok: false, error: fe });
  }
});

// Debug: can I read playlist?
app.get("/api/debug/playlist/:id", requireToken, async (req, res) => {
  const sp = createClient();
  try {
    const okTok = await ensureAccessToken(sp);
    if (!okTok.ok)
      return res.status(400).json({ ok: false, error: "not_authorized" });

    const pid = String(req.params.id || "").trim();
    const pl = await sp.getPlaylist(pid);
    res.json({
      ok: true,
      playlist: {
        id: pl.body.id,
        name: pl.body.name,
        owner: pl.body.owner?.id,
        public: pl.body.public,
        collaborative: pl.body.collaborative,
        tracks_total: pl.body.tracks?.total,
      },
    });
  } catch (e) {
    const fe = formatErr(e);
    res.status(500).json({ ok: false, error: fe });
  }
});

// Debug: write test
app.post(
  "/api/debug/write_test/:playlistId",
  requireToken,
  async (req, res) => {
    const sp = createClient();
    try {
      const okTok = await ensureAccessToken(sp);
      if (!okTok.ok)
        return res.status(400).json({ ok: false, error: "not_authorized" });

      const pid = String(req.params.playlistId || "").trim();
      const uri = "spotify:track:4cOdK2wGLETKBW3PvgPWqT"; // Rick Astley

      await replacePlaylistItems({ sp, playlistId: pid, trackUris: [uri] });

      res.json({ ok: true, playlistId: pid, wrote: 1 });
    } catch (e) {
      const fe = formatErr(e);
      res.status(500).json({ ok: false, error: fe });
    }
  },
);

/* ---------------- Spotify genre seeds (for UI picker) ---------------- */

const GENRE_SEEDS_CACHE = path.join(
  DATA_DIR,
  "cache",
  "spotify_genre_seeds.json",
);
const GENRE_SEEDS_TTL_MS = 24 * 60 * 60 * 1000;

function readJsonFileSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

app.get("/api/spotify/genre-seeds", async (req, res) => {
  const sp = createClient();
  try {
    const okTok = await ensureAccessToken(sp);
    if (!okTok.ok)
      return res.status(400).json({ ok: false, error: "not_authorized" });

    const force = String(req.query.force || "").toLowerCase();
    const forceRefresh = force === "1" || force === "true" || force === "yes";

    const now = Date.now();

    if (!forceRefresh) {
      const cached = readJsonFileSafe(GENRE_SEEDS_CACHE);
      if (
        cached &&
        Array.isArray(cached.genres) &&
        cached.genres.length &&
        cached.fetched_at &&
        now - Number(cached.fetched_at) < GENRE_SEEDS_TTL_MS
      ) {
        return res.json({
          ok: true,
          genres: cached.genres,
          fetched_at: cached.fetched_at,
          cached: true,
          count: cached.genres.length,
        });
      }
    }

    let genres = [];
    try {
      const resp = await spRetry(() => sp.getAvailableGenreSeeds());
      genres = resp?.body?.genres || [];
    } catch (e1) {
      // Fallback: call Spotify endpoint directly (some spotify-web-api-node builds return 404 here)
      const token = sp.getAccessToken();
      if (!token) throw e1;
      const r = await httpsGetJson(
        "https://api.spotify.com/v1/recommendations/available-genre-seeds",
        { Authorization: `Bearer ${token}` },
      );
      genres = r?.body?.genres || [];
    }

    try {
      fs.mkdirSync(path.dirname(GENRE_SEEDS_CACHE), { recursive: true });
      fs.writeFileSync(
        GENRE_SEEDS_CACHE,
        JSON.stringify({ fetched_at: now, genres }, null, 2),
        "utf8",
      );
    } catch (_) {}

    res.json({
      ok: true,
      genres,
      fetched_at: now,
      cached: false,
      count: genres.length,
    });
  } catch (e) {
    const fe = formatErr(e);
    res.status(500).json({ ok: false, error: fe });
  }
});

app.get("/api/config", async (req, res) => {
  res.json({ ok: true, config: loadRecipesConfig() });
});

app.post("/api/config", async (req, res) => {
  const cfg = req.body?.config;
  if (!cfg || typeof cfg !== "object")
    return res.status(400).json({ ok: false, error: "invalid_config" });
  if (!Array.isArray(cfg.recipes)) cfg.recipes = [];
  saveRecipesConfig(cfg);
  res.json({ ok: true });
});

// OAuth start
app.post("/api/auth/start", async (req, res) => {
  const opts = getOptions();
  if (
    !opts.spotify_client_id ||
    !opts.spotify_client_secret ||
    !opts.spotify_redirect_uri
  ) {
    return res
      .status(400)
      .json({ ok: false, error: "missing_spotify_client_config" });
  }

  const sp = createClient();
  const scopes = [
    "playlist-read-private",
    "playlist-modify-private",
    "playlist-modify-public",
    "user-library-read",
    "user-top-read",
  ];

  const state = Math.random().toString(36).slice(2);
  app.locals.oauth_state = state;

  const authorizeURL = sp.createAuthorizeURL(scopes, state, true);
  res.json({ ok: true, url: authorizeURL });
});

// OAuth callback
app.get("/api/auth/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  if (!code) return res.status(400).send("Missing code.");
  if (app.locals.oauth_state && state !== app.locals.oauth_state)
    return res.status(400).send("Invalid state.");

  const sp = createClient();
  try {
    const data = await sp.authorizationCodeGrant(code);
    const access_token = data.body["access_token"];
    const refresh_token = data.body["refresh_token"];

    saveTokens({ access_token, refresh_token, refreshed_at: Date.now() });
    res.send("OK. Authorized. You can close this window.");
  } catch (e) {
    const fe = formatErr(e);
    res.status(500).json({ ok: false, error: fe });
  }
});

// Run (triggered by HA automation / UI)
app.post("/api/run", requireToken, async (req, res) => {
  const opts = getOptions();

  // Map addon options -> env (so generator reads it consistently)
  if (opts.lastfm_api_key && !process.env.LASTFM_API_KEY) {
    process.env.LASTFM_API_KEY = String(opts.lastfm_api_key);
  }
  if (opts.tastedive_api_key && !process.env.TASTEDIVE_API_KEY) {
    process.env.TASTEDIVE_API_KEY = String(opts.tastedive_api_key);
  }
  if (opts.audiodb_api_key && !process.env.AUDIODB_API_KEY) {
    process.env.AUDIODB_API_KEY = String(opts.audiodb_api_key);
  }
  if (opts.songkick_api_key && !process.env.SONGKICK_API_KEY) {
    process.env.SONGKICK_API_KEY = String(opts.songkick_api_key);
  }

  const sp = createClient();

  if (runInProgress) {
    return res
      .status(409)
      .json({ ok: false, error: { status: 409, message: "run_in_progress" } });
  }

  runInProgress = true;

  runSeq += 1;
  runState = {
    running: true,
    run_id: runSeq,
    started_at: Date.now(),
    finished_at: null,
    ok: null,
    error: null,
  };

  logRun("info", `Run started (run_id=${runState.run_id})`);

  try {
    const okTok = await ensureAccessToken(sp);
    if (!okTok.ok) {
      lastRun = {
        at: Date.now(),
        ok: false,
        summary: null,
        error: "not_authorized",
      };

      runState.running = false;
      runState.finished_at = Date.now();
      runState.ok = false;
      runState.error = { status: 400, message: "not_authorized" };
      logRun("error", "Not authorized (missing/invalid refresh token).");
      return res.status(400).json({ ok: false, error: "not_authorized" });
    }

    const cfg = loadRecipesConfig();
    const recipes = cfg.recipes || [];
    const runResults = [];

    logRun("info", `Loaded recipes: ${recipes.length}`);

    for (const recipe of recipes) {
      if (!recipe?.id) continue;

      // History scope can be overridden per recipe (history.scope)
      // Values: inherit | per_recipe | global
      let effectiveHistoryScope = opts.history.scope || "per_recipe";
      const rScope = recipe?.history?.scope;
      if (rScope && rScope !== "inherit") {
        effectiveHistoryScope = String(rScope);
      }

      if (!recipe?.target_playlist_id) {
        logRun("warn", `Recipe ${recipe.id}: missing target_playlist_id`);
        runResults.push({
          recipe_id: recipe.id,
          ok: false,
          error: "missing_target_playlist_id",
        });
        continue;
      }

      logRun("info", `Recipe ${recipe.id}: preparing excluded set...`);

      // 1) history-based exclude
      const historyExcluded = await getExcludedSet(db, {
        historyScope: effectiveHistoryScope,
        recipeId: recipe.id,
        mode: opts.history.mode,
        rollingDays: opts.history.rolling_days,
        lifetimeCap: opts.history.lifetime_cap,
      });

      // 2) playlist-content exclude (robust no-repeat even after DB reset)
      const playlistExcluded = await fetchPlaylistTrackIdSet(
        sp,
        recipe.target_playlist_id,
        { maxItems: 10000 },
      );

      // union
      const excludedSet = new Set([...historyExcluded, ...playlistExcluded]);

      logRun(
        "debug",
        `Recipe ${recipe.id}: excluded history=${historyExcluded.size} playlist=${playlistExcluded.size} total=${excludedSet.size}`,
      );

      logRun("info", `Recipe ${recipe.id}: generating tracks...`);

      const { tracks, meta } = await generateTracksWithMeta({
        sp,
        recipe,
        market: opts.market,
        excludedSet,
      });

      const uris = tracks.map((t) => `spotify:track:${t.id}`);

      logRun(
        "info",
        `Recipe ${recipe.id}: generated=${tracks.length} provider=${meta.used_provider} audiodb=${meta.counts?.audiodb_selected || 0} discovery=${meta.counts?.lastfm_selected || 0} reco=${meta.counts?.reco_selected || 0} sources=${meta.counts?.sources_selected || 0}`,
      );
      if (meta?.notes?.length)
        logRun("debug", `Recipe ${recipe.id}: notes=${meta.notes.join(",")}`);

      if (uris.length === 0) {
        logRun(
          "warn",
          `Recipe ${recipe.id}: no tracks generated, skipping write.`,
        );
        runResults.push({
          recipe_id: recipe.id,
          ok: false,
          error: "no_tracks_generated",
          meta,
        });
        continue;
      }

      logRun(
        "info",
        `Recipe ${recipe.id}: writing ${uris.length} tracks to playlist ${recipe.target_playlist_id}...`,
      );

      await replacePlaylistItems({
        sp,
        playlistId: recipe.target_playlist_id,
        trackUris: uris,
      });

      logRun("info", `Recipe ${recipe.id}: playlist updated OK.`);

      await recordUsed(db, {
        historyScope: effectiveHistoryScope,
        recipeId: recipe.id,
        trackIds: tracks.map((t) => t.id),
      });

      await prune(db, {
        historyScope: effectiveHistoryScope,
        recipeId: recipe.id,
        mode: opts.history.mode,
        rollingDays: opts.history.rolling_days,
        lifetimeCap: opts.history.lifetime_cap,
      });

      runResults.push({
        recipe_id: recipe.id,
        ok: true,
        added: uris.length,
        meta,
      });
    }

    lastRun = { at: Date.now(), ok: true, summary: runResults, error: null };

    runState.running = false;
    runState.finished_at = Date.now();
    runState.ok = true;

    logRun("info", `Run finished OK (run_id=${runState.run_id})`);

    res.json({ ok: true, results: runResults });
  } catch (e) {
    const fe = formatErr(e);

    logRun(
      "error",
      `Run failed: status=${fe.status} message=${fe.message} retry_after=${fe.retry_after || ""}`,
    );

    lastRun = { at: Date.now(), ok: false, summary: null, error: fe };

    runState.running = false;
    runState.finished_at = Date.now();
    runState.ok = false;
    runState.error = fe;

    res.status(500).json({ ok: false, error: fe });
  } finally {
    runInProgress = false;
  }
});

// Utility endpoints
app.post("/api/history/clear", requireToken, async (req, res) => {
  db.serialize(() => {
    db.run("DELETE FROM history", [], (err) => {
      if (err)
        return res.status(500).json({ ok: false, error: formatErr(err) });
      res.json({ ok: true });
    });
  });
});

const opts = getOptions();
const port = opts.port || 7790;

app.listen(port, () => {
  console.log(`[spotify-playlists] listening on :${port}`);
});
