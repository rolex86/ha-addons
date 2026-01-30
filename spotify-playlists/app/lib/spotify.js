// app/lib/spotify.js
const fs = require("fs");
const path = require("path");
const SpotifyWebApi = require("spotify-web-api-node");
const { DATA_DIR, getOptions } = require("./config");

const TOKENS_PATH = path.join(DATA_DIR, "tokens.json");

function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) || {};

    // New format (our app)
    if (raw.refresh_token || raw.access_token) return raw;

    // Legacy format (spotify-web-api-node dump)
    const c = raw?._credentials;
    if (c && (c.refreshToken || c.accessToken)) {
      return {
        refresh_token: c.refreshToken || "",
        access_token: c.accessToken || "",
        refreshed_at: raw.refreshed_at || null,
      };
    }

    return raw;
  } catch {
    return {};
  }
}

function saveTokens(tokens) {
  const t = tokens || {};
  const out = {
    refresh_token: t.refresh_token || t?._credentials?.refreshToken || "",
    access_token: t.access_token || t?._credentials?.accessToken || "",
    refreshed_at: t.refreshed_at || Date.now(),
  };

  fs.writeFileSync(TOKENS_PATH, JSON.stringify(out, null, 2), "utf8");
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

const LOG_RANK = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
function normLevel(x) {
  const s = String(x || "info").toLowerCase();
  return LOG_RANK[s] ? s : "info";
}
function rank(level) {
  return LOG_RANK[normLevel(level)] ?? LOG_RANK.info;
}
function shouldLog(level) {
  const cur = normLevel(process.env.LOG_LEVEL || "info");
  return rank(level) >= rank(cur);
}
function spLog(level, msg) {
  if (!shouldLog(level)) return;
  console.log(`[spotify][${normLevel(level)}] ${msg}`);
}

async function spRetry(
  fn,
  { maxRetries = 6, baseDelayMs = 400, label = "" } = {},
) {
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
        spLog(
          "debug",
          `FAIL ${label ? `[${label}] ` : ""}status=${status ?? "?"} attempt=${attempt}/${maxRetries} retryable=${isRetryable ? 1 : 0}`,
        );
        throw e;
      }

      let raMs = null;
      if (fe.retry_after != null) {
        const n = Number(fe.retry_after);
        if (Number.isFinite(n)) {
          // heuristika: > 1000 už bude nejspíš ms
          raMs = n > 1000 ? n : n * 1000;
        }
      }

      const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
      const waitMs = raMs ?? backoff;

      if (status === 429) {
        spLog(
          "trace",
          `429 rate-limit ${label ? `[${label}] ` : ""}attempt=${attempt + 1}/${maxRetries} retryAfter=${Math.round(waitMs / 1000)}s (${waitMs}ms)`,
        );
      } else {
        spLog(
          "debug",
          `HTTP ${status} retry ${label ? `[${label}] ` : ""}attempt=${attempt + 1}/${maxRetries} waitMs=${waitMs}`,
        );
      }

      await sleep(waitMs);
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
