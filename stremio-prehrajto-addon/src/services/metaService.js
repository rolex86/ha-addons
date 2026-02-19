import { TMDB, tmdbPoster } from "./tmdb.js";
import { ID, parseId } from "../ids.js";
import { sxxexx } from "../utils/text.js";

async function loadSeasonDetailsBatched(tmdbId, seasons, batchSize = 4) {
  const out = [];

  for (let i = 0; i < seasons.length; i += batchSize) {
    const batch = seasons.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (season) => {
        try {
          const data = await TMDB.season(tmdbId, season.season_number);
          return { seasonNumber: season.season_number, episodes: data.episodes || [] };
        } catch {
          return { seasonNumber: season.season_number, episodes: [] };
        }
      }),
    );
    out.push(...results);
  }

  return out;
}

export const MetaService = {
  async metaForId(type, id) {
    const pid = parseId(id);

    if (pid.kind === "tmdb_movie") {
      const m = await TMDB.movie(pid.tmdbId);
      return {
        meta: {
          id: ID.tmdbMovie(pid.tmdbId),
          type: "movie",
          name: m.title,
          poster: tmdbPoster(m.poster_path),
          background: tmdbPoster(m.backdrop_path),
          description: m.overview,
          releaseInfo: m.release_date?.slice(0, 4) || undefined,
          genres: (m.genres || []).map((g) => g.name),
        },
      };
    }

    if (pid.kind === "tmdb_series") {
      const s = await TMDB.series(pid.tmdbId);

      // Build videos list from seasons/episodes.
      // TMDB series endpoint includes seasons, but not all episodes. We fetch each season (up to a reasonable limit).
      const seasons = (s.seasons || [])
        .filter((x) => x.season_number > 0)
        .slice(0, 30);
      const seasonDataList = await loadSeasonDetailsBatched(pid.tmdbId, seasons);

      const videos = [];
      for (const seasonData of seasonDataList) {
        for (const ep of seasonData.episodes) {
          videos.push({
            id: ID.tmdbEpisode(
              pid.tmdbId,
              seasonData.seasonNumber,
              ep.episode_number,
            ),
            title:
              `${sxxexx(seasonData.seasonNumber, ep.episode_number)} • ${ep.name || ""}`.trim(),
            season: seasonData.seasonNumber,
            episode: ep.episode_number,
            released: ep.air_date || undefined,
            thumbnail: tmdbPoster(ep.still_path) || tmdbPoster(s.poster_path),
          });
        }
      }

      return {
        meta: {
          id: ID.tmdbSeries(pid.tmdbId),
          type: "series",
          name: s.name,
          poster: tmdbPoster(s.poster_path),
          background: tmdbPoster(s.backdrop_path),
          description: s.overview,
          releaseInfo: s.first_air_date?.slice(0, 4) || undefined,
          genres: (s.genres || []).map((g) => g.name),
          videos,
        },
      };
    }

    // For direct pt:* ids, we don't have detailed meta (can be improved by scraping).
    return { meta: null };
  },
};
