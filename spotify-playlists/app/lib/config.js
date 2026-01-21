const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/data";
const OPTIONS_PATH = path.join(DATA_DIR, "options.json"); // HA Supervisor writes this
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function getOptions() {
  // Prefer /data/options.json (supervisor), fallback env
  const opts = readJsonSafe(OPTIONS_PATH, {});
  return {
    port: Number(opts.port ?? process.env.PORT ?? 7790),
    base_url: String(
      opts.base_url ??
        process.env.BASE_URL ??
        "http://homeassistant.local:7790",
    ),
    api_token: String(opts.api_token ?? process.env.API_TOKEN ?? ""),

    spotify_client_id: String(
      opts.spotify_client_id ?? process.env.SPOTIFY_CLIENT_ID ?? "",
    ),
    spotify_client_secret: String(
      opts.spotify_client_secret ?? process.env.SPOTIFY_CLIENT_SECRET ?? "",
    ),
    spotify_redirect_uri: String(
      opts.spotify_redirect_uri ?? process.env.SPOTIFY_REDIRECT_URI ?? "",
    ),
    market: String(opts.market ?? process.env.SPOTIFY_MARKET ?? "CZ"),

    // NEW:
    lastfm_api_key: String(
      opts.lastfm_api_key ?? process.env.LASTFM_API_KEY ?? "",
    ),

    log_level: String(opts.log_level ?? process.env.LOG_LEVEL ?? "info"),
    history: {
      scope: String(opts.history?.scope ?? "per_recipe"),
      mode: String(opts.history?.mode ?? "rolling_days"),
      rolling_days: Number(opts.history?.rolling_days ?? 90),
      lifetime_cap: Number(opts.history?.lifetime_cap ?? 20000),
    },
  };
}

function loadRecipesConfig() {
  const cfg = readJsonSafe(CONFIG_PATH, { recipes: [] });
  if (!cfg.recipes) cfg.recipes = [];
  return cfg;
}

function saveRecipesConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

module.exports = {
  DATA_DIR,
  CONFIG_PATH,
  getOptions,
  loadRecipesConfig,
  saveRecipesConfig,
};
