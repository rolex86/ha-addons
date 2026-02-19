import dotenv from "dotenv";
dotenv.config();

export const ENV = {
  PORT: parseInt(process.env.PORT || "7654", 10),
  BASE_URL:
    process.env.BASE_URL || `http://localhost:${process.env.PORT || 7654}`,

  TMDB_API_KEY: process.env.TMDB_API_KEY || "",
  TMDB_LANGUAGE: process.env.TMDB_LANGUAGE || "cs-CZ",

  PREHRAJTO_BASE: process.env.PREHRAJTO_BASE || "https://prehraj.to",
  PREHRAJTO_USER_AGENT:
    process.env.PREHRAJTO_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",

  DEFAULT_SEARCH_LIMIT: parseInt(process.env.DEFAULT_SEARCH_LIMIT || "20", 10),
  DEFAULT_STREAMS_LIMIT: parseInt(process.env.DEFAULT_STREAMS_LIMIT || "5", 10),
  DEFAULT_PREMIUM:
    (process.env.DEFAULT_PREMIUM || "false").toLowerCase() === "true",

  CACHE_TTL_SECONDS: parseInt(process.env.CACHE_TTL_SECONDS || "900", 10),
  LOG_LEVEL: process.env.LOG_LEVEL || "debug",
};
