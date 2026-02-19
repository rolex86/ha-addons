import { TMDB, tmdbPoster } from "./tmdb.js";
import { ID } from "../ids.js";
import { PREHRAJTO } from "./prehrajto.js";

function toMetaPreview(type, item) {
  if (type === "movie") {
    return {
      id: ID.tmdbMovie(item.id),
      type: "movie",
      name: item.title,
      poster: tmdbPoster(item.poster_path),
      releaseInfo: item.release_date?.slice(0, 4) || undefined,
    };
  }
  return {
    id: ID.tmdbSeries(item.id),
    type: "series",
    name: item.name,
    poster: tmdbPoster(item.poster_path),
    releaseInfo: item.first_air_date?.slice(0, 4) || undefined,
  };
}

export const CatalogService = {
  async catalog(catalogId, type, extra, config) {
    // Direct search catalog (prehraj.to)
    if (catalogId === "pt_search") {
      const search = (extra?.search || "").toString().trim();
      if (!search) return { metas: [] };

      const results = await PREHRAJTO.search(search, { limit: config.limit });
      return {
        metas: results.map((r) => ({
          id: ID.ptUrl(r.url),
          type: "movie", // Stremio requires a type; treat as movie-like playable items
          name: r.title,
          poster: null,
        })),
      };
    }

    // TMDB catalogs
    const skip = parseInt(extra?.skip || "0", 10) || 0;
    const page = Math.floor(skip / 20) + 1;

    if (catalogId.endsWith("_popular")) {
      const mode = "popular";
      const data = await TMDB.list(type, mode, { page });
      return { metas: (data.results || []).map((x) => toMetaPreview(type, x)) };
    }

    if (catalogId.endsWith("_trending")) {
      const mode = "trending";
      const data = await TMDB.list(type, mode, { page });
      return { metas: (data.results || []).map((x) => toMetaPreview(type, x)) };
    }

    if (catalogId.endsWith("_by_genre")) {
      const genre = extra?.genre;
      const data = await TMDB.list(type, "discover", { page, genre });
      return { metas: (data.results || []).map((x) => toMetaPreview(type, x)) };
    }

    if (catalogId.endsWith("_by_year")) {
      const year = extra?.year;
      const data = await TMDB.list(type, "discover", { page, year });
      return { metas: (data.results || []).map((x) => toMetaPreview(type, x)) };
    }

    return { metas: [] };
  },
};
