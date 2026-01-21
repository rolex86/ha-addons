// app/lib/spotify.js
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatSpotifyErr(e) {
  const status = e?.statusCode || e?.status || e?.response?.statusCode || null;
  const headers = e?.headers || e?.response?.headers || null;

  const retry_after =
    headers?.["retry-after"] ||
    headers?.["Retry-After"] ||
    e?.body?.error?.retry_after ||
    null;

  const message =
    e?.body?.error?.message ||
    e?.body?.error_description ||
    e?.message ||
    (typeof e === "string" ? e : null) ||
    null;

  return { status, retry_after, message, body: e?.body || null };
}

async function withTimeout(promise, ms, label = "operation") {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      const err = new Error(`${label} timeout after ${ms}ms`);
      err.status = null;
      reject(err);
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function spRetry(fn, { maxRetries = 6, baseDelayMs = 400 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (e) {
      const fe = formatSpotifyErr(e);
      const status = fe.status;

      const isRetryable =
        status === 429 || status === 502 || status === 503 || status === 504;

      if (!isRetryable || attempt >= maxRetries) {
        throw e;
      }

      const raMs = fe.retry_after ? Number(fe.retry_after) * 1000 : null;
      const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
      await sleep(raMs ?? backoff);

      attempt += 1;
    }
  }
}

async function ensureAccessToken(sp, { timeoutMs = 15000 } = {}) {
  const tokens = loadTokens();

  if (tokens.refresh_token) sp.setRefreshToken(tokens.refresh_token);
  if (tokens.access_token) sp.setAccessToken(tokens.access_token);

  if (!tokens.refresh_token) {
    return { ok: false, reason: "missing_refresh_token" };
  }

  try {
    const refreshed = await spRetry(
      () =>
        withTimeout(sp.refreshAccessToken(), timeoutMs, "refreshAccessToken"),
      { maxRetries: 6, baseDelayMs: 500 },
    );

    const access_token = refreshed?.body?.["access_token"];
    if (!access_token) {
      return {
        ok: false,
        reason: "refresh_missing_access_token",
        error: { status: null, message: "refresh returned no access_token" },
      };
    }

    sp.setAccessToken(access_token);

    saveTokens({
      ...tokens,
      access_token,
      refreshed_at: Date.now(),
    });

    return { ok: true };
  } catch (e) {
    const fe = formatSpotifyErr(e);

    // typicky: invalid_grant / revoked refresh token / app config mismatch
    const reason =
      fe.status === 400 || fe.status === 401
        ? "refresh_failed_invalid_or_expired"
        : "refresh_failed";

    return { ok: false, reason, error: fe };
  }
}

module.exports = {
  createClient,
  ensureAccessToken,
  loadTokens,
  saveTokens,
};
