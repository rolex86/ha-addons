import { ENV } from "../env.js";
import { cache } from "../utils/cache.js";
import { httpGet, httpPost } from "../utils/http.js";
import { elapsedMs, errorMeta, log, sanitizeUrl } from "../utils/log.js";

const SEARCH_UNAVAILABLE_COOLDOWN_MS = 30_000;
const SEARCH_ERROR_COOLDOWN_MS = 60_000;
const EMPTY_SEARCH_TTL_MS = 180_000;
const SUGGEST_TTL_MS = 300_000;
const SUGGEST_MAX_ITEMS = 8;

let searchUnavailableUntil = 0;
const searchInFlight = new Map();
const suggestInFlight = new Map();

// Very lightweight cookie jar for premium login
function extractSetCookies(res) {
  const raw = res.headers.raw?.()["set-cookie"] || [];
  return raw.map((c) => c.split(";")[0]).join("; ");
}

async function premiumLogin(email, password) {
  if (!email || !password) return null;

  const cacheKey = `pt:cookie:${email}`;
  const cachedCookie = cache.get(cacheKey);
  if (cachedCookie) {
    log.debug("prehrajto:premiumLogin cache hit", { hasEmail: Boolean(email) });
    return cachedCookie;
  }

  const loginUrl = `${ENV.PREHRAJTO_BASE}/prihlaseni`;
  const body = new URLSearchParams({
    email,
    password,
  }).toString();

  const startedAt = Date.now();
  const { res } = await httpPost(loginUrl, body, {
    redirect: "manual",
    throwOnHttpError: false,
  });
  const cookie = extractSetCookies(res);
  log.debug("prehrajto:premiumLogin result", {
    status: res.status,
    hasCookie: Boolean(cookie),
    ms: elapsedMs(startedAt),
  });

  if (cookie && cookie.length > 0) {
    cache.set(cacheKey, cookie);
    return cookie;
  }
  return null;
}

function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function buildSearchUrl(query) {
  const base = ENV.PREHRAJTO_BASE.replace(/\/+$/g, "");
  return `${base}/hledej/${encodeURIComponent(query)}`;
}

function buildSuggestUrl(query) {
  const base = ENV.PREHRAJTO_BASE.replace(/\/+$/g, "");
  return `${base}/api/v1/public/suggest/${encodeURIComponent(query)}`;
}

function buildSearchVariants(query) {
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

  add(query);
  add(query.replace(/\b(19|20)\d{2}\b/g, ""));
  add(query.replace(/\bs\d{1,2}e\d{1,2}\b/gi, ""));
  add(
    query
      .replace(/\b(19|20)\d{2}\b/g, "")
      .replace(/\bs\d{1,2}e\d{1,2}\b/gi, ""),
  );
  return out;
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]*>/g, "");
}

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function parseYear(text) {
  const yearMatch = /\b(19|20)\d{2}\b/.exec(String(text || ""));
  if (!yearMatch) return null;
  return parseInt(yearMatch[0], 10);
}

function inferTitleFromUrl(absUrl) {
  try {
    const segs = new URL(absUrl).pathname.split("/").filter(Boolean);
    if (segs.length < 2) return "";
    const slug = segs[segs.length - 2];
    return slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function absolutizeHttpUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const cleaned = raw
      .replace(/\\u002F/gi, "/")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&");
    const u = new URL(cleaned, ENV.PREHRAJTO_BASE).toString();
    if (!/^https?:\/\//i.test(u)) return null;
    return u;
  } catch {
    return null;
  }
}

function isLikelyVideoHref(href) {
  const abs = absolutizeHttpUrl(href);
  if (!abs) return false;

  let path = "";
  try {
    path = new URL(abs).pathname || "";
  } catch {
    return false;
  }
  const p = path.toLowerCase();

  if (/\/video\/|\/v\//i.test(p)) return true;

  const segs = p.split("/").filter(Boolean);
  if (segs.length >= 2) {
    const last = segs[segs.length - 1];
    if (/^[a-z0-9]{8,}$/i.test(last)) return true;
  }

  return false;
}

function parseSearchResultsHtml(html, limit) {
  const out = [];
  const seen = new Set();
  const linkRe = /<a[^>]+href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gis;

  let m;
  while ((m = linkRe.exec(html))) {
    if (out.length >= limit) break;

    const href = m[2];
    if (!href || !isLikelyVideoHref(href)) continue;

    const url = absolutizeHttpUrl(href);
    if (!url || seen.has(url)) continue;

    const rawTitle = decodeHtmlEntities(stripTags(m[3] || ""));
    const title = normalizeSpaces(rawTitle) || inferTitleFromUrl(url);
    if (!title) continue;

    seen.add(url);
    out.push({
      title,
      year: parseYear(title),
      url,
    });
  }

  return out;
}

function parseVideoSources(html) {
  const urls = new Set();
  const addUrl = (u) => {
    const abs = absolutizeHttpUrl(u);
    if (abs) urls.add(abs);
  };

  const fileRe = /file\s*:\s*"([^"]+)"/gi;
  const srcRe = /src\s*:\s*"([^"]+)"/gi;

  let m;
  while ((m = fileRe.exec(html))) addUrl(m[1]);
  while ((m = srcRe.exec(html))) addUrl(m[1]);

  const sourceTagRe = /<source[^>]+src="([^"]+)"/gi;
  while ((m = sourceTagRe.exec(html))) addUrl(m[1]);

  const mediaRe = /(https?:\/\/[^"' ]+\.(?:mp4|m3u8)(?:\?[^"' ]*)?)/gi;
  while ((m = mediaRe.exec(html))) addUrl(m[1]);

  const escapedMediaRe =
    /(https?:\\\/\\\/[^"' ]+\.(?:mp4|m3u8)(?:\?[^"' ]*)?)/gi;
  while ((m = escapedMediaRe.exec(html))) {
    addUrl(m[1].replace(/\\\//g, "/"));
  }

  return Array.from(urls);
}

function parseSubtitles(html) {
  const subs = [];
  const trackRe = /<track[^>]+src="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = trackRe.exec(html))) {
    const src = m[1];
    if (!src) continue;
    const langMatch = /srclang="([^"]+)"/i.exec(m[0]);
    const labelMatch = /label="([^"]+)"/i.exec(m[0]);
    const abs = absolutizeHttpUrl(src);
    if (!abs) continue;
    subs.push({
      url: abs,
      lang: (langMatch?.[1] || "und").toLowerCase(),
      label: labelMatch?.[1] || undefined,
    });
  }

  const vttRe = /(https?:\/\/[^"' ]+\.vtt)/gi;
  while ((m = vttRe.exec(html))) {
    const abs = absolutizeHttpUrl(m[1]);
    if (abs) subs.push({ url: abs, lang: "und" });
  }

  const uniq = new Map();
  for (const s of subs) uniq.set(`${s.lang}:${s.url}`, s);
  return Array.from(uniq.values());
}

function parseSuggestItems(text, query, limit) {
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

  add(query);

  try {
    const data = JSON.parse(String(text || "{}"));
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      add(item?.name || "");
      if (out.length >= limit) break;
    }
  } catch {
    // ignore JSON parse failure
  }

  return out.slice(0, limit);
}

async function premiumDownloadRedirect(videoPageUrl, cookie) {
  const u = new URL(videoPageUrl);
  u.searchParams.set("do", "download");

  const startedAt = Date.now();
  const { res } = await httpGet(u.toString(), {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: "manual",
    throwOnHttpError: false,
  });

  const loc = res.headers.get("location");
  log.debug("prehrajto:premiumDownloadRedirect", {
    pageUrl: sanitizeUrl(videoPageUrl),
    status: res.status,
    hasLocation: Boolean(loc),
    ms: elapsedMs(startedAt),
  });
  if (loc && /^https?:\/\//i.test(loc)) return loc;
  return null;
}

export const PREHRAJTO = {
  async suggest(query, { limit = 4 } = {}) {
    const startedAt = Date.now();
    const q = normalizeSpaces(query);
    if (!q) return [];

    const normalizedLimit = Math.min(
      Math.max(parseInt(limit, 10) || 4, 1),
      SUGGEST_MAX_ITEMS,
    );
    const cacheKey = `pt:suggest:${q.toLowerCase()}:${normalizedLimit}`;
    const cachedHit = cache.get(cacheKey);
    if (cachedHit !== undefined) {
      log.debug("prehrajto:suggest cache hit", {
        query: q,
        limit: normalizedLimit,
        count: Array.isArray(cachedHit) ? cachedHit.length : -1,
      });
      return cachedHit;
    }

    const existing = suggestInFlight.get(cacheKey);
    if (existing) {
      log.debug("prehrajto:suggest in-flight hit", { query: q });
      return await existing;
    }

    const work = (async () => {
      const suggestUrl = buildSuggestUrl(q);
      try {
        const { res, text } = await httpGet(suggestUrl, {
          throwOnHttpError: false,
          timeoutMs: 2000,
          headers: {
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
            Referer: buildSearchUrl(q),
          },
        });

        if (!res.ok) {
          log.debug("prehrajto:suggest non-200", {
            query: q,
            status: res.status,
            suggestUrl: sanitizeUrl(suggestUrl),
            ms: elapsedMs(startedAt),
          });
          const fallback = [q];
          cache.set(cacheKey, fallback, { ttl: SUGGEST_TTL_MS });
          return fallback;
        }

        const out = parseSuggestItems(text, q, normalizedLimit);
        cache.set(cacheKey, out, { ttl: SUGGEST_TTL_MS });
        log.debug("prehrajto:suggest ok", {
          query: q,
          limit: normalizedLimit,
          count: out.length,
          ms: elapsedMs(startedAt),
        });
        return out;
      } catch (e) {
        log.debug("prehrajto:suggest request failed", {
          query: q,
          suggestUrl: sanitizeUrl(suggestUrl),
          error: errorMeta(e),
          ms: elapsedMs(startedAt),
        });
        const fallback = [q];
        cache.set(cacheKey, fallback, { ttl: SUGGEST_TTL_MS });
        return fallback;
      }
    })();

    suggestInFlight.set(cacheKey, work);
    try {
      return await work;
    } finally {
      if (suggestInFlight.get(cacheKey) === work) suggestInFlight.delete(cacheKey);
    }
  },

  async search(query, { limit = 20 } = {}) {
    const startedAt = Date.now();
    const q = normalizeSpaces(query);
    if (!q) {
      log.debug("prehrajto:search skipped empty query");
      return [];
    }
    if (Date.now() < searchUnavailableUntil) {
      log.debug("prehrajto:search in cooldown", {
        query: q,
        cooldownMs: searchUnavailableUntil - Date.now(),
      });
      return [];
    }

    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 30);
    const cacheKey = `pt:search:hledej:${q.toLowerCase()}:${normalizedLimit}`;
    const cachedHit = cache.get(cacheKey);
    if (cachedHit !== undefined) {
      log.debug("prehrajto:search cache hit", {
        query: q,
        limit: normalizedLimit,
        count: Array.isArray(cachedHit) ? cachedHit.length : -1,
      });
      return cachedHit;
    }

    const existing = searchInFlight.get(cacheKey);
    if (existing) {
      log.debug("prehrajto:search in-flight hit", { query: q });
      return await existing;
    }

    const work = (async () => {
      const variants = buildSearchVariants(q);
      let hadHttpResponse = false;

      for (const variant of variants) {
        const searchUrl = buildSearchUrl(variant);
        let res;
        let text;

        try {
          ({ res, text } = await httpGet(searchUrl, {
            throwOnHttpError: false,
            timeoutMs: 5000,
            headers: {
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
              "Cache-Control": "no-cache",
              Pragma: "no-cache",
              Referer: searchUrl,
            },
          }));
        } catch (e) {
          log.warn("prehrajto:search request failed", {
            query: q,
            variant,
            searchUrl: sanitizeUrl(searchUrl),
            error: errorMeta(e),
          });
          continue;
        }

        hadHttpResponse = true;
        log.debug("prehrajto:search response", {
          query: q,
          variant,
          status: res.status,
          bodyLen: text.length,
        });

        if (!res.ok) {
          log.warn("prehrajto:search non-200", {
            query: q,
            variant,
            status: res.status,
            searchUrl: sanitizeUrl(searchUrl),
          });
          continue;
        }

        const out = parseSearchResultsHtml(text, normalizedLimit);
        log.info("prehrajto:search parsed", {
          query: q,
          variant,
          limit: normalizedLimit,
          results: out.length,
          ms: elapsedMs(startedAt),
        });

        if (out.length > 0) {
          cache.set(cacheKey, out);
          return out;
        }
      }

      searchUnavailableUntil = Date.now() + (
        hadHttpResponse ? SEARCH_ERROR_COOLDOWN_MS : SEARCH_UNAVAILABLE_COOLDOWN_MS
      );
      cache.set(cacheKey, [], { ttl: EMPTY_SEARCH_TTL_MS });
      log.info("prehrajto:search no results", {
        query: q,
        variants,
        hadHttpResponse,
        ms: elapsedMs(startedAt),
      });
      return [];
    })();

    searchInFlight.set(cacheKey, work);
    try {
      return await work;
    } finally {
      if (searchInFlight.get(cacheKey) === work) searchInFlight.delete(cacheKey);
    }
  },

  async resolveStream(videoPageUrl, { email, password, premium } = {}) {
    const startedAt = Date.now();
    try {
      log.debug("prehrajto:resolve start", {
        pageUrl: sanitizeUrl(videoPageUrl),
        premium: Boolean(premium),
        hasEmail: Boolean(email),
      });
      const resolveCacheKey = premium
        ? `pt:resolve:premium:${videoPageUrl}:${email || ""}`
        : `pt:resolve:free:${videoPageUrl}`;
      const resolveCached = cache.get(resolveCacheKey);
      if (resolveCached !== undefined) {
        log.debug("prehrajto:resolve cache hit", {
          pageUrl: sanitizeUrl(videoPageUrl),
          hitIsNull: resolveCached === null,
        });
        return resolveCached;
      }

      let cookie = null;
      if (premium) cookie = await premiumLogin(email, password);

      if (premium && cookie) {
        const direct = await premiumDownloadRedirect(videoPageUrl, cookie);
        if (direct) {
          log.info("prehrajto:resolve premium redirect", {
            pageUrl: sanitizeUrl(videoPageUrl),
            streamUrl: sanitizeUrl(direct),
            ms: elapsedMs(startedAt),
          });
          const result = {
            url: direct,
            subtitles: [],
          };
          cache.set(resolveCacheKey, result);
          return result;
        }
      }

      const { text, res } = await httpGet(videoPageUrl, {
        headers: cookie ? { Cookie: cookie } : {},
        throwOnHttpError: false,
        timeoutMs: 5000,
      });
      log.debug("prehrajto:resolve page response", {
        pageUrl: sanitizeUrl(videoPageUrl),
        status: res.status,
        bodyLen: text.length,
      });
      if (!res.ok) {
        log.warn("prehrajto:resolve page non-200", {
          pageUrl: sanitizeUrl(videoPageUrl),
          status: res.status,
        });
        cache.set(resolveCacheKey, null);
        return null;
      }

      const sources = parseVideoSources(text);
      const subs = parseSubtitles(text);
      log.debug("prehrajto:resolve extracted", {
        pageUrl: sanitizeUrl(videoPageUrl),
        sources: sources.length,
        subtitles: subs.length,
      });

      const best =
        sources.find((u) => /\.m3u8(\?|$)/i.test(u)) ||
        sources.find((u) => /\.mp4(\?|$)/i.test(u)) ||
        sources[0];

      if (!best) {
        log.info("prehrajto:resolve no playable source", {
          pageUrl: sanitizeUrl(videoPageUrl),
          ms: elapsedMs(startedAt),
        });
        cache.set(resolveCacheKey, null);
        return null;
      }

      const result = { url: best, subtitles: subs };
      cache.set(resolveCacheKey, result);
      log.info("prehrajto:resolve success", {
        pageUrl: sanitizeUrl(videoPageUrl),
        streamUrl: sanitizeUrl(best),
        subtitles: subs.length,
        ms: elapsedMs(startedAt),
      });
      return result;
    } catch (e) {
      log.warn("prehrajto:resolve failed", {
        pageUrl: sanitizeUrl(videoPageUrl),
        error: errorMeta(e),
        ms: elapsedMs(startedAt),
      });
      return null;
    }
  },
};
