import { PREHRAJTO } from "./prehrajto.js";
import { TMDB } from "./tmdb.js";
import { CINEMETA } from "./cinemeta.js";
import { scoreCandidate } from "../utils/scoring.js";
import { sxxexx } from "../utils/text.js";
import { parseId } from "../ids.js";

function buildStreamEntry({ url, title, subtitles = [] }) {
  const st = {
    title,
    url,
  };

  if (subtitles.length) {
    st.subtitles = subtitles.map((s) => ({
      url: s.url,
      lang: s.lang || "und",
    }));
  }

  return st;
}

export const StreamService = {
  async streamsForId(type, stremioId, config) {
    const pid = parseId(stremioId);

    // Direct prehraj URL
    if (pid.kind === "pt_url") {
      const resolved = await PREHRAJTO.resolveStream(pid.value, config);
      if (!resolved) return { streams: [] };
      return {
        streams: [
          buildStreamEntry({
            url: resolved.url,
            title: "Prehraj.to",
            subtitles: resolved.subtitles,
          }),
        ],
      };
    }

    // Query -> search -> best match -> resolve
    if (pid.kind === "pt_query") {
      return await this.streamsFromQuery(pid.value, config);
    }

    // Cinemeta IMDB title id -> map to TMDB first
    if (pid.kind === "imdb_title") {
      if (type === "movie") {
        try {
          const found = await TMDB.findByImdb(pid.imdbId);
          if (found.movie?.id) {
            const movie = await TMDB.movie(found.movie.id);
            const query =
              `${movie.title} ${movie.release_date?.slice(0, 4) || ""}`.trim();
            return await this.streamsFromQuery(query, config, {
              wantedTitle: movie.title,
              wantedYear: movie.release_date?.slice(0, 4),
            });
          }
        } catch {
          // fallback to Cinemeta below
        }

        const cmMovie = await CINEMETA.movieByImdb(pid.imdbId);
        if (!cmMovie?.name) return { streams: [] };
        const year = /\b(19|20)\d{2}\b/.exec(cmMovie.releaseInfo || "")?.[0];
        const query = `${cmMovie.name} ${year || ""}`.trim();
        return await this.streamsFromQuery(query, config, {
          wantedTitle: cmMovie.name,
          wantedYear: year,
        });
      }

      if (type === "series") {
        try {
          const found = await TMDB.findByImdb(pid.imdbId);
          if (found.series?.id) {
            const series = await TMDB.series(found.series.id);
            return await this.streamsFromQuery(series.name, config, {
              wantedTitle: series.name,
            });
          }
        } catch {
          // fallback to Cinemeta below
        }

        const cmSeries = await CINEMETA.seriesByImdb(pid.imdbId);
        if (!cmSeries?.name) return { streams: [] };
        return await this.streamsFromQuery(cmSeries.name, config, {
          wantedTitle: cmSeries.name,
        });
      }

      return { streams: [] };
    }

    // Cinemeta IMDB episode id: tt1234567:1:2
    if (pid.kind === "imdb_episode") {
      const marker = sxxexx(pid.season, pid.episode);

      try {
        const found = await TMDB.findByImdb(pid.imdbId);
        if (found.series?.id) {
          const series = await TMDB.series(found.series.id);
          const query = `${series.name} ${marker}`;
          return await this.streamsFromQuery(query, config, {
            wantedTitle: series.name,
            wantedSxxExx: marker,
          });
        }
      } catch {
        // fallback to Cinemeta below
      }

      const cmSeries = await CINEMETA.seriesByImdb(pid.imdbId);
      if (!cmSeries?.name) return { streams: [] };
      const query = `${cmSeries.name} ${marker}`;
      return await this.streamsFromQuery(query, config, {
        wantedTitle: cmSeries.name,
        wantedSxxExx: marker,
      });
    }

    // For series main meta id -> no stream directly
    return { streams: [] };
  },

  async streamsFromQuery(query, config, wanted = {}) {
    const searchLimit = Math.min(Math.max(config.limit || 10, 1), 10);
    const results = await PREHRAJTO.search(query, { limit: searchLimit });

    if (!results.length) return { streams: [] };

    // score candidates
    const scored = results
      .map((r) => ({
        r,
        s: scoreCandidate(
          {
            wantedTitle: wanted.wantedTitle || query,
            wantedYear: wanted.wantedYear,
            wantedSxxExx: wanted.wantedSxxExx,
          },
          r,
        ),
      }))
      .sort((a, b) => b.s - a.s);

    // try top N resolves
    const top = scored.slice(0, 2);
    const streams = [];

    for (const item of top) {
      const resolved = await PREHRAJTO.resolveStream(item.r.url, config);
      if (!resolved) continue;

      streams.push(
        buildStreamEntry({
          url: resolved.url,
          title: `Prehraj.to • ${item.r.title}`,
          subtitles: resolved.subtitles,
        }),
      );

      if (streams.length >= 2) break;
    }

    return { streams };
  },
};
