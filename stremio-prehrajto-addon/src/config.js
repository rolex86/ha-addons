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
    premium: q.premium,
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
  const premium = parseBool(raw.premium, ENV.DEFAULT_PREMIUM);

  return {
    email,
    password,
    limit,
    premium,
  };
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function parseBool(v, def) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
}
