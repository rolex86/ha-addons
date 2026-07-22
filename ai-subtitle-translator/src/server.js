import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { ResultCache } from "./cache.js";
import { GeminiTranslator, PROMPT_VERSION } from "./gemini.js";
import { createLogger } from "./logger.js";
import { MAX_SUBTITLE_BYTES, TranslationService } from "./translation-service.js";

const MAX_REQUEST_BYTES = MAX_SUBTITLE_BYTES * 3 + 64 * 1024;

export function createServer(service, { apiToken = "", logger = null } = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { status: "ok" });
      }
      if (url.pathname.startsWith("/v1/") && !authorized(request, apiToken)) {
        response.setHeader("www-authenticate", "Bearer");
        return send(response, 401, { error: "UNAUTHORIZED" });
      }
      if (request.method === "POST" && url.pathname === "/v1/translations") {
        const body = await readJson(request);
        const submitted = await service.submit(body);
        return send(response, submitted.immediate ? 200 : 202,
          submitted.immediate ? submitted.result : submitted.job);
      }
      const match = /^\/v1\/translations\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (request.method === "GET" && match) {
        const job = service.get(match[1]);
        return job ? send(response, 200, job) : send(response, 404, { error: "JOB_NOT_FOUND" });
      }
      if (request.method === "DELETE" && match) {
        const job = service.cancel(match[1]);
        return job ? send(response, 200, job) : send(response, 404, { error: "JOB_NOT_FOUND" });
      }
      send(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const code = error?.message === "SUBTITLE_TOO_LARGE" || error?.message === "REQUEST_TOO_LARGE"
        ? 413 : 400;
      logger?.warn("Request rejected", { status: code, cause: safeErrorName(error) });
      send(response, code, { error: code === 413 ? "SUBTITLE_TOO_LARGE" : "INVALID_REQUEST" });
    }
  });
}

async function readJson(request) {
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > MAX_REQUEST_BYTES) throw new Error("REQUEST_TOO_LARGE");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(request, apiToken) {
  if (!apiToken) return true;
  const header = String(request.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(apiToken, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-length": Buffer.byteLength(body) });
  response.end(body);
}

export function createConfiguredService(env = process.env, logger = null) {
  const translator = new GeminiTranslator({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL || "gemini-3.1-flash-lite",
  });
  const cache = new ResultCache(env.CACHE_DIR || "/data/cache");
  return new TranslationService({
    translator,
    cache,
    promptVersion: PROMPT_VERSION,
    batchMaxCues: readInteger(env.BATCH_MAX_CUES, 300, 1, 500),
    batchMaxCharacters: readInteger(env.BATCH_MAX_CHARACTERS, 30000, 1000, 50000),
    timeoutMs: readInteger(env.TRANSLATION_TIMEOUT_SECONDS, 300, 30, 900) * 1000,
    logger,
  });
}

function readInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function safeErrorName(error) {
  return String(error?.message || error?.name || "UNKNOWN")
    .replace(/[^A-Z0-9_-]/gi, "_").slice(0, 80);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || 8787);
  const logger = createLogger(process.env.LOG_LEVEL || "info");
  const server = createServer(createConfiguredService(process.env, logger), {
    apiToken: process.env.API_TOKEN || "",
    logger,
  });
  server.listen(port, host, () => {
    logger.info("AI Subtitle Translator listening", {
      host,
      port,
      model: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
      authentication: process.env.API_TOKEN ? "enabled" : "disabled",
    });
  });
}
