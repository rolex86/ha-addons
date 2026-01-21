const express = require("express");
const path = require("path");

const {
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
const { generateTracks, replacePlaylistItems } = require("./lib/generator");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Static UI
app.use("/", express.static(path.join(__dirname, "public")));

const db = openDb();

let lastRun = {
  at: null,
  ok: null,
  summary: null,
  error: null,
};

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

app.get("/api/status", async (req, res) => {
  const opts = getOptions();
  const tokens = loadTokens();
  res.json({
    ok: true,
    port: opts.port,
    base_url: opts.base_url,
    market: opts.market,
    auth: {
      has_refresh_token: Boolean(tokens.refresh_token),
      refreshed_at: tokens.refreshed_at || null,
    },
    last_run: lastRun,
  });
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
  // store state in memory (MVP). If you want harden, store in /data.
  app.locals.oauth_state = state;

  const authorizeURL = sp.createAuthorizeURL(scopes, state, true);
  res.json({ ok: true, url: authorizeURL });
});

// OAuth callback
app.get("/api/auth/callback", async (req, res) => {
  const opts = getOptions();
  const code = req.query.code;
  const state = req.query.state;

  if (!code) return res.status(400).send("Missing code.");
  if (app.locals.oauth_state && state !== app.locals.oauth_state) {
    return res.status(400).send("Invalid state.");
  }

  const sp = createClient();
  try {
    const data = await sp.authorizationCodeGrant(code);
    const access_token = data.body["access_token"];
    const refresh_token = data.body["refresh_token"];

    saveTokens({
      access_token,
      refresh_token,
      refreshed_at: Date.now(),
    });

    res.send(`OK. Authorized. You can close this window.`);
  } catch (e) {
    res.status(500).send("Auth failed: " + String(e?.message || e));
  }
});

// Run (triggered by HA automation)
app.post("/api/run", requireToken, async (req, res) => {
  const opts = getOptions();
  const sp = createClient();

  try {
    const okTok = await ensureAccessToken(sp);
    if (!okTok.ok) {
      lastRun = {
        at: Date.now(),
        ok: false,
        summary: null,
        error: "not_authorized",
      };
      return res.status(400).json({ ok: false, error: "not_authorized" });
    }

    const cfg = loadRecipesConfig();
    const recipes = cfg.recipes || [];
    const runResults = [];

    for (const recipe of recipes) {
      if (!recipe?.id) continue;
      if (!recipe?.target_playlist_id) {
        runResults.push({
          recipe_id: recipe.id,
          ok: false,
          error: "missing_target_playlist_id",
        });
        continue;
      }

      const excludedSet = await getExcludedSet(db, {
        historyScope: opts.history.scope,
        recipeId: recipe.id,
        mode: opts.history.mode,
        rollingDays: opts.history.rolling_days,
        lifetimeCap: opts.history.lifetime_cap,
      });

      const tracks = await generateTracks({
        sp,
        recipe,
        market: opts.market,
        excludedSet,
      });

      const uris = tracks.map((t) => `spotify:track:${t.id}`);

      if (uris.length < Number(recipe.track_count ?? 50)) {
        // Not enough candidates; still write what we have (or fail based on recipe policy)
        // MVP: write what we have
      }

      await replacePlaylistItems({
        sp,
        playlistId: recipe.target_playlist_id,
        trackUris: uris,
      });

      await recordUsed(db, {
        historyScope: opts.history.scope,
        recipeId: recipe.id,
        trackIds: tracks.map((t) => t.id),
      });

      await prune(db, {
        historyScope: opts.history.scope,
        recipeId: recipe.id,
        mode: opts.history.mode,
        rollingDays: opts.history.rolling_days,
        lifetimeCap: opts.history.lifetime_cap,
      });

      runResults.push({
        recipe_id: recipe.id,
        ok: true,
        added: uris.length,
      });
    }

    lastRun = { at: Date.now(), ok: true, summary: runResults, error: null };
    res.json({ ok: true, results: runResults });
  } catch (e) {
    lastRun = {
      at: Date.now(),
      ok: false,
      summary: null,
      error: String(e?.message || e),
    };
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Utility endpoints
app.post("/api/history/clear", requireToken, async (req, res) => {
  db.serialize(() => {
    db.run(`DELETE FROM history`, [], (err) => {
      if (err)
        return res
          .status(500)
          .json({ ok: false, error: String(err.message || err) });
      res.json({ ok: true });
    });
  });
});

const opts = getOptions();
const port = opts.port || 7790;
app.listen(port, () => {
  console.log(`[spotify-playlists] listening on :${port}`);
});
