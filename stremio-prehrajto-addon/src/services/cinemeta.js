import fetch from "node-fetch";
import { cached } from "../utils/cache.js";
import { elapsedMs, errorMeta, log, sanitizeUrl } from "../utils/log.js";

function cinemetaUrl(type, id) {
  return `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`;
}

async function getMeta(type, id) {
  const url = cinemetaUrl(type, id);
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145 Safari/537.36",
        Accept: "application/json",
      },
    });
  } catch (e) {
    log.warn("cinemeta:request failed", {
      url: sanitizeUrl(url),
      error: errorMeta(e),
    });
    throw e;
  }
  if (!res.ok) {
    log.warn("cinemeta:non-200", {
      url: sanitizeUrl(url),
      status: res.status,
      ms: elapsedMs(startedAt),
    });
    throw new Error(`Cinemeta ${res.status} for ${url}`);
  }
  const data = await res.json();
  log.debug("cinemeta:ok", {
    url: sanitizeUrl(url),
    status: res.status,
    ms: elapsedMs(startedAt),
  });
  return data?.meta || null;
}

export const CINEMETA = {
  async movieByImdb(imdbId) {
    const key = `cinemeta:movie:${imdbId}`;
    log.debug("cinemeta:movieByImdb", { imdbId });
    return cached(key, async () => await getMeta("movie", imdbId));
  },

  async seriesByImdb(imdbId) {
    const key = `cinemeta:series:${imdbId}`;
    log.debug("cinemeta:seriesByImdb", { imdbId });
    return cached(key, async () => await getMeta("series", imdbId));
  },
};
