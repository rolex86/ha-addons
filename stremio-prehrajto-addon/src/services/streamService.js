import { PREHRAJTO } from "./prehrajto.js";
import { TMDB } from "./tmdb.js";
import { scoreCandidate } from "../utils/scoring.js";
import { sxxexx } from "../utils/text.js";
import { parseId, ID } from "../ids.js";

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
  async streamsForId(stremioId, config) {
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

    // TMDB movie -> title year -> search -> resolve
    if (pid.kind === "tmdb_movie") {
      const movie = await TMDB.movie(pid.tmdbId);
      const query =
        `${movie.title} ${movie.release_date?.slice(0, 4) || ""}`.trim();
      return await this.streamsFromQuery(query, config, {
        wantedTitle: movie.title,
        wantedYear: movie.release_date?.slice(0, 4),
      });
    }

    // TMDB episode -> series name + SxxExx -> search -> resolve
    if (pid.kind === "tmdb_episode") {
      const series = await TMDB.series(pid.tmdbId);
      const marker = sxxexx(pid.season, pid.episode);
      const query = `${series.name} ${marker}`;
      return await this.streamsFromQuery(query, config, {
        wantedTitle: series.name,
        wantedSxxExx: marker,
      });
    }

    // For series main meta id -> no stream directly
    return { streams: [] };
  },

  async streamsFromQuery(query, config, wanted = {}) {
    const results = await PREHRAJTO.search(query, { limit: config.limit });

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
    const top = scored.slice(0, 3);
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
    }

    return { streams };
  },
};
