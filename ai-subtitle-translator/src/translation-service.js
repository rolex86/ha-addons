import { randomUUID } from "node:crypto";
import { buildCacheKey } from "./cache.js";
import { createBatches, normalizeSubtitle, normalizedCacheSource, renderSrt } from "./subtitle-format.js";

export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

export class TranslationService {
  constructor({
    translator,
    cache,
    promptVersion,
    batchMaxCues = 60,
    batchMaxCharacters = 8000,
    timeoutMs = 5 * 60_000,
    logger = null,
  }) {
    this.translator = translator;
    this.cache = cache;
    this.promptVersion = promptVersion;
    this.batchMaxCues = batchMaxCues;
    this.batchMaxCharacters = batchMaxCharacters;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.jobs = new Map();
    this.jobsByCacheKey = new Map();
  }

  async submit(request) {
    validateRequest(request);
    const cues = normalizeSubtitle(request.subtitleText, request.sourceFormat);
    const cacheKey = buildCacheKey(
      normalizedCacheSource(cues), request.targetLanguage,
      this.translator.model, this.promptVersion);
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      this.logger?.debug("Translation cache hit", { cacheKey: shortKey(cacheKey) });
      return { immediate: true, result: { ...cached, cached: true } };
    }

    const existingId = this.jobsByCacheKey.get(cacheKey);
    const existing = existingId && this.jobs.get(existingId);
    if (existing && existing.status === "pending") {
      return { immediate: false, job: publicJob(existing) };
    }

    const job = {
      id: randomUUID(), cacheKey, status: "pending", progress: 0,
      createdAt: Date.now(), result: null, errorCode: null,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.jobsByCacheKey.set(cacheKey, job.id);
    this.logger?.info("Translation job started", {
      jobId: job.id,
      cues: cues.length,
      sourceFormat: request.sourceFormat,
      sourceLanguage: request.sourceLanguage || null,
    });
    this.#run(job, cues, request).catch(() => {});
    this.#prune();
    return { immediate: false, job: publicJob(job) };
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    return job ? publicJob(job) : null;
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === "pending") {
      job.status = "cancelled";
      job.errorCode = "TRANSLATION_CANCELLED";
      this.jobsByCacheKey.delete(job.cacheKey);
      job.controller.abort(new Error("CANCELLED"));
      this.logger?.info("Translation job cancelled", { jobId });
    }
    return publicJob(job);
  }

  async #run(job, cues, request) {
    const timeout = setTimeout(
      () => job.controller.abort(new Error("TIMEOUT")),
      this.timeoutMs,
    );
    try {
      const batches = createBatches(cues, this.batchMaxCues, this.batchMaxCharacters);
      const translations = [];
      for (let index = 0; index < batches.length; index++) {
        const translated = await this.translator.translateBatch(batches[index], {
          sourceLanguage: request.sourceLanguage,
          title: request.title,
        }, job.controller.signal);
        translations.push(...translated);
        job.progress = Math.min(99, Math.round(((index + 1) / batches.length) * 100));
      }
      if (job.controller.signal.aborted || job.status === "cancelled") return;
      const result = {
        status: "ready",
        cacheKey: job.cacheKey,
        outputFormat: "srt",
        language: "ces",
        label: "Čeština (AI)",
        subtitleText: renderSrt(cues, translations),
        cached: false,
      };
      await this.cache.put(result);
      job.status = "ready";
      job.progress = 100;
      job.result = result;
      this.logger?.info("Translation job completed", { jobId: job.id, cues: cues.length });
    } catch (error) {
      if (job.status === "cancelled") return;
      job.status = "failed";
      job.errorCode = error?.message === "TIMEOUT"
        ? "TRANSLATION_TIMEOUT" : "TRANSLATION_FAILED";
      this.logger?.error("Translation job failed", {
        jobId: job.id,
        errorCode: job.errorCode,
        cause: safeErrorName(error),
      });
    } finally {
      clearTimeout(timeout);
      this.jobsByCacheKey.delete(job.cacheKey);
    }
  }

  #prune() {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, job] of this.jobs) {
      if (job.status !== "pending" && job.createdAt < cutoff) this.jobs.delete(id);
    }
    while (this.jobs.size > 200) {
      const candidate = [...this.jobs.entries()].find(([, job]) => job.status !== "pending");
      if (!candidate) break;
      this.jobs.delete(candidate[0]);
    }
  }
}

export function validateRequest(request) {
  if (!request || typeof request !== "object") throw new Error("INVALID_REQUEST");
  if (typeof request.subtitleText !== "string" || !request.subtitleText.trim()) {
    throw new Error("INVALID_SUBTITLE");
  }
  if (Buffer.byteLength(request.subtitleText, "utf8") > MAX_SUBTITLE_BYTES) {
    throw new Error("SUBTITLE_TOO_LARGE");
  }
  if (!new Set(["srt", "vtt"]).has(request.sourceFormat)) throw new Error("UNSUPPORTED_FORMAT");
  if (request.targetLanguage !== "ces") throw new Error("UNSUPPORTED_LANGUAGE");
  for (const key of ["sourceLanguage", "title", "contentType", "contentId", "client", "clientVersion"]) {
    if (request[key] != null && typeof request[key] !== "string") throw new Error("INVALID_METADATA");
  }
  for (const key of ["season", "episode"]) {
    if (request[key] != null && (!Number.isInteger(request[key]) || request[key] < 0)) {
      throw new Error("INVALID_METADATA");
    }
  }
}

function publicJob(job) {
  if (job.status === "ready") return job.result;
  if (job.status === "failed") {
    return { status: "failed", errorCode: job.errorCode, message: "Překlad se nepodařilo dokončit." };
  }
  if (job.status === "cancelled") {
    return { status: "cancelled", errorCode: "TRANSLATION_CANCELLED" };
  }
  return { status: "pending", jobId: job.id, progress: job.progress };
}

function shortKey(value) {
  return value.slice(0, 12);
}

function safeErrorName(error) {
  const value = String(error?.message || error?.name || "UNKNOWN");
  return value.replace(/[^A-Z0-9_-]/gi, "_").slice(0, 80);
}
