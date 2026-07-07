const fs = require("node:fs");
const path = require("node:path");

const INTERNAL_PORT = Number(process.env.PORT) || 7010;

const DEFAULT_CONFIG = {
  server: {
    public_base_url: "http://homeassistant.local:7010",
    enable_cors: true
  },
  media: {
    paths: [
      { path: "/media/nas/Filmy", type: "movie", catalog_id: "nas_movies" },
      { path: "/media/nas/Serialy", type: "series", catalog_id: "nas_series" }
    ],
    allowed_extensions: [".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm"],
    ignore_patterns: ["@eaDir", "#recycle", ".DS_Store", "sample", "trailer"]
  },
  scan: {
    mode: "manual",
    run_on_startup: false,
    scan_on_catalog_open: false,
    interval_value: 1,
    interval_unit: "months",
    cron: "30 4 * * *",
    scan_type: "light",
    remove_missing: false,
    mark_missing_unavailable: true
  },
  metadata: {
    enabled: true,
    provider: "tmdb",
    tmdb_api_key: "",
    language: "cs-CZ",
    fallback_language: "en-US",
    prefer_nfo: true,
    cache_posters: true,
    cache_backdrops: true,
    only_fetch_for_new_items: true,
    refresh_existing: false,
    refresh_after_days: 365,
    min_auto_match_confidence: 0.9
  },
  streaming: {
    verify_file_exists_on_play: true,
    enable_range_requests: true,
    mime_fallback: "video/mp4",
    direct_play_only: true,
    show_filename_in_title: true,
    show_folder_in_title: false
  },
  security: {
    admin_token: "",
    expose_admin_api: false,
    allow_lan_only: true
  },
  logging: {
    level: "info"
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(target, source) {
  const output = Array.isArray(target) ? [...target] : { ...target };
  if (!isPlainObject(source)) {
    return output;
  }

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      output[key] = [...value];
      continue;
    }

    if (isPlainObject(value)) {
      const base = isPlainObject(output[key]) ? output[key] : {};
      output[key] = mergeDeep(base, value);
      continue;
    }

    output[key] = value;
  }

  return output;
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }

    const raw = fs.readFileSync(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error(`Failed to read config from ${filePath}: ${error.message}`);
  }
}

function buildEnvConfig() {
  const envConfig = {};

  if (process.env.PUBLIC_BASE_URL) {
    envConfig.server = {
      public_base_url: process.env.PUBLIC_BASE_URL
    };
  }

  if (process.env.LOG_LEVEL) {
    envConfig.logging = {
      level: process.env.LOG_LEVEL
    };
  }

  return envConfig;
}

function normalizeExtensions(extensions) {
  return [...new Set((extensions || []).map((extension) => {
    const normalized = String(extension || "").trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    return normalized.startsWith(".") ? normalized : `.${normalized}`;
  }).filter(Boolean))];
}

function normalizePaths(mediaPaths) {
  return (mediaPaths || []).map((entry, index) => {
    const mediaType = entry.type === "series" ? "series" : "movie";
    const fallbackCatalogId = mediaType === "series" ? `nas_series_${index + 1}` : `nas_movies_${index + 1}`;

    return {
      path: path.resolve(String(entry.path || "")),
      type: mediaType,
      catalog_id: String(entry.catalog_id || fallbackCatalogId)
    };
  }).filter((entry) => entry.path && entry.path !== "/");
}

function normalizeConfig(config) {
  const normalized = clone(config);
  normalized.server.port = INTERNAL_PORT;
  normalized.server.public_base_url = String(normalized.server.public_base_url || `http://localhost:${INTERNAL_PORT}`).replace(/\/+$/, "");
  normalized.server.enable_cors = Boolean(normalized.server.enable_cors);

  normalized.media.paths = normalizePaths(normalized.media.paths);
  normalized.media.allowed_extensions = normalizeExtensions(normalized.media.allowed_extensions);
  normalized.media.ignore_patterns = (normalized.media.ignore_patterns || []).map((value) => String(value).toLowerCase());

  normalized.scan.interval_value = Math.max(1, Number(normalized.scan.interval_value) || 1);
  normalized.metadata.refresh_after_days = Math.max(1, Number(normalized.metadata.refresh_after_days) || 365);
  normalized.metadata.min_auto_match_confidence = Number(normalized.metadata.min_auto_match_confidence) || 0.9;
  normalized.streaming.verify_file_exists_on_play = Boolean(normalized.streaming.verify_file_exists_on_play);
  normalized.streaming.enable_range_requests = Boolean(normalized.streaming.enable_range_requests);
  normalized.streaming.show_filename_in_title = Boolean(normalized.streaming.show_filename_in_title);
  normalized.streaming.show_folder_in_title = Boolean(normalized.streaming.show_folder_in_title);
  normalized.security.expose_admin_api = Boolean(normalized.security.expose_admin_api);
  normalized.security.allow_lan_only = Boolean(normalized.security.allow_lan_only);

  return normalized;
}

function redactConfig(config) {
  const safe = clone(config);
  if (safe.metadata) {
    safe.metadata.tmdb_api_key = safe.metadata.tmdb_api_key ? "***redacted***" : "";
  }
  if (safe.security) {
    safe.security.admin_token = safe.security.admin_token ? "***redacted***" : "";
  }
  return safe;
}

function loadConfig() {
  const optionsPath = process.env.OPTIONS_PATH || "/data/options.json";
  const fileConfig = readJsonFile(optionsPath);
  const merged = mergeDeep(mergeDeep(clone(DEFAULT_CONFIG), fileConfig), buildEnvConfig());
  return normalizeConfig(merged);
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  redactConfig
};
