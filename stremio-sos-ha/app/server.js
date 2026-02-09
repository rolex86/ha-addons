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

const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS", "HEAD"],
  allowedHeaders: ["Content-Type"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.get("/", (_req, res) =>
  res.json({ ok: true, name: "sosac-stremio-addon", version: "0.1.0" }),
);

// --- Stremio manifest ---
app.get("/manifest.json", (_req, res) => {
  res.json({
    id: "org.local.sosac",
    version: "0.1.0",
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
async function fetchCinemetaMeta(type, imdbId) {
  // Stremio Cinemeta v3 endpoint
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const res = await fetch(url, {
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
  const parsed = parseStremioId(type, id);

  // MVP: movies OK, series zatím vrátí prázdno (resolver epizod doplníme)
  if (parsed.type === "series" && (parsed.season || parsed.episode)) {
    return res.json({ streams: [] });
  }

  const cacheKey = `imdb:${parsed.imdbId}`;
  const cached = cache.get(cacheKey);

  if (cached?.kind === "negative") {
    return res.json({ streams: [] });
  }

  try {
    let mapping = cached?.kind === "positive" ? cached : null;

    if (!mapping) {
      const meta = await fetchCinemetaMeta("movie", parsed.imdbId);
      if (!meta) throw new Error("Cinemeta meta not found");

      const title = meta.name;
      const year = meta.year;

      const found = await sosacFindByImdb({
        imdbId: parsed.imdbId,
        title,
        year,
        log,
      });

      if (!found) {
        cache.setNegative(cacheKey, "sosac_not_found");
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
    });

    // Apply premium params if configured
    const premiumCfg = {
      user: STREAMUJ_USER,
      pass: STREAMUJ_PASS,
      location: STREAMUJ_LOCATION,
    };
    const streams = resolved.map((s) => {
      const finalUrl = addStreamujPremiumParams(s.url, premiumCfg);
      return {
        name: `Sosac • ${s.quality ?? "Auto"}`,
        title: mapping.title ? `${mapping.title}` : "Sosac",
        url: finalUrl,
        behaviorHints: {
          // často pomůže pro m3u8
          notWebReady: false,
        },
        ...(s.headers ? { headers: s.headers } : {}),
      };
    });

    return res.json({ streams });
  } catch (e) {
    log.error(`stream error: ${String(e)}`);
    return res.json({ streams: [] });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  log.info(`Listening on :${PORT}`);
  log.info(`Cache file: ${DATA_DIR}/cache.json`);
});
