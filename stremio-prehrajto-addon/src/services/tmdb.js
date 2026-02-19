import { ENV } from "../env.js";
import { cached } from "../utils/cache.js";
import fetch from "node-fetch";

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
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${url}`);
  return await res.json();
}

export const TMDB = {
  async genres(type) {
    const key = `tmdb:genres:${type}`;
    return cached(key, async () => {
      const path = type === "movie" ? "/genre/movie/list" : "/genre/tv/list";
      const data = await getJson(tmdbUrl(path));
      return data.genres || [];
    });
  },

  async list(type, mode, { page = 1, genre, year } = {}) {
    if (!ENV.TMDB_API_KEY) throw new Error("Missing TMDB_API_KEY");
    const key = `tmdb:list:${type}:${mode}:${page}:${genre || ""}:${year || ""}`;
    return cached(key, async () => {
      if (mode === "popular") {
        const path = type === "movie" ? "/movie/popular" : "/tv/popular";
        return await getJson(tmdbUrl(path, { page }));
      }
      if (mode === "trending") {
        // weekly trending
        const path =
          type === "movie" ? "/trending/movie/week" : "/trending/tv/week";
        return await getJson(tmdbUrl(path, { page }));
      }
      if (mode === "discover") {
        const path = type === "movie" ? "/discover/movie" : "/discover/tv";
        const params = { page };
        if (genre) params.with_genres = genre;
        if (year) {
          if (type === "movie") params.primary_release_year = year;
          else params.first_air_date_year = year;
        }
        return await getJson(tmdbUrl(path, params));
      }
      throw new Error(`Unknown TMDB mode: ${mode}`);
    });
  },

  async movie(tmdbId) {
    const key = `tmdb:movie:${tmdbId}`;
    return cached(key, async () => await getJson(tmdbUrl(`/movie/${tmdbId}`)));
  },

  async series(tmdbId) {
    const key = `tmdb:tv:${tmdbId}`;
    return cached(key, async () => await getJson(tmdbUrl(`/tv/${tmdbId}`)));
  },

  async season(tmdbId, seasonNumber) {
    const key = `tmdb:tv:${tmdbId}:season:${seasonNumber}`;
    return cached(
      key,
      async () =>
        await getJson(tmdbUrl(`/tv/${tmdbId}/season/${seasonNumber}`)),
    );
  },
};

export function tmdbPoster(path) {
  if (!path) return null;
  return `${ENV.TMDB_IMAGE_BASE}${path}`;
}
