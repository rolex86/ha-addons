const fs = require("fs");
const path = require("path");
const SpotifyWebApi = require("spotify-web-api-node");
const { DATA_DIR, getOptions } = require("./config");

const TOKENS_PATH = path.join(DATA_DIR, "tokens.json");

function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_PATH)) return {};
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

function createClient() {
  const opts = getOptions();
  return new SpotifyWebApi({
    clientId: opts.spotify_client_id,
    clientSecret: opts.spotify_client_secret,
    redirectUri: opts.spotify_redirect_uri,
  });
}

async function ensureAccessToken(sp) {
  const tokens = loadTokens();
  if (tokens.refresh_token) sp.setRefreshToken(tokens.refresh_token);
  if (tokens.access_token) sp.setAccessToken(tokens.access_token);

  // Refresh every time (simple & safe)
  if (!tokens.refresh_token) {
    return { ok: false, reason: "missing_refresh_token" };
  }

  const refreshed = await sp.refreshAccessToken();
  const access_token = refreshed.body["access_token"];
  sp.setAccessToken(access_token);

  saveTokens({
    ...tokens,
    access_token,
    refreshed_at: Date.now(),
  });

  return { ok: true };
}

module.exports = {
  createClient,
  ensureAccessToken,
  loadTokens,
  saveTokens,
};
