import { PREHRAJTO } from "./prehrajto.js";
import { TMDB } from "./tmdb.js";
import { CINEMETA } from "./cinemeta.js";
import { scoreCandidate } from "../utils/scoring.js";
import { sxxexx } from "../utils/text.js";
import { parseId } from "../ids.js";
import { cache } from "../utils/cache.js";
import { elapsedMs, errorMeta, log, sanitizeUrl, summarizeId } from "../utils/log.js";

const STREAM_INFLIGHT = new Map();
const NO_STREAMS_TTL_MS = 180_000;

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
      log.debug("streamsForId:pt_query", { query: pid.value });
      return await this.streamsFromQuery(pid.value, config);
    }

    if (pid.kind === "imdb_title") {
      if (type === "movie") {
        try {
          const found = await TMDB.findByImdb(pid.imdbId);
          if (found.movie?.id) {
            log.debug("streamsForId:imdb_title tmdb match movie", {
              imdbId: pid.imdbId,
              tmdbMovieId: found.movie.id,
            });
            const movie = await TMDB.movie(found.movie.id);
            const query =
              `${movie.title} ${movie.release_date?.slice(0, 4) || ""}`.trim();
            return await this.streamsFromQuery(query, config, {
              wantedTitle: movie.title,
              wantedYear: movie.release_date?.slice(0, 4),
            });
          }
        } catch {
          log.warn("streamsForId:imdb_title tmdb movie mapping failed", {
            imdbId: pid.imdbId,
          });
        }

        const cmMovie = await CINEMETA.movieByImdb(pid.imdbId);
        if (!cmMovie?.name) {
          log.info("streamsForId:imdb_title no Cinemeta movie", { imdbId: pid.imdbId });
          return { streams: [] };
        }
        log.debug("streamsForId:imdb_title using Cinemeta movie", {
          imdbId: pid.imdbId,
          name: cmMovie.name,
        });
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
            log.debug("streamsForId:imdb_title tmdb match series", {
              imdbId: pid.imdbId,
              tmdbSeriesId: found.series.id,
            });
            const series = await TMDB.series(found.series.id);
            return await this.streamsFromQuery(series.name, config, {
              wantedTitle: series.name,
            });
          }
        } catch {
          log.warn("streamsForId:imdb_title tmdb series mapping failed", {
            imdbId: pid.imdbId,
          });
        }

        const cmSeries = await CINEMETA.seriesByImdb(pid.imdbId);
        if (!cmSeries?.name) {
          log.info("streamsForId:imdb_title no Cinemeta series", { imdbId: pid.imdbId });
          return { streams: [] };
        }
        log.debug("streamsForId:imdb_title using Cinemeta series", {
          imdbId: pid.imdbId,
          name: cmSeries.name,
        });
        return await this.streamsFromQuery(cmSeries.name, config, {
          wantedTitle: cmSeries.name,
        });
      }

      return { streams: [] };
    }

    if (pid.kind === "imdb_episode") {
      const marker = sxxexx(pid.season, pid.episode);
      log.debug("streamsForId:imdb_episode", {
        imdbId: pid.imdbId,
        marker,
      });

      try {
        const found = await TMDB.findByImdb(pid.imdbId);
        if (found.series?.id) {
          log.debug("streamsForId:imdb_episode tmdb match series", {
            imdbId: pid.imdbId,
            tmdbSeriesId: found.series.id,
          });
          const series = await TMDB.series(found.series.id);
          const query = `${series.name} ${marker}`;
          return await this.streamsFromQuery(query, config, {
            wantedTitle: series.name,
            wantedSxxExx: marker,
          });
        }
      } catch {
        log.warn("streamsForId:imdb_episode tmdb mapping failed", {
          imdbId: pid.imdbId,
        });
      }

      const cmSeries = await CINEMETA.seriesByImdb(pid.imdbId);
      if (!cmSeries?.name) {
        log.info("streamsForId:imdb_episode no Cinemeta series", { imdbId: pid.imdbId });
        return { streams: [] };
      }
      log.debug("streamsForId:imdb_episode using Cinemeta series", {
        imdbId: pid.imdbId,
        name: cmSeries.name,
      });
      const query = `${cmSeries.name} ${marker}`;
      return await this.streamsFromQuery(query, config, {
        wantedTitle: cmSeries.name,
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
    const startedAt = Date.now();
    const searchLimit = Math.min(Math.max(config.limit || 10, 1), 10);
    log.debug("streamsFromQuery:start", {
      query,
      limit: searchLimit,
      wantedTitle: wanted.wantedTitle || "",
      wantedYear: wanted.wantedYear || "",
      wantedSxxExx: wanted.wantedSxxExx || "",
    });
    const results = await PREHRAJTO.search(query, { limit: searchLimit });

    if (!results.length) {
      log.info("streamsFromQuery:no search results", {
        query,
        ms: elapsedMs(startedAt),
      });
      return { streams: [] };
    }
    log.debug("streamsFromQuery:search results", {
      query,
      count: results.length,
    });

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
    log.debug("streamsFromQuery:top scored", {
      query,
      top: scored.slice(0, 3).map((x) => ({
        score: x.s,
        title: x.r?.title,
        url: sanitizeUrl(x.r?.url),
      })),
    });

    const top = scored.slice(0, 2);
    const streams = [];

    for (const item of top) {
      let resolved;
      try {
        resolved = await PREHRAJTO.resolveStream(item.r.url, config);
      } catch (e) {
        log.warn("streamsFromQuery:resolve failed", {
          query,
          url: sanitizeUrl(item.r?.url),
          error: errorMeta(e),
        });
        continue;
      }
      if (!resolved) continue;
      log.debug("streamsFromQuery:resolve success", {
        query,
        sourceTitle: item.r?.title,
        streamUrl: sanitizeUrl(resolved.url),
        subtitles: Array.isArray(resolved.subtitles) ? resolved.subtitles.length : 0,
      });

      streams.push(
        buildStreamEntry({
          url: resolved.url,
          title: `Prehraj.to • ${item.r.title}`,
          subtitles: resolved.subtitles,
        }),
      );

      if (streams.length >= 2) break;
    }

    log.info("streamsFromQuery:done", {
      query,
      streams: streams.length,
      ms: elapsedMs(startedAt),
    });
    return { streams };
  },
};

