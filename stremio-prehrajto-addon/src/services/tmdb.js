import { ENV } from "../env.js";
import { cached } from "../utils/cache.js";
import fetch from "node-fetch";
import { elapsedMs, errorMeta, log, sanitizeUrl } from "../utils/log.js";

function tmdbUrl(path, params = {}) {
  const u = new URL(`https://api.themoviedb.org/3${path}`);
  u.searchParams.set("api_key", ENV.TMDB_API_KEY);
  u.searchParams.set("language", ENV.TMDB_LANGUAGE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "")
      u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function getJson(url) {
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    log.warn("tmdb:request failed", {
      url: sanitizeUrl(url),
      error: errorMeta(e),
    });
    throw e;
  }
  if (!res.ok) {
    log.warn("tmdb:non-200", {
      url: sanitizeUrl(url),
      status: res.status,
      ms: elapsedMs(startedAt),
    });
    throw new Error(`TMDB ${res.status} for ${url}`);
  }
  const data = await res.json();
  log.debug("tmdb:ok", {
    url: sanitizeUrl(url),
    status: res.status,
    ms: elapsedMs(startedAt),
  });
  return data;
}

export const TMDB = {
  async movie(tmdbId) {
    const key = `tmdb:movie:${tmdbId}`;
    log.debug("tmdb:movie", { tmdbId });
    return cached(key, async () => await getJson(tmdbUrl(`/movie/${tmdbId}`)));
  },

  async series(tmdbId) {
    const key = `tmdb:tv:${tmdbId}`;
    log.debug("tmdb:series", { tmdbId });
    return cached(key, async () => await getJson(tmdbUrl(`/tv/${tmdbId}`)));
  },

  async findByImdb(imdbId) {
    if (!ENV.TMDB_API_KEY) throw new Error("Missing TMDB_API_KEY");
    const key = `tmdb:find:imdb:${imdbId}`;
    log.debug("tmdb:findByImdb", { imdbId });
    return cached(key, async () => {
      const data = await getJson(
        tmdbUrl(`/find/${imdbId}`, { external_source: "imdb_id" }),
      );
      return {
        movie: (data.movie_results || [])[0] || null,
        series: (data.tv_results || [])[0] || null,
      };
    });
  },
};
