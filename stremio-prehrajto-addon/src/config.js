import crypto from "node:crypto";
import { ENV } from "./env.js";

const TOKEN_PREFIX = "v1";
const CIPHER = "aes-256-gcm";
const SECRET_KEY = crypto
  .createHash("sha256")
  .update(process.env.CONFIG_SECRET || `${ENV.BASE_URL}:${process.pid}`)
  .digest();

export function readConfig(req) {
  const q = req.query || {};

  const token = typeof q.cfg === "string" ? q.cfg.trim() : "";
  if (token) {
    const fromToken = decodeConfigToken(token);
    if (fromToken) return fromToken;
  }

  return normalizeConfig({
    email: q.email,
    password: q.password,
    limit: q.limit,
    streamLimit: q.stream_limit ?? q.streamLimit ?? q.max_streams ?? q.maxStreams,
    premium: q.premium,
    sortBy: q.sort_by ?? q.sortBy,
    maxSizeGb: q.max_size_gb ?? q.maxSizeGb,
    audioPreference: q.audio_preference ?? q.audioPreference,
    qualityPreference: q.quality_preference ?? q.qualityPreference,
  });
}

export function buildConfigToken(input = {}) {
  const payload = normalizeConfig(input);
  const json = JSON.stringify(payload);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER, SECRET_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    TOKEN_PREFIX,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decodeConfigToken(token) {
  try {
    const [prefix, ivPart, tagPart, bodyPart] = token.split(".");
    if (prefix !== TOKEN_PREFIX || !ivPart || !tagPart || !bodyPart) return null;

    const iv = Buffer.from(ivPart, "base64url");
    const authTag = Buffer.from(tagPart, "base64url");
    const body = Buffer.from(bodyPart, "base64url");

    const decipher = crypto.createDecipheriv(CIPHER, SECRET_KEY, iv);
    decipher.setAuthTag(authTag);
    const json = Buffer.concat([
      decipher.update(body),
      decipher.final(),
    ]).toString("utf8");

    return normalizeConfig(JSON.parse(json));
  } catch {
    return null;
  }
}

function normalizeConfig(raw = {}) {
  const email = (raw.email || "").toString().trim();
  const password = (raw.password || "").toString();
  const limit = clampInt(raw.limit, ENV.DEFAULT_SEARCH_LIMIT, 5, 80);
  const streamLimit = clampInt(raw.streamLimit, ENV.DEFAULT_STREAMS_LIMIT, 1, 15);
  const premium = parseBool(raw.premium, ENV.DEFAULT_PREMIUM);
  const sortBy = normalizeEnum(
    raw.sortBy,
    ["size_desc", "size_asc", "relevance_desc", "balanced"],
    ENV.DEFAULT_SORT_BY,
  );
  const maxSizeGb = clampFloat(raw.maxSizeGb, ENV.DEFAULT_MAX_SIZE_GB, 0, 500);
  const audioPreference = normalizeEnum(
    raw.audioPreference,
    ["any", "prefer_cz_dub", "prefer_cz_sk", "prefer_original"],
    ENV.DEFAULT_AUDIO_PREFERENCE,
  );
  const qualityPreference = normalizeEnum(
    raw.qualityPreference,
    ["any", "prefer_4k", "prefer_1080p", "prefer_720p", "avoid_4k"],
    ENV.DEFAULT_QUALITY_PREFERENCE,
  );

  return {
    email,
    password,
    limit,
    streamLimit,
    premium,
    sortBy,
    maxSizeGb,
    audioPreference,
    qualityPreference,
  };
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function clampFloat(v, def, min, max) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function normalizeEnum(v, allowed, def) {
  const value = String(v ?? "").trim().toLowerCase();
  if (!value) return def;
  return allowed.includes(value) ? value : def;
}

function parseBool(v, def) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
}
