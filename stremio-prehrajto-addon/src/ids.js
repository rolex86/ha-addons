import { safeB64UrlDecode, safeB64UrlEncode } from "./utils/text.js";

export const ID = {
  // Prehraj.to direct
  ptUrl: (url) => `pt:url:${safeB64UrlEncode(url)}`,
  ptQuery: (query) => `pt:query:${safeB64UrlEncode(query)}`,
};

export function parseId(id) {
  const raw = (id || "").toString().trim();

  // Cinemeta-like IMDB title id: tt1234567
  if (/^tt\d+$/i.test(raw)) {
    return { kind: "imdb_title", imdbId: raw.toLowerCase() };
  }

  // Cinemeta-like IMDB episode id: tt1234567:1:2
  const imdbEpisode = /^(tt\d+):(\d+):(\d+)$/i.exec(raw);
  if (imdbEpisode) {
    return {
      kind: "imdb_episode",
      imdbId: imdbEpisode[1].toLowerCase(),
      season: parseInt(imdbEpisode[2], 10),
      episode: parseInt(imdbEpisode[3], 10),
    };
  }

  const parts = raw.split(":");
  if (parts.length < 3) return { kind: "unknown", raw };

  if (parts[0] === "pt" && (parts[1] === "url" || parts[1] === "query")) {
    const payload = parts.slice(2).join(":");
    const decoded = safeB64UrlDecode(payload);
    return { kind: parts[1] === "url" ? "pt_url" : "pt_query", value: decoded };
  }

  return { kind: "unknown", raw };
}
