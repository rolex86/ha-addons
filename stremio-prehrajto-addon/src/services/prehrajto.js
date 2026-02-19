import { ENV } from "../env.js";
import { cache } from "../utils/cache.js";
import { httpGet, httpPost } from "../utils/http.js";
import { elapsedMs, errorMeta, log, sanitizeUrl } from "../utils/log.js";

const SUGGEST_UNAVAILABLE_COOLDOWN_MS = 30_000;
const SUGGEST_ERROR_COOLDOWN_MS = 60_000;

let searchUnavailableUntil = 0;

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

  // NOTE: Login form fields can differ; this is common pattern.
  // If prehraj.to uses different endpoint/fields, adjust here.
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

  // naive success: got some cookie; if not, return null
  if (cookie && cookie.length > 0) {
    cache.set(cacheKey, cookie);
    return cookie;
  }
  return null;
}

function buildSuggestUrl(query) {
  const base = ENV.PREHRAJTO_BASE.replace(/\/+$/g, "");
  return `${base}/api/v1/public/suggest/${encodeURIComponent(query)}`;
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "");
}

function parseYear(text) {
  const yearMatch = /\b(19|20)\d{2}\b/.exec(String(text || ""));
  if (!yearMatch) return null;
  return parseInt(yearMatch[0], 10);
}

function pickFirstString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const trimmed = String(value).trim();
    if (trimmed) return trimmed;
  }
  return "";
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
    // modern prehraj pages often end with a long id/hash segment
    if (/^[a-z0-9]{8,}$/i.test(last)) return true;
  }

  return false;
}

function parseSuggestItem(raw) {
  if (!raw || typeof raw !== "object") return null;

  let href = pickFirstString(raw, [
    "url",
    "href",
    "link",
    "videoUrl",
    "video_url",
    "detailUrl",
    "detail_url",
    "path",
    "route",
    "uri",
  ]);

  if (!href) {
    const slug = pickFirstString(raw, [
      "slug",
      "seo",
      "name_slug",
      "url_slug",
      "slug_name",
    ]);
    const id = pickFirstString(raw, [
      "id",
      "uid",
      "hash",
      "videoId",
      "video_id",
      "hash_id",
      "video_hash",
    ]);
    if (slug && id) href = `/${slug}/${id}`;
  }

  if (!href) {
    for (const value of Object.values(raw)) {
      if (typeof value !== "string") continue;
      const candidate = value.trim();
      if (candidate && isLikelyVideoHref(candidate)) {
        href = candidate;
        break;
      }
    }
  }

  const absUrl = absolutizeHttpUrl(href);
  if (!absUrl || !isLikelyVideoHref(absUrl)) return null;

  const rawTitle = pickFirstString(raw, [
    "title",
    "name",
    "label",
    "text",
    "displayName",
    "display_name",
    "fullName",
    "full_name",
    "value",
  ]);
  const title = stripTags(rawTitle).replace(/\s+/g, " ").trim() || inferTitleFromUrl(absUrl);
  if (!title) return null;

  const rawYear = pickFirstString(raw, [
    "year",
    "releaseYear",
    "release_year",
    "createdYear",
    "created_year",
  ]);

  return {
    title,
    year: parseYear(rawYear || title),
    url: absUrl,
  };
}

function parseSuggestResponse(text, limit) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      items: [],
      scannedNodes: 0,
      maxQueueSize: 0,
      parseError: true,
      hitScanLimit: false,
    };
  }

  const found = [];
  const queue = [];
  const seenObjects = new Set();
  const MAX_SCAN_NODES = 1000;
  const MAX_DEPTH = 5;
  let maxQueueSize = queue.length;

  if (data && typeof data === "object") {
    queue.push({ node: data, depth: 0 });
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const key of [
      "data",
      "results",
      "result",
      "items",
      "suggestions",
      "videos",
      "records",
      "hits",
      "payload",
    ]) {
      const v = data[key];
      if (v && typeof v === "object") {
        queue.push({ node: v, depth: 1 });
      }
    }
  }

  let scanned = 0;
  let hitScanLimit = false;
  while (queue.length > 0 && scanned < MAX_SCAN_NODES && found.length < limit) {
    if (queue.length > maxQueueSize) maxQueueSize = queue.length;
    const { node, depth } = queue.shift();
    if (!node || typeof node !== "object") continue;
    if (seenObjects.has(node)) continue;
    seenObjects.add(node);
    scanned += 1;

    if (Array.isArray(node)) {
      if (depth >= MAX_DEPTH) continue;
      for (const item of node) {
        if (item && typeof item === "object") {
          queue.push({ node: item, depth: depth + 1 });
        }
      }
      continue;
    }

    const parsed = parseSuggestItem(node);
    if (parsed) found.push(parsed);

    if (depth >= MAX_DEPTH) continue;
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        queue.push({ node: value, depth: depth + 1 });
      }
    }
  }
  if (scanned >= MAX_SCAN_NODES && queue.length > 0) {
    hitScanLimit = true;
  }

  const uniq = new Map();
  for (const item of found) {
    if (!uniq.has(item.url)) uniq.set(item.url, item);
    if (uniq.size >= limit) break;
  }

  return {
    items: Array.from(uniq.values()).slice(0, limit),
    scannedNodes: scanned,
    maxQueueSize,
    parseError: false,
    hitScanLimit,
  };
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

function parseVideoSources(html) {
  // Robust-ish extraction:
  // - file: "https://..."
  // - src: "https://..."
  const urls = new Set();
  const addUrl = (u) => {
    const abs = absolutizeHttpUrl(u);
    if (abs) urls.add(abs);
  };

  const fileRe = /file\s*:\s*"([^"]+)"/gi;
  const srcRe = /src\s*:\s*"([^"]+)"/gi;

  let m;
  while ((m = fileRe.exec(html))) addUrl(m[1]);
  while ((m = srcRe.exec(html))) {
    addUrl(m[1]);
  }

  // sometimes <source src="...">
  const sourceTagRe = /<source[^>]+src="([^"]+)"/gi;
  while ((m = sourceTagRe.exec(html))) addUrl(m[1]);

  // fallback: direct absolute media URLs embedded anywhere in scripts
  const mediaRe = /(https?:\/\/[^"' ]+\.(?:mp4|m3u8)(?:\?[^"' ]*)?)/gi;
  while ((m = mediaRe.exec(html))) addUrl(m[1]);

  // escaped JS URLs: https:\/\/...\.mp4
  const escapedMediaRe =
    /(https?:\\\/\\\/[^"' ]+\.(?:mp4|m3u8)(?:\?[^"' ]*)?)/gi;
  while ((m = escapedMediaRe.exec(html))) {
    const unescaped = m[1].replace(/\\\//g, "/");
    addUrl(unescaped);
  }

  return Array.from(urls);
}

function parseSubtitles(html) {
  // Try to find VTT/subtitle track
  const subs = [];
  // <track kind="captions" src="..." srclang="cs">
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

  // JS player tracks: { file: "...vtt", label: "CZ" }
  const vttRe = /(https?:\/\/[^"' ]+\.vtt)/gi;
  while ((m = vttRe.exec(html))) {
    const abs = absolutizeHttpUrl(m[1]);
    if (abs) subs.push({ url: abs, lang: "und" });
  }

  // de-dupe
  const uniq = new Map();
  for (const s of subs) uniq.set(`${s.lang}:${s.url}`, s);
  return Array.from(uniq.values());
}

async function premiumDownloadRedirect(videoPageUrl, cookie) {
  // Premium download: add ?do=download and read redirect Location
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
  async search(query, { limit = 20 } = {}) {
    const startedAt = Date.now();
    const q = String(query || "").trim();
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
    const cacheKey = `pt:search:suggest:${q.toLowerCase()}:${normalizedLimit}`;
    const cachedHit = cache.get(cacheKey);
    if (cachedHit !== undefined) {
      log.debug("prehrajto:search cache hit", {
        query: q,
        limit: normalizedLimit,
        count: Array.isArray(cachedHit) ? cachedHit.length : -1,
      });
      return cachedHit;
    }

    const suggestUrl = buildSuggestUrl(q);
    let res;
    let text;
    try {
      ({ res, text } = await httpGet(suggestUrl, {
        throwOnHttpError: false,
        timeoutMs: 7000,
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          Referer: `${ENV.PREHRAJTO_BASE.replace(/\/+$/g, "")}/`,
        },
      }));
    } catch (e) {
      log.warn("prehrajto:search request failed", {
        query: q,
        suggestUrl: sanitizeUrl(suggestUrl),
        error: errorMeta(e),
      });
      searchUnavailableUntil = Date.now() + SUGGEST_UNAVAILABLE_COOLDOWN_MS;
      cache.set(cacheKey, []);
      return [];
    }
    log.debug("prehrajto:search suggest response", {
      query: q,
      status: res.status,
      bodyLen: text.length,
      ms: elapsedMs(startedAt),
    });

    if (!res.ok) {
      log.warn("prehrajto:search non-200 suggest response", {
        query: q,
        status: res.status,
        suggestUrl: sanitizeUrl(suggestUrl),
      });
      searchUnavailableUntil = Date.now() + SUGGEST_ERROR_COOLDOWN_MS;
      cache.set(cacheKey, []);
      return [];
    }

    let parsed;
    try {
      parsed = parseSuggestResponse(text, normalizedLimit);
    } catch (e) {
      log.warn("prehrajto:search parse failed", {
        query: q,
        error: errorMeta(e),
      });
      searchUnavailableUntil = Date.now() + SUGGEST_UNAVAILABLE_COOLDOWN_MS;
      cache.set(cacheKey, []);
      return [];
    }
    const out = parsed.items;
    log.info("prehrajto:search parsed", {
      query: q,
      limit: normalizedLimit,
      results: out.length,
      scannedNodes: parsed.scannedNodes,
      maxQueueSize: parsed.maxQueueSize,
      hitScanLimit: parsed.hitScanLimit,
      parseError: parsed.parseError,
      ms: elapsedMs(startedAt),
    });
    cache.set(cacheKey, out);
    return out;
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

      // Optionally premium redirect
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
            subtitles: [], // premium direct may not expose subs; can still parse page if needed
          };
          cache.set(resolveCacheKey, result);
          return result;
        }
        // fallback to normal parsing if no redirect
      }

      const { text, res } = await httpGet(videoPageUrl, {
        headers: cookie ? { Cookie: cookie } : {},
        throwOnHttpError: false,
        timeoutMs: 8000,
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

      // pick first plausible mp4/m3u8
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
