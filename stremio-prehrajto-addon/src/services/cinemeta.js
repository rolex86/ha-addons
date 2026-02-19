import fetch from "node-fetch";
import { cached } from "../utils/cache.js";

function cinemetaUrl(type, id) {
  return `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`;
}

async function getMeta(type, id) {
  const url = cinemetaUrl(type, id);
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Cinemeta ${res.status} for ${url}`);
  const data = await res.json();
  return data?.meta || null;
}

export const CINEMETA = {
  async movieByImdb(imdbId) {
    const key = `cinemeta:movie:${imdbId}`;
    return cached(key, async () => await getMeta("movie", imdbId));
  },

  async seriesByImdb(imdbId) {
    const key = `cinemeta:series:${imdbId}`;
    return cached(key, async () => await getMeta("series", imdbId));
  },
};
