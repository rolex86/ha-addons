// app/lib/lastfm.js
const https = require("https");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(code) {
  return code === 429 || (code >= 500 && code <= 599);
}

function getRetryAfterMs(res) {
  const ra = res?.headers?.["retry-after"];
  if (!ra) return null;
  const n = Number(ra);
  return Number.isFinite(n) ? n * 1000 : null;
}

function httpsGet(url, { timeoutMs = 12000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "spotify-playlists-ha-addon/1.0",
          Accept: "application/json",
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ res, data }));
      },
    );

    req.on("error", (e) => reject(e));

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Last.fm request timeout after ${timeoutMs}ms`));
    });
  });
}

async function lastfmGet(
  apiKey,
  method,
  params = {},
  { maxRetries = 5, baseDelayMs = 500, timeoutMs = 12000 } = {},
) {
  let attempt = 0;

  while (true) {
    const qs = new URLSearchParams({
      method: String(method),
      api_key: String(apiKey),
      format: "json",
      autocorrect: "1",
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ),
    });

    const url = `https://ws.audioscrobbler.com/2.0/?${qs.toString()}`;

    try {
      const { res, data } = await httpsGet(url, { timeoutMs });

      // Retry for 429 / 5xx
      if (isRetryableStatus(res.statusCode) && attempt < maxRetries) {
        const ra = getRetryAfterMs(res);
        const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
        await sleep(ra ?? backoff);
        attempt += 1;
        continue;
      }

      let j;
      try {
        j = JSON.parse(data);
      } catch {
        const err = new Error("Last.fm returned invalid JSON");
        err.status = res.statusCode;
        err.body = data;
        throw err;
      }

      if (res.statusCode >= 400 || j?.error) {
        const err = new Error(j?.message || "Last.fm error");
        err.status = j?.error || res.statusCode;
        err.body = j;
        throw err;
      }

      return j;
    } catch (e) {
      // Network/timeout -> retry
      if (attempt < maxRetries) {
        const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
        await sleep(backoff);
        attempt += 1;
        continue;
      }

      const err = new Error(`Last.fm request failed: ${e?.message || e}`);
      err.status = e?.status ?? null;
      err.body = e?.body ?? null;
      throw err;
    }
  }
}

async function getSimilarArtists(apiKey, artistName, limit = 50) {
  const j = await lastfmGet(apiKey, "artist.getsimilar", {
    artist: artistName,
    limit,
  });

  const arr = j?.similarartists?.artist || [];
  return arr
    .map((a) => ({
      name: a?.name,
      match: Number(a?.match || 0),
    }))
    .filter((x) => x.name);
}

module.exports = {
  getSimilarArtists,
};
