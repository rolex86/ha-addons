import crypto from "crypto";
import * as cheerio from "cheerio";

const SOSAC_SEARCH = "http://tv.sosac.to/jsonsearchapi.php?q=";
const STREAMUJ_PAGE = "https://www.streamuj.tv/video/";

// simple helper
async function getJson(url, fetchImpl) {
  const doFetch = fetchImpl ?? fetch;
  const res = await doFetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

function md5hex(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

/**
 * Streamuj premium params based on Kodi addon logic:
 * pass = user + ":::" + md5(md5(pass))
 * + location (1/2)
 */
export function addStreamujPremiumParams(url, { user, pass, location }) {
  if (!user || !pass) return url;
  const hashed = md5hex(md5hex(pass));
  const u = new URL(url);
  u.searchParams.set("pass", `${user}:::${hashed}`);
  if (location) u.searchParams.set("location", String(location));
  return u.toString();
}

function uaHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.7",
    "Accept-Encoding": "identity",
  };
}

function pickAuthorizeToken(html) {
  // 1) most common: somewhere in HTML is "authorize=<hex>"
  let m = html.match(/authorize=([a-f0-9]{16,64})/i);
  if (m) return m[1];

  // 2) fallback: in JS as authorize:"...." or authorize='...'
  m = html.match(/authorize["']?\s*[:=]\s*["']([a-f0-9]{16,64})["']/i);
  if (m) return m[1];

  return null;
}

function normalizeQuality(q) {
  const s = String(q ?? "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s === "hd" || s === "sd" || s === "original") return s;
  if (s.includes("hd")) return "hd";
  if (s.includes("sd")) return "sd";
  if (s.includes("orig")) return "original";
  return s;
}

function labelFromQuality(q) {
  const s = String(q ?? "")
    .trim()
    .toLowerCase();
  if (s === "hd") return "HD";
  if (s === "sd") return "SD";
  if (s === "original") return "Original";
  return s ? s.toUpperCase() : "Auto";
}

async function resolveFinalUrlByRedirect(url, { referer, fetch: fetchImpl }) {
  // Try HEAD first; if server rejects, fallback to GET with Range
  const headers = { ...uaHeaders(), ...(referer ? { Referer: referer } : {}) };
  const doFetch = fetchImpl ?? fetch;

  console.log(`[stream] redirect start ${url}`);

  // HEAD
  try {
    console.log(`[stream] redirect HEAD ${url}`);
    const r = await doFetch(url, { method: "HEAD", redirect: "follow", headers });
    console.log(`[stream] redirect HEAD done status=${r.status} url=${r.url}`);
    if (r.ok && r.url && r.url !== url) return r.url;
    if (r.url) return r.url;
  } catch (e) {
    console.warn(`[stream] redirect HEAD error ${url}`);
  }

  // GET with small Range (avoid full download)
  const headers2 = { ...headers, Range: "bytes=0-0" };
  console.log(`[stream] redirect GET ${url}`);
  const r2 = await doFetch(url, {
    method: "GET",
    redirect: "follow",
    headers: headers2,
  });
  console.log(`[stream] redirect GET done status=${r2.status} url=${r2.url}`);
  return r2.url ?? url;
}

function guessQualityFromUrl(u) {
  const s = String(u).toLowerCase();
  if (s.includes("_hd.")) return "HD";
  if (s.includes("_sd.")) return "SD";
  if (s.includes("original")) return "Original";
  return "Auto";
}

/**
 * On-demand: find Sosac item by text search and match it by imdbId.
 * Returns { imdbId, title, year, streamujId, raw } or null
 */
export async function sosacFindByImdb({ imdbId, title, year, log, fetch: fetchImpl }) {
  if (!title) throw new Error("Missing title for Sosac search");

  const q = encodeURIComponent(title);
  const url = `${SOSAC_SEARCH}${q}`;
  const results = await getJson(url, fetchImpl);

  // results can be various shapes; often array of items
  const items = Array.isArray(results) ? results : (results?.items ?? []);

  const normImdb = (x) =>
    String(x ?? "")
      .trim()
      .toLowerCase()
      .replace(/^tt/, "");
  const target = normImdb(imdbId);

  // 1) exact match by m == imdbId (without tt)
  let hit = items.find((it) => normImdb(it?.m) === target);

  // 2) fallback: title + year (risky)
  if (!hit && year) {
    const norm = (s) =>
      String(s ?? "")
        .trim()
        .toLowerCase();
    const pickTitle = (it) =>
      typeof it?.n === "string" ? it.n : (it?.n?.cs ?? it?.n?.en ?? "");
    hit = items.find(
      (it) =>
        norm(pickTitle(it)) === norm(title) &&
        String(it?.y ?? "") === String(year),
    );
  }

  if (!hit) {
    log?.debug?.(`Sosac: no match for imdb=${imdbId} title="${title}"`);
    return null;
  }

  const streamujId = hit?.l ? String(hit.l) : null;
  if (!streamujId) return null;

  const displayTitle =
    typeof hit?.n === "string" ? hit.n : (hit?.n?.cs ?? hit?.n?.en ?? title);

  return {
    imdbId,
    title: displayTitle,
    year: hit?.y ?? year,
    streamujId,
    quality: normalizeQuality(hit?.q),
    raw: hit,
  };
}

/**
 * Resolve Streamuj page -> final stream URL(s).
 * Returns [{ url, quality, headers? }]
 */
export async function streamujResolve({ streamujId, log, preferredQuality, fetch: fetchImpl, user, pass, location, uid }) {
  const pageUrl = `${STREAMUJ_PAGE}${encodeURIComponent(streamujId)}`;
  const doFetch = fetchImpl ?? fetch;

  console.log(`[stream] step 1 fetch video page ${pageUrl}`);

  // 1) fetch HTML page
  const pageRes = await doFetch(pageUrl, {
    redirect: "follow",
    headers: uaHeaders(),
  });
  if (!pageRes.ok) throw new Error(`Streamuj page HTTP ${pageRes.status}`);
  const enc = pageRes.headers.get("content-encoding");
  const len = pageRes.headers.get("content-length");
  console.log(`[stream] headers: enc=${enc || "-"} len=${len || "-"}`);

  console.log("[stream] step 1b read body start");
  const tBody = Date.now();
  const ab = await pageRes.arrayBuffer();
  const html = Buffer.from(ab).toString("utf-8");
  console.log(
    `[stream] step 1c read body done len=${html.length} in ${Date.now() - tBody}ms`,
  );
  console.log(
    `[stream] html head: ${html.slice(0, 200).replace(/\s+/g, " ")}`,
  );

  console.log("[stream] step 2 parse start");

  // 2) extract authorize token
  let authorize = pickAuthorizeToken(html);

  // 2b) fallback: sometimes token is hidden in DOM links
  if (!authorize) {
    const $ = cheerio.load(html);
    const links = [];
    $("a, script").each((_, el) => {
      const href = $(el).attr("href");
      const src = $(el).attr("src");
      if (href) links.push(href);
      if (src) links.push(src);
    });
    for (const l of links) {
      const m = String(l).match(/authorize=([a-f0-9]{16,64})/i);
      if (m) {
        authorize = m[1];
        break;
      }
    }
  }

  console.log("[stream] step 2 parse done");
  console.log(`[stream] parsed: authorize=${authorize || "-"}`);

  // Fallback: token via JSON API (video-link)
  async function fetchAuthorizeForQuality(q) {
    if (!user || !pass || !uid) return null;
    const apiUrl =
      `https://www.streamuj.tv/json_api.php?action=video-link` +
      `&URL=${encodeURIComponent(pageUrl + "?streamuj=" + q)}` +
      `&UID=${encodeURIComponent(String(uid))}`;

    console.log("[stream] step 2b fetch video-link api");
    const apiRes = await doFetch(apiUrl, {
      headers: {
        ...uaHeaders(),
        "X-Requested-With": "XMLHttpRequest",
        Referer: pageUrl,
        "Accept-Encoding": "identity",
      },
      redirect: "follow",
    });

    const ab = await apiRes.arrayBuffer();
    const txt = Buffer.from(ab).toString("utf-8");
    let js;
    try {
      js = JSON.parse(txt);
    } catch {
      js = null;
    }

    const auth =
      js?.authorize ||
      js?.data?.authorize ||
      js?.result?.authorize ||
      (typeof txt === "string"
        ? (txt.match(/"authorize"\s*:\s*"([^"]+)"/)?.[1] ?? null)
        : null);

    console.log(`[stream] parsed (api): authorize=${auth ? "yes" : "no"}`);
    return auth;
  }

  function snippetAround(s, needle, radius = 120) {
    const i = s.indexOf(needle);
    if (i == -1) return null;
    const start = Math.max(0, i - radius);
    const end = Math.min(s.length, i + needle.length + radius);
    return s.slice(start, end).replace(/\s+/g, " ");
  }

  const needles = ["authorize", "token", "auth", "sources", "playlist", "file", "m3u8", "mp4"];
  for (const n of needles) {
    const sn = snippetAround(html, n);
    if (sn) console.log(`[stream] html snippet (${n}): ${sn}`);
  }

  if (!authorize && (!user || !pass || !uid)) {
    log?.warn?.(`Streamuj: authorize token not found for id=${streamujId}`);
    return [];
  }

  // 3) try several quality profiles
  // Prefer highest quality first, but allow fallback to lower ones.
  const order = ["original", "hd", "sd"];
  const pref = normalizeQuality(preferredQuality);
  const qualities = order.map((q) => ({ q, label: labelFromQuality(q) }));
  if (pref && !order.includes(pref)) {
    qualities.push({ q: pref, label: labelFromQuality(pref) });
  }

  const out = [];
  for (const it of qualities) {
    let authForQ = authorize;
    if (user && pass && uid) {
      authForQ = await fetchAuthorizeForQuality(it.q) || authorize;
    }

    if (!authForQ) {
      log?.warn?.(`Streamuj: authorize missing for quality=${it.q} id=${streamujId}`);
      continue;
    }

    let url = `${pageUrl}?streamuj=${encodeURIComponent(
      it.q,
    )}&authorize=${encodeURIComponent(authForQ)}`;
    if (uid) url += `&UID=${encodeURIComponent(String(uid))}`;
    url = addStreamujPremiumParams(url, { user, pass, location });

    // get final CDN link via redirect
    console.log(`[stream] resolve start quality=${it.q}`);
    const finalUrl = await resolveFinalUrlByRedirect(url, {
      referer: pageUrl,
      fetch: fetchImpl,
    });
    console.log(`[stream] resolve done quality=${it.q} url=${finalUrl || "-"}`);

    // sanity: ignore if still on /video/...
    if (!finalUrl || finalUrl.includes("/video/")) {
      console.log(`[stream] resolve skip quality=${it.q} url=${finalUrl || "-"}`);
      continue;
    }

    out.push({
      url: finalUrl,
      quality: it.label || guessQualityFromUrl(finalUrl),
      headers: {
        Referer: pageUrl,
        "User-Agent": uaHeaders()["User-Agent"],
      },
    });

    // First successful quality wins; lower qualities are fallback only.
    if (out.length) break;
  }

  // de-dupe
  const uniq = [];
  const seen = new Set();
  for (const s of out) {
    if (!seen.has(s.url)) {
      seen.add(s.url);
      uniq.push(s);
    }
  }

  if (!uniq.length) {
    log?.warn?.(
      `Streamuj: resolved 0 streams for id=${streamujId} (authorize ok)`,
    );
  }

  return uniq;
}
