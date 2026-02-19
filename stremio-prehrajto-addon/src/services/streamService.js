import { PREHRAJTO } from "./prehrajto.js";
import { TMDB } from "./tmdb.js";
import { CINEMETA } from "./cinemeta.js";
import { scoreCandidate } from "../utils/scoring.js";
import { sxxexx } from "../utils/text.js";
import { parseId } from "../ids.js";
import { cache } from "../utils/cache.js";
import { httpGet, httpHead } from "../utils/http.js";
import { elapsedMs, errorMeta, log, sanitizeUrl, summarizeId } from "../utils/log.js";

const STREAM_INFLIGHT = new Map();
const NO_STREAMS_TTL_MS = 180_000;
const MAX_STREAMS = 15;
const MAX_QUERY_VARIANTS = 8;
const MAX_CANDIDATES_TO_RESOLVE = 40;
const RESOLVE_CONCURRENCY = 4;
const SIZE_PROBE_CONCURRENCY = 6;
const SEARCH_PER_QUERY_MIN = 20;
const SEARCH_PER_QUERY_MAX = 60;

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

function buildInflightKey(type, stremioId, config = {}) {
  return [
    String(type || ""),
    String(stremioId || ""),
    config.premium ? "1" : "0",
    String(config.email || "").toLowerCase(),
    String(config.limit || ""),
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

async function probeContentLength(url) {
  const cacheKey = `size:${url}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  let size = -1;

  try {
    const { res } = await httpHead(url, {
      throwOnHttpError: false,
      timeoutMs: 8000,
    });
    if (res.ok) {
      const len = parseInt(res.headers.get("content-length") || "", 10);
      if (Number.isFinite(len) && len > 0) size = len;
    }
  } catch {
    // ignore, fallback to range probe
  }

  if (size <= 0) {
    try {
      const { res } = await httpGet(url, {
        throwOnHttpError: false,
        timeoutMs: 8000,
        headers: { Range: "bytes=0-0" },
      });
      if (res.ok || res.status === 206) {
        const contentRange = String(res.headers.get("content-range") || "");
        const fromRange = /\/(\d+)\s*$/i.exec(contentRange);
        if (fromRange) {
          const n = parseInt(fromRange[1], 10);
          if (Number.isFinite(n) && n > 0) size = n;
        } else {
          const len = parseInt(res.headers.get("content-length") || "", 10);
          if (Number.isFinite(len) && len > 0) size = len;
        }
      }
    } catch {
      // ignore
    }
  }

  cache.set(cacheKey, size, { ttl: 6 * 60 * 60 * 1000 });
  return size;
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

      const sizeBytes = await probeContentLength(resolved.url);
      const sizeText = formatBytes(sizeBytes);
      const title = sizeText ? `Prehraj.to • ${sizeText}` : "Prehraj.to";

      log.info("streamsForId:pt_url resolved", {
        ms: elapsedMs(startedAt),
        url: sanitizeUrl(resolved.url),
        sizeBytes,
      });
      return {
        streams: [
          buildStreamEntry({
            url: resolved.url,
            title,
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
      const querySet = new Set();
      let tmdbSeries = null;
      let cmSeries = null;

      try {
        const found = await TMDB.findByImdb(pid.imdbId);
        if (found.series?.id) {
          log.debug("streamsForId:imdb_episode tmdb match series", {
            imdbId: pid.imdbId,
            tmdbSeriesId: found.series.id,
          });
          tmdbSeries = await TMDB.series(found.series.id);
          addQuery(querySet, `${tmdbSeries?.name || ""} ${marker}`);
          addQuery(querySet, `${tmdbSeries?.original_name || ""} ${marker}`);
        }
      } catch {
        log.warn("streamsForId:imdb_episode tmdb mapping failed", {
          imdbId: pid.imdbId,
        });
      }

      try {
        cmSeries = await CINEMETA.seriesByImdb(pid.imdbId);
        if (cmSeries?.name) addQuery(querySet, `${cmSeries.name} ${marker}`);
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
    const normalizedQueries = uniqueNonEmpty(queries).slice(0, MAX_QUERY_VARIANTS);
    if (normalizedQueries.length === 0) return { streams: [] };

    const searchPerQuery = Math.min(
      SEARCH_PER_QUERY_MAX,
      Math.max(
        SEARCH_PER_QUERY_MIN,
        parseInt(config?.limit, 10) || SEARCH_PER_QUERY_MIN,
      ),
    );

    log.debug("streamsFromQueries:start", {
      queries: normalizedQueries,
      searchPerQuery,
      wantedTitle: wanted.wantedTitle || "",
      wantedYear: wanted.wantedYear || "",
      wantedSxxExx: wanted.wantedSxxExx || "",
    });

    const byUrl = new Map();
    for (const q of normalizedQueries) {
      const results = await PREHRAJTO.search(q, { limit: searchPerQuery });
      log.debug("streamsFromQueries:search result", { query: q, count: results.length });

      for (const r of results) {
        if (!r?.url) continue;
        if (!byUrl.has(r.url)) byUrl.set(r.url, r);
      }

      if (byUrl.size >= MAX_CANDIDATES_TO_RESOLVE * 2) break;
    }

    const candidates = Array.from(byUrl.values());
    if (candidates.length === 0) {
      log.info("streamsFromQueries:no search results", {
        queries: normalizedQueries,
        ms: elapsedMs(startedAt),
      });
      return { streams: [] };
    }

    const scored = candidates
      .map((r) => ({
        r,
        s: scoreWithWanted(r, wanted),
      }))
      .sort((a, b) => b.s - a.s);

    const toResolve = scored.slice(0, Math.min(scored.length, MAX_CANDIDATES_TO_RESOLVE));
    log.debug("streamsFromQueries:resolve batch", {
      candidateCount: candidates.length,
      resolveCount: toResolve.length,
      top: toResolve.slice(0, 5).map((x) => ({
        score: x.s,
        title: x.r.title,
        url: sanitizeUrl(x.r.url),
      })),
    });

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
          score: item.s,
        };
      },
    );

    const dedupByStreamUrl = new Map();
    for (const row of resolvedRows) {
      if (!row?.streamUrl) continue;
      const prev = dedupByStreamUrl.get(row.streamUrl);
      if (!prev || row.score > prev.score) dedupByStreamUrl.set(row.streamUrl, row);
    }

    const uniqueResolved = Array.from(dedupByStreamUrl.values());
    if (uniqueResolved.length === 0) {
      log.info("streamsFromQueries:no resolvable streams", {
        queries: normalizedQueries,
        ms: elapsedMs(startedAt),
      });
      return { streams: [] };
    }

    const sizedRows = await mapConcurrent(
      uniqueResolved,
      SIZE_PROBE_CONCURRENCY,
      async (row) => {
        const sizeBytes = await probeContentLength(row.streamUrl);
        return { ...row, sizeBytes };
      },
    );

    const finalRows = sizedRows
      .filter(Boolean)
      .sort((a, b) => {
        const sa = Number.isFinite(a.sizeBytes) ? a.sizeBytes : -1;
        const sb = Number.isFinite(b.sizeBytes) ? b.sizeBytes : -1;
        if (sb !== sa) return sb - sa;
        return b.score - a.score;
      })
      .slice(0, MAX_STREAMS);

    const streams = finalRows.map((row) => {
      const sizeText = formatBytes(row.sizeBytes);
      const title = sizeText
        ? `Prehraj.to • ${row.sourceTitle} • ${sizeText}`
        : `Prehraj.to • ${row.sourceTitle}`;

      return buildStreamEntry({
        url: row.streamUrl,
        title,
        subtitles: row.subtitles,
      });
    });

    log.info("streamsFromQueries:done", {
      queriesTried: normalizedQueries.length,
      candidateCount: candidates.length,
      resolvedUnique: uniqueResolved.length,
      streams: streams.length,
      ms: elapsedMs(startedAt),
    });

    return { streams };
  },
};

