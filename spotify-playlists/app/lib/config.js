const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/data";
const OPTIONS_PATH = path.join(DATA_DIR, "options.json"); // HA Supervisor writes this (optional locally)
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function toNumOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toBoolOr(v, fallback) {
  if (v === true || v === false) return v;
  if (v === "true" || v === "1" || v === 1) return true;
  if (v === "false" || v === "0" || v === 0) return false;
  return fallback;
}

function toStrOr(v, fallback) {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function normalizeRecipe(recipe) {
  const r = recipe && typeof recipe === "object" ? recipe : {};

  if (!r.id) r.id = `r_${Math.random().toString(36).slice(2, 10)}`;
  if (!r.name) r.name = "Recipe";
  if (!r.target_playlist_id) r.target_playlist_id = "";
  r.track_count = toNumOr(r.track_count, 50);
  // Per-recipe enable/disable (default: enabled)
  r.enabled = toBoolOr(r.enabled, true);

  // ---- discovery ----
  if (!r.discovery || typeof r.discovery !== "object") r.discovery = {};
  const d = r.discovery;

  d.enabled = toBoolOr(d.enabled, false);

  // Back-compat: UI uses nested seed_top_artists; generator also supports flat keys.
  // Normalize so BOTH exist.
  if (!d.seed_top_artists || typeof d.seed_top_artists !== "object") {
    d.seed_top_artists = { time_range: "short_term", limit: 10 };
  } else {
    d.seed_top_artists.time_range = toStrOr(
      d.seed_top_artists.time_range,
      "short_term",
    );
    d.seed_top_artists.limit = toNumOr(d.seed_top_artists.limit, 10);
  }

  // Provide flat aliases (generator-friendly)
  if (d.seed_top_artists_time_range == null) {
    d.seed_top_artists_time_range = d.seed_top_artists.time_range;
  } else {
    d.seed_top_artists_time_range = toStrOr(
      d.seed_top_artists_time_range,
      "short_term",
    );
  }

  if (d.seed_top_artists_limit == null) {
    d.seed_top_artists_limit = d.seed_top_artists.limit;
  } else {
    d.seed_top_artists_limit = toNumOr(d.seed_top_artists_limit, 10);
  }

  d.similar_per_seed = toNumOr(d.similar_per_seed, 50);
  d.take_artists = toNumOr(d.take_artists, 150);
  d.tracks_per_artist = toNumOr(d.tracks_per_artist, 2);

  // Strategy/provider: keep what user has, but ensure defined
  d.strategy = toStrOr(d.strategy ?? d.provider ?? "deep_cuts", "deep_cuts");

  // additional discovery knobs (used by generator)
  if (d.include_seed_artists == null) d.include_seed_artists = false;
  if (d.albums_per_artist == null) d.albums_per_artist = 2;
  if (d.albums_limit_fetch == null) d.albums_limit_fetch = 8;
  if (d.max_track_popularity == null) d.max_track_popularity = 60;
  if (d.min_track_popularity == null) d.min_track_popularity = null;
  if (d.exclude_saved_tracks == null) d.exclude_saved_tracks = true;
  if (d.search_limit_per_track == null) d.search_limit_per_track = 5;

  // ---- external discovery / charts (optional) ----
  if (d.use_tastedive == null) d.use_tastedive = false;
  if (d.tastedive_limit == null) d.tastedive_limit = 80;
  if (d.use_audiodb_trending == null) d.use_audiodb_trending = false;
  if (d.audiodb_country == null) d.audiodb_country = ""; // empty => derive from market
  if (d.audiodb_limit == null) d.audiodb_limit = 30;
  if (d.audiodb_fill == null) d.audiodb_fill = null; // null => auto (portion of track_count)

  // Songkick events (optional)
  if (d.use_songkick_events == null) d.use_songkick_events = false;
  if (d.songkick_location_query == null) d.songkick_location_query = "";
  if (d.songkick_metro_area_id == null) d.songkick_metro_area_id = "";
  if (d.songkick_days_ahead == null) d.songkick_days_ahead = 30;
  if (d.songkick_take_artists == null) d.songkick_take_artists = 60;

  // ---- sources ----
  if (!r.sources || typeof r.sources !== "object") r.sources = {};
  const s = r.sources;
  if (!Array.isArray(s.search)) s.search = [];
  if (!Array.isArray(s.playlists)) s.playlists = [];
  s.liked = toBoolOr(s.liked, false);
  s.max_candidates = toNumOr(s.max_candidates, 1500);

  if (!s.top_tracks || typeof s.top_tracks !== "object") {
    s.top_tracks = { enabled: true, time_range: "short_term", limit: 50 };
  } else {
    s.top_tracks.enabled = toBoolOr(s.top_tracks.enabled, true);
    s.top_tracks.time_range = toStrOr(s.top_tracks.time_range, "short_term");
    s.top_tracks.limit = toNumOr(s.top_tracks.limit, 50);
  }

  // ---- filters ----
  if (!r.filters || typeof r.filters !== "object") r.filters = {};
  const f = r.filters;
  f.explicit = toStrOr(f.explicit, "allow"); // allow|exclude|only
  f.year_min =
    f.year_min === "" || f.year_min === undefined
      ? null
      : f.year_min === null
        ? null
        : toNumOr(f.year_min, null);
  f.year_max =
    f.year_max === "" || f.year_max === undefined
      ? null
      : f.year_max === null
        ? null
        : toNumOr(f.year_max, null);
  f.duration_min =
    f.duration_min === "" || f.duration_min === undefined
      ? null
      : f.duration_min === null
        ? null
        : toNumOr(f.duration_min, null);
  f.duration_max =
    f.duration_max === "" || f.duration_max === undefined
      ? null
      : f.duration_max === null
        ? null
        : toNumOr(f.duration_max, null);
  // optional tempo fields (generator supports)
  if (f.tempo_min === undefined) f.tempo_min = null;
  if (f.tempo_max === undefined) f.tempo_max = null;

  // optional genre filtering (Spotify artist genres)
  // mode: ignore | include | exclude | include_exclude
  if (f.genres_mode == null) f.genres_mode = "ignore";
  if (!Array.isArray(f.genres_include)) f.genres_include = [];
  if (!Array.isArray(f.genres_exclude)) f.genres_exclude = [];

  // If enabled, tracks with no artist genres may pass include/include_exclude.
  if (f.allow_unknown_genres == null) f.allow_unknown_genres = true;

  // UI-only: how to display root genre pills (curated|auto)
  if (f.genres_root_mode == null) f.genres_root_mode = "curated";

  // ---- per-recipe history scope override (optional) ----
  // If missing or set to "inherit", addon options history.scope is used.
  if (!r.history || typeof r.history !== "object") r.history = {};
  if (r.history.scope == null) r.history.scope = "inherit"; // inherit|per_recipe|global

  // Per-recipe history retention (optional)
  // enabled: true/false (default true)
  // rolling_days: number|null (override addon options.history.rolling_days)
  // auto_flush: if enabled, clears history when too much of the sources pool is blocked by history
  r.history.enabled = toBoolOr(r.history.enabled, true);

  const rdOv = r.history.rolling_days;
  r.history.rolling_days =
    rdOv === "" || rdOv === undefined || rdOv === null
      ? null
      : toNumOr(rdOv, null);

  if (!r.history.auto_flush || typeof r.history.auto_flush !== "object")
    r.history.auto_flush = {};
  r.history.auto_flush.enabled = toBoolOr(r.history.auto_flush.enabled, false);
  r.history.auto_flush.threshold_pct = toNumOr(
    r.history.auto_flush.threshold_pct,
    80,
  );
  // Only evaluate auto-flush if sources pool is at least this big (avoids tiny-pool false positives)
  r.history.auto_flush.min_pool = toNumOr(r.history.auto_flush.min_pool, 200);

  // ---- diversity/limits (back-compat) ----
  // Some configs had `limits`, some `diversity`. Keep both but ensure `diversity` is present.
  if (!r.diversity || typeof r.diversity !== "object") r.diversity = {};
  const dv = r.diversity;
  const legacy = r.limits && typeof r.limits === "object" ? r.limits : {};

  // Prefer diversity.* if present, else fallback to limits.*
  if (dv.max_per_artist == null && legacy.max_per_artist != null)
    dv.max_per_artist = legacy.max_per_artist;
  if (dv.max_per_album == null && legacy.max_per_album != null)
    dv.max_per_album = legacy.max_per_album;
  if (
    dv.avoid_same_artist_in_row == null &&
    legacy.avoid_same_artist_in_row != null
  )
    dv.avoid_same_artist_in_row = legacy.avoid_same_artist_in_row;

  // normalize types
  dv.max_per_artist =
    dv.max_per_artist === "" ||
    dv.max_per_artist === undefined ||
    dv.max_per_artist === null
      ? null
      : toNumOr(dv.max_per_artist, null);
  dv.max_per_album =
    dv.max_per_album === "" ||
    dv.max_per_album === undefined ||
    dv.max_per_album === null
      ? null
      : toNumOr(dv.max_per_album, null);
  dv.avoid_same_artist_in_row = toBoolOr(dv.avoid_same_artist_in_row, false);

  // ---- recommendations ----
  if (!r.recommendations || typeof r.recommendations !== "object")
    r.recommendations = {};
  const rec = r.recommendations;
  rec.enabled = toBoolOr(rec.enabled, false);
  if (!Array.isArray(rec.seed_genres)) rec.seed_genres = [];

  // ---- mix (allocation between discovery/reco/sources) ----
  if (!r.mix || typeof r.mix !== "object") r.mix = {};
  const mx = r.mix;
  mx.enabled = toBoolOr(mx.enabled, false);
  mx.discovery = Math.max(0, toNumOr(mx.discovery, 50));
  mx.recommendations = Math.max(0, toNumOr(mx.recommendations, 30));
  mx.sources = Math.max(0, toNumOr(mx.sources, 20));

  // ---- advanced ----
  if (!r.advanced || typeof r.advanced !== "object") r.advanced = {};
  const a = r.advanced;
  a.recommendation_attempts = toNumOr(a.recommendation_attempts, 10);

  return r;
}

function normalizeConfig(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  if (!Array.isArray(c.recipes)) c.recipes = [];
  c.recipes = c.recipes.map(normalizeRecipe);
  return c;
}

function getOptions() {
  // Prefer /data/options.json (supervisor), fallback env (local dev)
  const opts = readJsonSafe(OPTIONS_PATH, {});

  return {
    port: toNumOr(opts.port ?? process.env.PORT, 7790),
    base_url: toStrOr(
      opts.base_url ?? process.env.BASE_URL,
      "http://homeassistant.local:7790",
    ),
    api_token: toStrOr(opts.api_token ?? process.env.API_TOKEN, ""),

    spotify_client_id: toStrOr(
      opts.spotify_client_id ?? process.env.SPOTIFY_CLIENT_ID,
      "",
    ),
    spotify_client_secret: toStrOr(
      opts.spotify_client_secret ?? process.env.SPOTIFY_CLIENT_SECRET,
      "",
    ),
    spotify_redirect_uri: toStrOr(
      opts.spotify_redirect_uri ?? process.env.SPOTIFY_REDIRECT_URI,
      "",
    ),
    market: toStrOr(opts.market ?? process.env.SPOTIFY_MARKET, "CZ"),

    lastfm_api_key: toStrOr(
      opts.lastfm_api_key ?? process.env.LASTFM_API_KEY,
      "",
    ),

    tastedive_api_key: toStrOr(
      opts.tastedive_api_key ?? process.env.TASTEDIVE_API_KEY,
      "",
    ),

    audiodb_api_key: toStrOr(
      opts.audiodb_api_key ?? process.env.AUDIODB_API_KEY,
      "2",
    ),

    songkick_api_key: toStrOr(
      opts.songkick_api_key ?? process.env.SONGKICK_API_KEY,
      "",
    ),

    log_level: toStrOr(opts.log_level ?? process.env.LOG_LEVEL, "info"),
    genres_fetch_limit: toNumOr(
      opts.genres_fetch_limit ?? process.env.GENRES_FETCH_LIMIT,
      300,
    ),
    spotify_cache_ttl_minutes: toNumOr(
      opts.spotify_cache_ttl_minutes ?? process.env.SPOTIFY_CACHE_TTL_MINUTES,
      15,
    ),
    spotify_search_cache_ttl_days: toNumOr(
      opts.spotify_search_cache_ttl_days ??
        process.env.SPOTIFY_SEARCH_CACHE_TTL_DAYS,
      30,
    ),

    history: {
      scope: toStrOr(
        opts.history?.scope ?? process.env.HISTORY_SCOPE,
        "per_recipe",
      ),
      mode: toStrOr(
        opts.history?.mode ?? process.env.HISTORY_MODE,
        "rolling_days",
      ),
      rolling_days: toNumOr(
        opts.history?.rolling_days ?? process.env.HISTORY_ROLLING_DAYS,
        90,
      ),
      lifetime_cap: toNumOr(
        opts.history?.lifetime_cap ?? process.env.HISTORY_LIFETIME_CAP,
        20000,
      ),
    },
  };
}

function loadRecipesConfig() {
  const raw = readJsonSafe(CONFIG_PATH, { recipes: [] });
  return normalizeConfig(raw);
}

function saveRecipesConfig(cfg) {
  // Save as-is, but ensure structure is valid (so we don't write garbage)
  const normalized = normalizeConfig(cfg);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), "utf8");
}

module.exports = {
  DATA_DIR,
  CONFIG_PATH,
  getOptions,
  loadRecipesConfig,
  saveRecipesConfig,
};
