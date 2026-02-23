export function normalizeTitle(s) {
  if (!s) return "";
  return s
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function sxxexx(season, episode) {
  return `S${pad2(season)}E${pad2(episode)}`;
}

function addEpisodePair(map, seasonRaw, episodeRaw) {
  const season = parseInt(seasonRaw, 10);
  const episode = parseInt(episodeRaw, 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return;
  if (season < 0 || season > 99 || episode < 0 || episode > 999) return;
  map.set(`${season}:${episode}`, { season, episode });
}

export function extractSeasonEpisodePairs(text) {
  const src = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const pairs = new Map();
  let m;

  const sxe = /\bs(?:eason)?\s*0?(\d{1,2})\s*[-._ ]*e(?:p(?:isode|izoda)?)?\s*0?(\d{1,3})\b/gi;
  while ((m = sxe.exec(src))) addEpisodePair(pairs, m[1], m[2]);

  const xPattern = /\b(\d{1,2})\s*x\s*0?(\d{1,3})\b/gi;
  while ((m = xPattern.exec(src))) addEpisodePair(pairs, m[1], m[2]);

  const seasonEpisodeWords =
    /\b(?:sezona|season|serie)\s*0?(\d{1,2})\D{0,24}(?:epizoda|episode|dil|ep)\s*0?(\d{1,3})\b/gi;
  while ((m = seasonEpisodeWords.exec(src))) addEpisodePair(pairs, m[1], m[2]);

  const episodeSeasonWords =
    /\b(?:epizoda|episode|dil|ep)\s*0?(\d{1,3})\D{0,24}(?:sezona|season|serie)\s*0?(\d{1,2})\b/gi;
  while ((m = episodeSeasonWords.exec(src))) addEpisodePair(pairs, m[2], m[1]);

  return Array.from(pairs.values());
}

export function matchSeasonEpisode(text, season, episode) {
  const wantedSeason = parseInt(season, 10);
  const wantedEpisode = parseInt(episode, 10);
  if (!Number.isFinite(wantedSeason) || !Number.isFinite(wantedEpisode)) {
    return {
      isMatch: false,
      hasEpisodeMarkers: false,
      pairs: [],
    };
  }

  const pairs = extractSeasonEpisodePairs(text);
  if (pairs.length === 0) {
    return {
      isMatch: false,
      hasEpisodeMarkers: false,
      pairs,
    };
  }

  const isMatch = pairs.some(
    (p) => p.season === wantedSeason && p.episode === wantedEpisode,
  );
  return {
    isMatch,
    hasEpisodeMarkers: true,
    pairs,
  };
}

export function parseSxxExx(value) {
  const m = /\bs0?(\d{1,2})e0?(\d{1,3})\b/i.exec(String(value || ""));
  if (!m) return null;
  const season = parseInt(m[1], 10);
  const episode = parseInt(m[2], 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
  return { season, episode };
}

export function episodeQueryMarkers(season, episode) {
  const s = parseInt(season, 10);
  const e = parseInt(episode, 10);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return [];

  const out = [
    sxxexx(s, e),
    `S${s}E${e}`,
    `${s}x${pad2(e)}`,
    `${s}x${e}`,
    `${pad2(s)}x${pad2(e)}`,
    `season ${s} episode ${e}`,
    `sezona ${s} epizoda ${e}`,
  ];

  const uniq = [];
  const seen = new Set();
  for (const marker of out) {
    const key = marker.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(marker);
  }
  return uniq;
}

export function safeB64UrlEncode(str) {
  const b64 = Buffer.from(str, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function safeB64UrlDecode(b64url) {
  const b64 =
    b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((b64url.length + 3) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}
