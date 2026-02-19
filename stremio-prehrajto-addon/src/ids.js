import { safeB64UrlDecode, safeB64UrlEncode } from "./utils/text.js";

export const ID = {
  // TMDB
  tmdbMovie: (tmdbId) => `tmdb:movie:${tmdbId}`,
  tmdbSeries: (tmdbId) => `tmdb:series:${tmdbId}`,
  tmdbEpisode: (tmdbId, season, episode) =>
    `tmdb:series:${tmdbId}:s${String(season).padStart(2, "0")}e${String(episode).padStart(2, "0")}`,

  // Prehraj.to direct
  ptUrl: (url) => `pt:url:${safeB64UrlEncode(url)}`,
  ptQuery: (query) => `pt:query:${safeB64UrlEncode(query)}`,
};

export function parseId(id) {
  const parts = (id || "").split(":");
  if (parts.length < 3) return { kind: "unknown", raw: id };

  if (parts[0] === "tmdb" && (parts[1] === "movie" || parts[1] === "series")) {
    const tmdbId = parts[2];
    if (parts[1] === "movie") return { kind: "tmdb_movie", tmdbId };
    if (parts[1] === "series") {
      // maybe episode suffix
      if (parts.length === 4) {
        const m = /^s(\d{2})e(\d{2})$/i.exec(parts[3]);
        if (m)
          return {
            kind: "tmdb_episode",
            tmdbId,
            season: parseInt(m[1], 10),
            episode: parseInt(m[2], 10),
          };
      }
      return { kind: "tmdb_series", tmdbId };
    }
  }

  if (parts[0] === "pt" && (parts[1] === "url" || parts[1] === "query")) {
    const payload = parts.slice(2).join(":");
    const decoded = safeB64UrlDecode(payload);
    return { kind: parts[1] === "url" ? "pt_url" : "pt_query", value: decoded };
  }

  return { kind: "unknown", raw: id };
}
