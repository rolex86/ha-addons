import { ENV } from "../env.js";
import { cache } from "../utils/cache.js";
import { httpGet, httpPost } from "../utils/http.js";

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

function parseSearchResults(html) {
  // This parser is intentionally tolerant. You will tune selectors as needed.
  // We look for list items containing links to /video/ or similar.
  const items = [];

  // Example: <a href="/video/12345-nazev">Title</a>
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi;

  let m;
  while ((m = linkRe.exec(html))) {
    const href = m[1];
    if (!href) continue;

    // heuristics: video pages usually contain "/video/" or "/v/"
    if (!/\/video\/|\/v\//i.test(href)) continue;

    const title = stripTags(m[2] || "").trim();
    if (!title) continue;

    // Try year extraction from title
    const yearMatch = /\b(19|20)\d{2}\b/.exec(title);
    const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
    const absUrl = absolutizeHttpUrl(href);
    if (!absUrl) continue;

    items.push({
      title,
      year,
      url: absUrl,
    });
  }

  // Deduplicate by url
  const uniq = new Map();
  for (const it of items) uniq.set(it.url, it);
  return Array.from(uniq.values());
}

function hasMore(html) {
  // Kodi addon uses "pagination-more" marker; keep similar heuristic
  return (
    /pagination-more/i.test(html) || (/next/i.test(html) && /page/i.test(html))
  );
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "");
}

function absolutizeHttpUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw, ENV.PREHRAJTO_BASE).toString();
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
  async search(query, { limit = 20, maxPages = 5 } = {}) {
    const out = [];
    let page = 1;

    while (out.length < limit && page <= maxPages) {
      const url = new URL(`${ENV.PREHRAJTO_BASE}/hledat`);
      url.searchParams.set("q", query);
      url.searchParams.set("vp-page", String(page));

      const { text } = await httpGet(url.toString());
      const items = parseSearchResults(text);
      for (const it of items) {
        out.push(it);
        if (out.length >= limit) break;
      }

      if (!hasMore(text)) break;
      page++;
    }

    return out.slice(0, limit);
  },

  async resolveStream(videoPageUrl, { email, password, premium } = {}) {
    // Optionally premium redirect
    let cookie = null;
    if (premium) cookie = await premiumLogin(email, password);

    if (premium && cookie) {
      const direct = await premiumDownloadRedirect(videoPageUrl, cookie);
      if (direct) {
        return {
          url: direct,
          subtitles: [], // premium direct may not expose subs; can still parse page if needed
        };
      }
      // fallback to normal parsing if no redirect
    }

    const { text } = await httpGet(videoPageUrl, {
      headers: cookie ? { Cookie: cookie } : {},
    });

    const sources = parseVideoSources(text);
    const subs = parseSubtitles(text);

    // pick first plausible mp4/m3u8
    const best =
      sources.find((u) => /\.m3u8(\?|$)/i.test(u)) ||
      sources.find((u) => /\.mp4(\?|$)/i.test(u)) ||
      sources[0];

    if (!best) return null;

    return { url: best, subtitles: subs };
  },
};
