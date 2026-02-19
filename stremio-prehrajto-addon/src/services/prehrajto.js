import { ENV } from "../env.js";
import { cache } from "../utils/cache.js";
import { httpGet, httpPost } from "../utils/http.js";

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
  if (cachedCookie) return cachedCookie;

  // NOTE: Login form fields can differ; this is common pattern.
  // If prehraj.to uses different endpoint/fields, adjust here.
  const loginUrl = `${ENV.PREHRAJTO_BASE}/prihlaseni`;
  const body = new URLSearchParams({
    email,
    password,
  }).toString();

  const { res } = await httpPost(loginUrl, body, {
    redirect: "manual",
    throwOnHttpError: false,
  });
  const cookie = extractSetCookies(res);

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
    return [];
  }

  const found = [];
  const queue = [];
  const seenObjects = new Set();
  const MAX_SCAN_NODES = 3000;
  const MAX_DEPTH = 5;

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
  while (queue.length > 0 && scanned < MAX_SCAN_NODES && found.length < limit) {
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

  const uniq = new Map();
  for (const item of found) {
    if (!uniq.has(item.url)) uniq.set(item.url, item);
    if (uniq.size >= limit) break;
  }

  return Array.from(uniq.values()).slice(0, limit);
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

  const { res } = await httpGet(u.toString(), {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: "manual",
    throwOnHttpError: false,
  });

  const loc = res.headers.get("location");
  if (loc && /^https?:\/\//i.test(loc)) return loc;
  return null;
}

export const PREHRAJTO = {
  async search(query, { limit = 20 } = {}) {
    const q = String(query || "").trim();
    if (!q) return [];
    if (Date.now() < searchUnavailableUntil) return [];

    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 30);
    const cacheKey = `pt:search:suggest:${q.toLowerCase()}:${normalizedLimit}`;
    const cachedHit = cache.get(cacheKey);
    if (cachedHit !== undefined) return cachedHit;

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
    } catch {
      searchUnavailableUntil = Date.now() + SUGGEST_UNAVAILABLE_COOLDOWN_MS;
      cache.set(cacheKey, []);
      return [];
    }

    if (!res.ok) {
      searchUnavailableUntil = Date.now() + SUGGEST_ERROR_COOLDOWN_MS;
      cache.set(cacheKey, []);
      return [];
    }

    let out;
    try {
      out = parseSuggestResponse(text, normalizedLimit);
    } catch {
      searchUnavailableUntil = Date.now() + SUGGEST_UNAVAILABLE_COOLDOWN_MS;
      cache.set(cacheKey, []);
      return [];
    }
    cache.set(cacheKey, out);
    return out;
  },

  async resolveStream(videoPageUrl, { email, password, premium } = {}) {
    try {
      const resolveCacheKey = premium
        ? `pt:resolve:premium:${videoPageUrl}:${email || ""}`
        : `pt:resolve:free:${videoPageUrl}`;
      const resolveCached = cache.get(resolveCacheKey);
      if (resolveCached !== undefined) return resolveCached;

      // Optionally premium redirect
      let cookie = null;
      if (premium) cookie = await premiumLogin(email, password);

      if (premium && cookie) {
        const direct = await premiumDownloadRedirect(videoPageUrl, cookie);
        if (direct) {
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
      if (!res.ok) {
        cache.set(resolveCacheKey, null);
        return null;
      }

      const sources = parseVideoSources(text);
      const subs = parseSubtitles(text);

      // pick first plausible mp4/m3u8
      const best =
        sources.find((u) => /\.m3u8(\?|$)/i.test(u)) ||
        sources.find((u) => /\.mp4(\?|$)/i.test(u)) ||
        sources[0];

      if (!best) {
        cache.set(resolveCacheKey, null);
        return null;
      }

      const result = { url: best, subtitles: subs };
      cache.set(resolveCacheKey, result);
      return result;
    } catch {
      return null;
    }
  },
};
