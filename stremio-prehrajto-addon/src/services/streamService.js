import { PREHRAJTO } from "./prehrajto.js";
import { TMDB } from "./tmdb.js";
import { CINEMETA } from "./cinemeta.js";
import { scoreCandidate } from "../utils/scoring.js";
import {
  episodeQueryMarkers,
  matchSeasonEpisode,
  parseSxxExx,
  sxxexx,
} from "../utils/text.js";
import { parseId } from "../ids.js";
import { cache } from "../utils/cache.js";
import { elapsedMs, errorMeta, log, sanitizeUrl, summarizeId } from "../utils/log.js";

const STREAM_INFLIGHT = new Map();
const NO_STREAMS_TTL_MS = 180_000;
const MAX_STREAMS = 15;
const MAX_QUERY_VARIANTS = 6;
const MAX_CANDIDATES_TO_RESOLVE = 24;
const RESOLVE_FACTOR = 2;
const RESOLVE_CONCURRENCY = 2;
const RESOLVE_BATCH_SIZE = 4;
const SEARCH_PER_QUERY_MIN = 6;
const SEARCH_PER_QUERY_MAX = 30;
const SEARCH_PER_STREAM_FACTOR = 3;
const STREAM_REQUEST_BUDGET_MS = 12_000;

function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normalizedTitleVariant(s) {
  return normalizeSpaces(
    String(s || "")
      .replace(/[()[\]{}.,:;!?/\\|_+=*&^%$#@~`"-]+/g, " ")
      .replace(/\s+/g, " "),
  );
}

function addQuery(set, value) {
  const raw = normalizeSpaces(value);
  if (!raw) return;
  set.add(raw);

  const normalized = normalizedTitleVariant(raw);
  if (normalized && normalized.toLowerCase() !== raw.toLowerCase()) {
    set.add(normalized);
  }
}

function addNameQueries(set, name, year) {
  const cleanName = normalizeSpaces(name);
  if (!cleanName) return;

  addQuery(set, cleanName);
  if (year) addQuery(set, `${cleanName} ${year}`);
}

function uniqueNonEmpty(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const v = normalizeSpaces(value);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function parseWantedEpisode(wanted = {}) {
  const season = parseInt(wanted?.wantedSeason, 10);
  const episode = parseInt(wanted?.wantedEpisode, 10);
  if (Number.isFinite(season) && Number.isFinite(episode)) {
    return { season, episode };
  }
  return parseSxxExx(wanted?.wantedSxxExx || "");
}

function episodeMatchForCandidate(candidate, wantedEpisode) {
  if (!wantedEpisode) {
    return {
      isMatch: false,
      hasEpisodeMarkers: false,
      pairs: [],
    };
  }
  return matchSeasonEpisode(
    `${candidate?.title || ""} ${candidate?.url || ""}`,
    wantedEpisode.season,
    wantedEpisode.episode,
  );
}

async function buildSearchQueryPlan(queries, wanted = {}) {
  const baseQueries = uniqueNonEmpty(queries).slice(0, MAX_QUERY_VARIANTS);
  if (baseQueries.length === 0) return [];

  const out = [];
  const seen = new Set();
  const add = (value) => {
    const v = normalizeSpaces(value);
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };

  // Use only one primary seed to avoid adding latency before real search.
  const seed = uniqueNonEmpty([wanted?.wantedTitle, baseQueries[0]])[0];
  if (seed) {
    add(seed);
    if (out.length < MAX_QUERY_VARIANTS) {
      try {
        const suggested = await PREHRAJTO.suggest(seed, { limit: 4 });
        for (const s of suggested) {
          add(s);
          if (out.length >= MAX_QUERY_VARIANTS) break;
        }
      } catch {
        // ignore suggest failures, base queries are sufficient fallback
      }
    }

    if (out.length >= MAX_QUERY_VARIANTS) return out.slice(0, MAX_QUERY_VARIANTS);
  }

  for (const q of baseQueries) {
    add(q);
    if (out.length >= MAX_QUERY_VARIANTS) break;
  }

  return out.slice(0, MAX_QUERY_VARIANTS);
}

function formatBytes(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return "";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = b;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[idx]}`;
}

function parseQualityFromTitle(title) {
  const text = String(title || "");
  if (!text) return "";

  let resolution = "";
  if (/\b(?:2160p|4k|uhd)\b/i.test(text)) resolution = "2160p";
  else if (/\b1440p\b/i.test(text)) resolution = "1440p";
  else if (/\b1080p\b/i.test(text)) resolution = "1080p";
  else if (/\b720p\b/i.test(text)) resolution = "720p";
  else if (/\b576p\b/i.test(text)) resolution = "576p";
  else if (/\b480p\b/i.test(text)) resolution = "480p";
  else if (/\b360p\b/i.test(text)) resolution = "360p";

  let source = "";
  if (/\bweb[ .-]?dl\b/i.test(text)) source = "WEB-DL";
  else if (/\bweb[ .-]?rip\b/i.test(text)) source = "WEBRip";
  else if (/\bblu[ .-]?ray\b/i.test(text)) source = "BluRay";
  else if (/\bbrrip\b/i.test(text)) source = "BRRip";
  else if (/\bhd[ .-]?tv\b/i.test(text)) source = "HDTV";
  else if (/\bdvd[ .-]?rip\b/i.test(text)) source = "DVDRip";
  else if (/\bhdrip\b/i.test(text)) source = "HDRip";

  let codec = "";
  if (/\b(?:x265|h[ .-]?265|hevc)\b/i.test(text)) codec = "H.265";
  else if (/\b(?:x264|h[ .-]?264|avc)\b/i.test(text)) codec = "H.264";

  let hdr = "";
  if (/\bdolby[ .-]?vision\b/i.test(text)) hdr = "Dolby Vision";
  else if (/\bhdr10\+\b/i.test(text)) hdr = "HDR10+";
  else if (/\bhdr10\b/i.test(text)) hdr = "HDR10";
  else if (/\bhdr\b/i.test(text)) hdr = "HDR";

  return [resolution, source, codec, hdr].filter(Boolean).join(" • ");
}

function parseDisplayNameFromTitle(sourceTitle, fallbackTitle = "") {
  const raw = normalizeSpaces(sourceTitle);
  const fallback = normalizeSpaces(fallbackTitle);
  if (!raw) return fallback;

  const cleaned = normalizeSpaces(
    raw
      .replace(/\b\d+(?:[.,]\d+)?\s*(?:tb|gb|mb|kb|b)\b/gi, " ")
      .replace(
        /\b(?:2160p|1440p|1080p|720p|576p|480p|360p|4k|uhd|web[ .-]?dl|web[ .-]?rip|bluray|blu[ .-]?ray|brrip|hdtv|dvdrip|hdrip|x264|x265|h[ .-]?264|h[ .-]?265|hevc|avc|hdr10\+?|hdr|dolby[ .-]?vision|dv)\b/gi,
        " ",
      )
      .replace(/[._]+/g, " ")
      .replace(/\s{2,}/g, " "),
  );

  if (cleaned.length >= 3) return cleaned;
  return raw || fallback;
}

function buildDisplayTitle({
  sourceTitle,
  sourceSizeText = "",
  parsedSizeBytes,
  fallbackTitle = "",
}) {
  const name = parseDisplayNameFromTitle(sourceTitle, fallbackTitle);
  const quality = parseQualityFromTitle(sourceTitle);
  const sizeText = normalizeSpaces(sourceSizeText) || formatBytes(parsedSizeBytes);
  const lines = [name || normalizeSpaces(sourceTitle) || "Prehraj.to"];

  if (quality) lines.push(`Kvalita: ${quality}`);
  if (sizeText) lines.push(`Velikost: ${sizeText}`);

  return lines.join("\n");
}

function parseSizeFromTitleBytes(title) {
  const text = String(title || "");
  const m = /(\d+(?:[.,]\d+)?)\s*(tb|gb|mb|kb|b)\b/i.exec(text);
  if (!m) return -1;

  const value = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return -1;

  const unit = m[2].toUpperCase();
  let mult = 1;
  if (unit === "KB") mult = 1024;
  if (unit === "MB") mult = 1024 ** 2;
  if (unit === "GB") mult = 1024 ** 3;
  if (unit === "TB") mult = 1024 ** 4;

  return Math.round(value * mult);
}

function clampStreamLimit(v) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return 5;
  return Math.max(1, Math.min(MAX_STREAMS, n));
}

function buildInflightKey(type, stremioId, config = {}) {
  return [
    String(type || ""),
    String(stremioId || ""),
    config.premium ? "1" : "0",
    String(config.email || "").toLowerCase(),
    String(config.limit || ""),
    String(config.streamLimit || ""),
  ].join("|");
}

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

function scoreWithWanted(candidate, wanted) {
  const titles = uniqueNonEmpty([
    wanted?.wantedTitle || "",
    ...(wanted?.altWantedTitles || []),
  ]);
  if (titles.length === 0) {
    titles.push(normalizeSpaces(candidate?.title || ""));
  }

  let best = -Infinity;
  for (const t of titles) {
    const s = scoreCandidate(
      {
        wantedTitle: t,
        wantedYear: wanted?.wantedYear,
        wantedSxxExx: wanted?.wantedSxxExx,
        wantedSeason: wanted?.wantedSeason,
        wantedEpisode: wanted?.wantedEpisode,
      },
      candidate,
    );
    if (s > best) best = s;
  }
  return best;
}

async function mapConcurrent(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const out = new Array(items.length);
  let index = 0;

  async function runWorker() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const i = index;
      index += 1;
      if (i >= items.length) break;

      try {
        out[i] = await worker(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
  return out;
}

export const StreamService = {
  async streamsForId(type, stremioId, config = {}) {
    const key = buildInflightKey(type, stremioId, config);
    const noStreamsKey = `stream:no:${key}`;

    if (cache.has(noStreamsKey)) {
      log.debug("streamsForId:negative-cache hit", {
        type,
        id: summarizeId(stremioId),
      });
      return { streams: [] };
    }

    const existing = STREAM_INFLIGHT.get(key);
    if (existing) {
      log.debug("streamsForId:in-flight hit", {
        type,
        id: summarizeId(stremioId),
      });
      return await existing;
    }

    const work = this._streamsForIdImpl(type, stremioId, config);
    STREAM_INFLIGHT.set(key, work);

    try {
      const out = await work;
      const streams = Array.isArray(out?.streams) ? out.streams : [];

      if (streams.length === 0) {
        cache.set(noStreamsKey, true, { ttl: NO_STREAMS_TTL_MS });
      } else {
        cache.delete(noStreamsKey);
      }

      return { streams };
    } catch (e) {
      log.error("streamsForId:failed", {
        type,
        id: summarizeId(stremioId),
        error: errorMeta(e),
      });
      cache.set(noStreamsKey, true, { ttl: 60_000 });
      return { streams: [] };
    } finally {
      if (STREAM_INFLIGHT.get(key) === work) STREAM_INFLIGHT.delete(key);
    }
  },

  async _streamsForIdImpl(type, stremioId, config) {
    const startedAt = Date.now();
    const pid = parseId(stremioId);
    log.debug("streamsForId:start", {
      type,
      id: summarizeId(stremioId),
      kind: pid.kind,
      limit: config?.limit,
      premium: config?.premium,
    });

    if (pid.kind === "pt_url") {
      const resolved = await PREHRAJTO.resolveStream(pid.value, config);
      if (!resolved) return { streams: [] };

      log.info("streamsForId:pt_url resolved", {
        ms: elapsedMs(startedAt),
        url: sanitizeUrl(resolved.url),
      });
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

    if (pid.kind === "pt_query") {
      return await this.streamsFromQueries([pid.value], config, {
        wantedTitle: pid.value,
      });
    }

    if (pid.kind === "imdb_title") {
      if (type === "movie") {
        let tmdbMovie = null;
        let cmMovie = null;
        let year = null;
        const querySet = new Set();

        try {
          const found = await TMDB.findByImdb(pid.imdbId);
          if (found.movie?.id) {
            log.debug("streamsForId:imdb_title tmdb match movie", {
              imdbId: pid.imdbId,
              tmdbMovieId: found.movie.id,
            });
            tmdbMovie = await TMDB.movie(found.movie.id);
            year = tmdbMovie?.release_date?.slice(0, 4) || null;
            addNameQueries(querySet, tmdbMovie?.title, year);
            addNameQueries(querySet, tmdbMovie?.original_title, year);
          }
        } catch {
          log.warn("streamsForId:imdb_title tmdb movie mapping failed", {
            imdbId: pid.imdbId,
          });
        }

        try {
          cmMovie = await CINEMETA.movieByImdb(pid.imdbId);
          if (cmMovie?.name) {
            if (!year) year = /\b(19|20)\d{2}\b/.exec(cmMovie.releaseInfo || "")?.[0] || null;
            addNameQueries(querySet, cmMovie.name, year);
          }
        } catch {
          log.warn("streamsForId:imdb_title cinemeta movie mapping failed", {
            imdbId: pid.imdbId,
          });
        }

        const queries = Array.from(querySet).slice(0, MAX_QUERY_VARIANTS);
        if (queries.length === 0) return { streams: [] };
        return await this.streamsFromQueries(queries, config, {
          wantedTitle: tmdbMovie?.title || cmMovie?.name || queries[0],
          altWantedTitles: [tmdbMovie?.original_title, cmMovie?.name],
          wantedYear: year,
        });
      }

      if (type === "series") {
        let tmdbSeries = null;
        let cmSeries = null;
        const querySet = new Set();

        try {
          const found = await TMDB.findByImdb(pid.imdbId);
          if (found.series?.id) {
            log.debug("streamsForId:imdb_title tmdb match series", {
              imdbId: pid.imdbId,
              tmdbSeriesId: found.series.id,
            });
            tmdbSeries = await TMDB.series(found.series.id);
            addNameQueries(querySet, tmdbSeries?.name);
            addNameQueries(querySet, tmdbSeries?.original_name);
          }
        } catch {
          log.warn("streamsForId:imdb_title tmdb series mapping failed", {
            imdbId: pid.imdbId,
          });
        }

        try {
          cmSeries = await CINEMETA.seriesByImdb(pid.imdbId);
          if (cmSeries?.name) addNameQueries(querySet, cmSeries.name);
        } catch {
          log.warn("streamsForId:imdb_title cinemeta series mapping failed", {
            imdbId: pid.imdbId,
          });
        }

        const queries = Array.from(querySet).slice(0, MAX_QUERY_VARIANTS);
        if (queries.length === 0) return { streams: [] };
        return await this.streamsFromQueries(queries, config, {
          wantedTitle: tmdbSeries?.name || cmSeries?.name || queries[0],
          altWantedTitles: [tmdbSeries?.original_name, cmSeries?.name],
        });
      }

      return { streams: [] };
    }

    if (pid.kind === "imdb_episode") {
      const marker = sxxexx(pid.season, pid.episode);
      const markers = episodeQueryMarkers(pid.season, pid.episode).slice(0, 4);
      const querySet = new Set();
      let tmdbSeries = null;
      let cmSeries = null;
      const addEpisodeQueries = (name) => {
        const cleanName = normalizeSpaces(name);
        if (!cleanName) return;
        for (const m of markers) {
          addQuery(querySet, `${cleanName} ${m}`);
        }
      };

      try {
        const found = await TMDB.findByImdb(pid.imdbId);
        if (found.series?.id) {
          log.debug("streamsForId:imdb_episode tmdb match series", {
            imdbId: pid.imdbId,
            tmdbSeriesId: found.series.id,
          });
          tmdbSeries = await TMDB.series(found.series.id);
          addEpisodeQueries(tmdbSeries?.name);
          addEpisodeQueries(tmdbSeries?.original_name);
        }
      } catch {
        log.warn("streamsForId:imdb_episode tmdb mapping failed", {
          imdbId: pid.imdbId,
        });
      }

      try {
        cmSeries = await CINEMETA.seriesByImdb(pid.imdbId);
        addEpisodeQueries(cmSeries?.name);
      } catch {
        log.warn("streamsForId:imdb_episode cinemeta mapping failed", {
          imdbId: pid.imdbId,
        });
      }

      const queries = Array.from(querySet).slice(0, MAX_QUERY_VARIANTS);
      if (queries.length === 0) return { streams: [] };
      return await this.streamsFromQueries(queries, config, {
        wantedTitle: tmdbSeries?.name || cmSeries?.name || queries[0],
        altWantedTitles: [tmdbSeries?.original_name, cmSeries?.name],
        wantedSxxExx: marker,
        wantedSeason: pid.season,
        wantedEpisode: pid.episode,
      });
    }

    log.info("streamsForId:unsupported id", {
      type,
      id: summarizeId(stremioId),
      kind: pid.kind,
      ms: elapsedMs(startedAt),
    });
    return { streams: [] };
  },

  async streamsFromQuery(query, config, wanted = {}) {
    return await this.streamsFromQueries([query], config, wanted);
  },

  async streamsFromQueries(queries, config, wanted = {}) {
    const startedAt = Date.now();
    const plannedQueries = await buildSearchQueryPlan(queries, wanted);
    if (plannedQueries.length === 0) return { streams: [] };
    const wantedEpisode = parseWantedEpisode(wanted);

    const maxStreams = clampStreamLimit(config?.streamLimit);
    const configuredSearchLimit = parseInt(config?.limit, 10);
    const searchByStreams = Math.max(
      SEARCH_PER_QUERY_MIN,
      maxStreams * SEARCH_PER_STREAM_FACTOR,
    );
    const searchPerQuery = Math.min(
      SEARCH_PER_QUERY_MAX,
      Math.max(
        SEARCH_PER_QUERY_MIN,
        Math.min(
          Number.isFinite(configuredSearchLimit)
            ? configuredSearchLimit
            : SEARCH_PER_QUERY_MAX,
          searchByStreams,
        ),
      ),
    );
    const maxResolve = Math.min(
      MAX_CANDIDATES_TO_RESOLVE,
      Math.max(maxStreams * RESOLVE_FACTOR, maxStreams),
    );

    log.debug("streamsFromQueries:start", {
      queries: plannedQueries,
      searchPerQuery,
      maxResolve,
      budgetMs: STREAM_REQUEST_BUDGET_MS,
      streamLimit: config?.streamLimit,
      wantedTitle: wanted.wantedTitle || "",
      wantedYear: wanted.wantedYear || "",
      wantedSxxExx: wanted.wantedSxxExx || "",
      wantedSeason: wantedEpisode?.season,
      wantedEpisode: wantedEpisode?.episode,
    });

    const byUrl = new Map();
    const attemptedPageUrls = new Set();
    const dedupByStreamUrl = new Map();
    let queriesTried = 0;

    for (const q of plannedQueries) {
      queriesTried += 1;
      if (elapsedMs(startedAt) >= STREAM_REQUEST_BUDGET_MS) {
        log.warn("streamsFromQueries:time budget reached before search", {
          query: q,
          ms: elapsedMs(startedAt),
          queriesTried,
        });
        break;
      }

      const results = await PREHRAJTO.search(q, { limit: searchPerQuery });
      log.debug("streamsFromQueries:search result", { query: q, count: results.length });

      for (const r of results) {
        if (!r?.url) continue;
        if (!byUrl.has(r.url)) byUrl.set(r.url, r);
      }

      const needStreams = Math.max(0, maxStreams - dedupByStreamUrl.size);
      if (needStreams <= 0) break;

      const remainingResolveSlots = Math.max(0, maxResolve - attemptedPageUrls.size);
      if (remainingResolveSlots <= 0) {
        log.debug("streamsFromQueries:resolve budget exhausted", {
          query: q,
          maxResolve,
          attempted: attemptedPageUrls.size,
          resolvedUnique: dedupByStreamUrl.size,
        });
        break;
      }

      const candidates = Array.from(byUrl.values());
      const scored = candidates
        .map((r) => ({
          r,
          s: scoreWithWanted(r, wanted),
          episode: episodeMatchForCandidate(r, wantedEpisode),
        }))
        .map((row) => {
          if (!wantedEpisode) return row;
          if (row.episode.hasEpisodeMarkers) {
            row.s += row.episode.isMatch ? 90 : -300;
          } else {
            row.s -= 25;
          }
          return row;
        })
        .sort((a, b) => b.s - a.s);

      let selectable = scored.filter((x) => x?.r?.url && !attemptedPageUrls.has(x.r.url));
      if (wantedEpisode) {
        const episodeMatches = selectable.filter((x) => x.episode?.isMatch);
        if (episodeMatches.length === 0) {
          log.debug("streamsFromQueries:episode no matching candidates in batch", {
            query: q,
            wantedSeason: wantedEpisode.season,
            wantedEpisode: wantedEpisode.episode,
            candidateCount: selectable.length,
          });
          continue;
        }
        selectable = episodeMatches;
      }

      const batchSize = Math.min(
        RESOLVE_BATCH_SIZE,
        remainingResolveSlots,
        Math.max(needStreams * RESOLVE_FACTOR, needStreams),
      );
      const toResolve = selectable.slice(0, batchSize);

      log.debug("streamsFromQueries:resolve batch", {
        query: q,
        candidateCount: candidates.length,
        resolveCount: toResolve.length,
        remainingResolveSlots,
        maxStreams,
        resolvedAlready: dedupByStreamUrl.size,
        top: toResolve.slice(0, 5).map((x) => ({
          score: x.s,
          title: x.r.title,
          url: sanitizeUrl(x.r.url),
        })),
      });

      if (toResolve.length === 0) continue;
      for (const item of toResolve) attemptedPageUrls.add(item.r.url);

      const resolvedRows = await mapConcurrent(
        toResolve,
        RESOLVE_CONCURRENCY,
        async (item) => {
          const resolved = await PREHRAJTO.resolveStream(item.r.url, config);
          if (!resolved?.url) return null;
          return {
            streamUrl: resolved.url,
            subtitles: resolved.subtitles || [],
            sourceTitle: item.r.title,
            sourceUrl: item.r.url,
            sourceSizeText: item.r.sizeText || "",
            sourceSizeBytes: item.r.sizeBytes,
            score: item.s,
          };
        },
      );

      for (const row of resolvedRows) {
        if (!row?.streamUrl) continue;
        const prev = dedupByStreamUrl.get(row.streamUrl);
        if (!prev || row.score > prev.score) dedupByStreamUrl.set(row.streamUrl, row);
      }

      if (dedupByStreamUrl.size >= maxStreams) break;
      if (elapsedMs(startedAt) >= STREAM_REQUEST_BUDGET_MS) {
        log.warn("streamsFromQueries:time budget reached after resolve batch", {
          query: q,
          ms: elapsedMs(startedAt),
          attempted: attemptedPageUrls.size,
          resolvedUnique: dedupByStreamUrl.size,
        });
        break;
      }
      if (attemptedPageUrls.size >= maxResolve) break;
    }

    const candidates = Array.from(byUrl.values());
    if (candidates.length === 0) {
      log.info("streamsFromQueries:no search results", {
        queries: plannedQueries,
        ms: elapsedMs(startedAt),
      });
      return { streams: [] };
    }

    const uniqueResolved = Array.from(dedupByStreamUrl.values());
    if (uniqueResolved.length === 0) {
      log.info("streamsFromQueries:no resolvable streams", {
        queries: plannedQueries,
        attemptedResolve: attemptedPageUrls.size,
        ms: elapsedMs(startedAt),
      });
      return { streams: [] };
    }

    let resolvedForRanking = uniqueResolved;
    if (wantedEpisode) {
      resolvedForRanking = uniqueResolved.filter((row) => {
        const match = episodeMatchForCandidate(
          { title: row.sourceTitle, url: row.sourceUrl },
          wantedEpisode,
        );
        return match.isMatch;
      });
      if (resolvedForRanking.length === 0) {
        log.info("streamsFromQueries:no episode-matching resolved streams", {
          wantedSeason: wantedEpisode.season,
          wantedEpisode: wantedEpisode.episode,
          resolvedUnique: uniqueResolved.length,
          attemptedResolve: attemptedPageUrls.size,
          ms: elapsedMs(startedAt),
        });
        return { streams: [] };
      }
    }

    const rankedRows = resolvedForRanking
      .map((row) => {
        const sizeFromTag = Number(row.sourceSizeBytes);
        const parsedSizeBytes = Number.isFinite(sizeFromTag) && sizeFromTag > 0
          ? sizeFromTag
          : parseSizeFromTitleBytes(row.sourceTitle);
        return {
          ...row,
          parsedSizeBytes,
        };
      })
      .sort((a, b) => {
        const sa = Number.isFinite(a.parsedSizeBytes) ? a.parsedSizeBytes : -1;
        const sb = Number.isFinite(b.parsedSizeBytes) ? b.parsedSizeBytes : -1;
        if (sb !== sa) return sb - sa;
        const byTitle = String(a.sourceTitle || "").localeCompare(
          String(b.sourceTitle || ""),
          "cs",
          { sensitivity: "base" },
        );
        if (byTitle !== 0) return byTitle;
        return String(a.sourceUrl || "").localeCompare(String(b.sourceUrl || ""));
      })
      .slice(0, maxStreams);

    const streams = rankedRows.map((row) => {
      const title = buildDisplayTitle({
        sourceTitle: row.sourceTitle,
        sourceSizeText: row.sourceSizeText,
        parsedSizeBytes: row.parsedSizeBytes,
        fallbackTitle: wanted?.wantedTitle || "",
      });

      return buildStreamEntry({
        url: row.streamUrl,
        title,
        subtitles: row.subtitles,
      });
    });

    log.info("streamsFromQueries:done", {
      queriesTried,
      candidateCount: candidates.length,
      attemptedResolve: attemptedPageUrls.size,
      maxResolve,
      resolvedUnique: uniqueResolved.length,
      resolvedAfterEpisodeFilter: resolvedForRanking.length,
      streams: streams.length,
      maxStreams,
      withParsedSize: rankedRows.filter((r) => r.parsedSizeBytes > 0).length,
      ms: elapsedMs(startedAt),
    });

    return { streams };
  },
};
