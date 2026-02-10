import express from "express";
import cors from "cors";
import { Cache } from "./cache.js";
import {
  sosacFindByImdb,
  streamujResolve,
  addStreamujPremiumParams,
} from "./sosac.js";

const PORT = Number(process.env.PORT ?? 7123);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const CACHE_TTL_DAYS = Number(process.env.CACHE_TTL_DAYS ?? 14);
const NEG_CACHE_TTL_HOURS = Number(process.env.NEG_CACHE_TTL_HOURS ?? 12);

const STREAMUJ_USER = process.env.STREAMUJ_USER ?? "";
const STREAMUJ_PASS = process.env.STREAMUJ_PASS ?? "";
const STREAMUJ_LOCATION = Number(process.env.STREAMUJ_LOCATION ?? 1);
const STREAMUJ_UID = Number(process.env.STREAMUJ_UID ?? 0) || undefined;

const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const log = {
  debug: (...a) =>
    ["trace", "debug"].includes(LOG_LEVEL)
      ? console.log("[D]", ...a)
      : undefined,
  info: (...a) =>
    ["trace", "debug", "info", "notice"].includes(LOG_LEVEL)
      ? console.log("[I]", ...a)
      : undefined,
  warn: (...a) => console.warn("[W]", ...a),
  error: (...a) => console.error("[E]", ...a),
};

const cache = new Cache({
  dataDir: DATA_DIR,
  ttlDays: CACHE_TTL_DAYS,
  negativeTtlHours: NEG_CACHE_TTL_HOURS,
  log,
});
cache.load();

const app = express();

app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.url}`);
  next();
});

const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS", "HEAD"],
  allowedHeaders: ["Content-Type"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("pass")) u.searchParams.set("pass", "<redacted>");
    if (u.searchParams.has("URL")) {
      try {
        const nested = new URL(u.searchParams.get("URL"));
        if (nested.searchParams.has("pass")) {
          nested.searchParams.set("pass", "<redacted>");
        }
        u.searchParams.set("URL", nested.toString());
      } catch (_) {
        // ignore nested URL parse errors
      }
    }
    return u.toString();
  } catch (_) {
    return String(url);
  }
}

async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const safeUrl = redactUrl(url);
  console.log(`[stream] fetch: ${safeUrl}`);
  const t0 = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    console.log(
      `[stream] fetch done: ${safeUrl} status=${r.status} in ${Date.now() - t0}ms`,
    );
    return r;
  } catch (e) {
    console.warn(
      `[stream] fetch error: ${safeUrl} after ${Date.now() - t0}ms`,
    );
    throw e;
  } finally {
    clearTimeout(t);
  }
}


app.get("/", (_req, res) =>
  res.json({ ok: true, name: "sosac-stremio-addon", version: "0.2.5" }),
);

// --- Stremio manifest ---
app.get("/manifest.json", (_req, res) => {
  res.json({
    id: "org.local.sosac",
    version: "0.2.5",
    name: "Sosac (local)",
    description: "Sosac -> StreamujTV (on-demand + cache)",
    resources: [
      {
        name: "stream",
        types: ["movie", "series"],
        idPrefixes: ["tt"],
      },
    ],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
  });
});

// --- Helpers ---
async function fetchCinemetaMeta(type, imdbId, { fetch: fetchImpl } = {}) {
  // Stremio Cinemeta v3 endpoint
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const doFetch = fetchImpl ?? fetch;
  const res = await doFetch(url, {
    headers: { "User-Agent": "StremioAddon/0.1" },
  });
  if (!res.ok) throw new Error(`Cinemeta meta HTTP ${res.status}`);
  const j = await res.json();
  return j?.meta ?? null;
}

function parseStremioId(type, id) {
  // movie: tt123
  // series episode často: tt123:1:3
  const parts = String(id).split(":");
  const imdbId = parts[0];
  const season = parts.length >= 2 ? Number(parts[1]) : null;
  const episode = parts.length >= 3 ? Number(parts[2]) : null;
  return { imdbId, season, episode, type };
}

// --- Stream endpoint ---
app.get("/stream/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  const t0 = Date.now();

  const HARD_TIMEOUT_MS = 18000;
  const hard = setTimeout(() => {
    if (!res.headersSent) {
      console.warn(
        `[stream] HARD TIMEOUT ${type}/${id} after ${Date.now() - t0}ms`,
      );
      res.status(200).json({ streams: [] });
    }
  }, HARD_TIMEOUT_MS);

  console.log(`[stream] start ${type}/${id}`);

  try {
    const parsed = parseStremioId(type, id);

    // MVP: movies OK, series zatim vrati prazdno (resolver epizod doplnime)
    if (parsed.type === "series" && (parsed.season || parsed.episode)) {
      console.log(
        `[stream] done ${type}/${id} streams=0 in ${Date.now() - t0}ms`,
      );
      return res.json({ streams: [] });
    }

    const cacheKey = `imdb:${parsed.imdbId}`;
    const cached = cache.get(cacheKey);

    if (cached?.kind === "negative") {
      console.log(
        `[stream] done ${type}/${id} streams=0 in ${Date.now() - t0}ms`,
      );
      return res.json({ streams: [] });
    }

    let mapping = cached?.kind === "positive" ? cached : null;

    if (!mapping) {
      const meta = await fetchCinemetaMeta("movie", parsed.imdbId, {
        fetch: fetchWithTimeout,
      });
      if (!meta) throw new Error("Cinemeta meta not found");

      const title = meta.name;
      const year = meta.year;

      const found = await sosacFindByImdb({
        imdbId: parsed.imdbId,
        title,
        year,
        log,
        fetch: fetchWithTimeout,
      });

      if (!found) {
        cache.setNegative(cacheKey, "sosac_not_found");
        console.log(
          `[stream] done ${type}/${id} streams=0 in ${Date.now() - t0}ms`,
        );
        return res.json({ streams: [] });
      }

      mapping = {
        streamujId: found.streamujId,
        title: found.title,
        year: found.year,
        quality: found.quality ?? null,
      };
      cache.setPositive(cacheKey, mapping);
    }

    // Resolve streamuj -> final stream(s)
    const resolved = await streamujResolve({
      streamujId: mapping.streamujId,
      log,
      preferredQuality: mapping.quality,
      fetch: fetchWithTimeout,
      user: STREAMUJ_USER,
      pass: STREAMUJ_PASS,
      location: STREAMUJ_LOCATION,
      uid: STREAMUJ_UID,
    });

    // Apply premium params if configured
    const premiumCfg = {
      user: STREAMUJ_USER,
      pass: STREAMUJ_PASS,
      location: STREAMUJ_LOCATION,
      uid: STREAMUJ_UID,
    };
    const streams = resolved.map((s) => {
      const finalUrl = addStreamujPremiumParams(s.url, premiumCfg);
      const proxyRequestHeaders = s.headers
        ? Object.fromEntries(
            Object.entries({
              Referer: s.headers.Referer,
              "User-Agent": s.headers["User-Agent"],
              Cookie: s.headers.Cookie,
            }).filter(([, v]) => Boolean(v)),
          )
        : {};

      return {
        name: `Sosac - ${s.quality ?? "Auto"}`,
        title: mapping.title ? `${mapping.title}` : "Sosac",
        url: finalUrl,
        behaviorHints: {
          // casto pomuze pro m3u8
          notWebReady: false,
          ...(Object.keys(proxyRequestHeaders).length
            ? { proxyHeaders: { request: proxyRequestHeaders } }
            : {}),
        },
        ...(s.headers ? { headers: s.headers } : {}),
      };
    });

    console.log(
      `[stream] done ${type}/${id} streams=${streams?.length ?? 0} in ${Date.now() - t0}ms`,
    );
    return res.json({ streams });
  } catch (e) {
    console.error(
      `[stream] error ${type}/${id} after ${Date.now() - t0}ms`,
      e,
    );
    return res.status(200).json({ streams: [] });
  } finally {
    clearTimeout(hard);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  log.info(`Listening on :${PORT}`);
  log.info(`Cache file: ${DATA_DIR}/cache.json`);
});
