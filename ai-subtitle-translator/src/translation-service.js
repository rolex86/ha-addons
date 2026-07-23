import { randomUUID } from "node:crypto";
import { buildCacheKey } from "./cache.js";
import { createBatches, normalizeSubtitle, normalizedCacheSource, renderSrt } from "./subtitle-format.js";

export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

export class TranslationService {
  constructor({
    translator,
    cache,
    jobStore = null,
    promptVersion,
    batchMaxCues = 300,
    batchMaxCharacters = 30000,
    timeoutMs = 5 * 60_000,
    logger = null,
  }) {
    this.translator = translator;
    this.cache = cache;
    this.jobStore = jobStore;
    this.promptVersion = promptVersion;
    this.batchMaxCues = batchMaxCues;
    this.batchMaxCharacters = batchMaxCharacters;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.jobs = new Map();
    this.jobsByCacheKey = new Map();
    this.queue = [];
    this.workerRunning = false;
    this.#restorePendingJobs();
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
    if (existing && existing.status === "failed") {
      existing.status = "pending";
      existing.errorCode = null;
      existing.controller = new AbortController();
      await this.#persist(existing);
      this.#enqueue(existing);
      return { immediate: false, job: publicJob(existing) };
    }

    const job = this.#createJob({
      id: randomUUID(), cacheKey, cues, request, createdAt: Date.now(), translations: [],
    });
    this.jobs.set(job.id, job);
    this.jobsByCacheKey.set(cacheKey, job.id);
    await this.#persist(job);
    this.logger?.info("Translation job queued", {
      jobId: job.id,
      cues: cues.length,
      sourceFormat: request.sourceFormat,
      sourceLanguage: request.sourceLanguage || null,
    });
    this.#enqueue(job);
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
    if (job.status === "pending" || job.status === "failed") {
      job.status = "cancelled";
      job.errorCode = "TRANSLATION_CANCELLED";
      this.jobsByCacheKey.delete(job.cacheKey);
      this.queue = this.queue.filter(id => id !== job.id);
      job.controller.abort(new Error("CANCELLED"));
      this.jobStore?.remove(job.id).catch(error => this.#logPersistenceError(error));
      this.logger?.info("Translation job cancelled", { jobId });
    }
    return publicJob(job);
  }

  #createJob({ id, cacheKey, cues, request, createdAt, translations = [] }) {
    return {
      id,
      cacheKey,
      cues,
      request: persistentRequest(request),
      translations: new Map(translations.map(item => [item.id, item.text])),
      status: "pending",
      progress: Math.min(99, Math.round((translations.length / cues.length) * 100)),
      createdAt,
      result: null,
      errorCode: null,
      controller: new AbortController(),
    };
  }

  #restorePendingJobs() {
    if (!this.jobStore) return;
    for (const snapshot of this.jobStore.loadPending()) {
      if (this.jobsByCacheKey.has(snapshot.cacheKey)) continue;
      const job = this.#createJob(snapshot);
      this.jobs.set(job.id, job);
      this.jobsByCacheKey.set(job.cacheKey, job.id);
      this.#enqueue(job);
      this.logger?.info("Restored translation job", {
        jobId: job.id,
        progress: job.progress,
        completedCues: job.translations.size,
        cues: job.cues.length,
      });
    }
  }

  #enqueue(job) {
    if (!this.queue.includes(job.id)) this.queue.push(job.id);
    queueMicrotask(() => this.#drainQueue());
  }

  async #drainQueue() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        const job = this.jobs.get(id);
        if (job?.status === "pending") await this.#run(job);
      }
    } finally {
      this.workerRunning = false;
    }
  }

  async #run(job) {
    let timeout;
    const armTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () => job.controller.abort(new Error("TIMEOUT")),
        this.timeoutMs,
      );
    };
    armTimeout();
    try {
      const cached = await this.cache.get(job.cacheKey);
      if (cached) {
        await this.#complete(job, { ...cached, cached: true });
        return;
      }
      const remaining = job.cues.filter(cue => !job.translations.has(cue.id));
      const batches = createBatches(remaining, this.batchMaxCues, this.batchMaxCharacters);
      this.logger?.info("Translation job started", {
        jobId: job.id,
        cues: job.cues.length,
        remainingCues: remaining.length,
        batches: batches.length,
      });
      for (const batch of batches) {
        await this.#translateAdaptive(job, batch, armTimeout, 0);
      }
      if (job.controller.signal.aborted || job.status === "cancelled") return;
      const translations = job.cues.map(cue => ({
        id: cue.id,
        text: job.translations.get(cue.id),
      }));
      const result = {
        status: "ready",
        cacheKey: job.cacheKey,
        outputFormat: "srt",
        language: "ces",
        label: "Čeština (AI)",
        subtitleText: renderSrt(job.cues, translations),
        cached: false,
      };
      await this.cache.put(result);
      await this.#complete(job, result);
    } catch (error) {
      if (job.status === "cancelled") return;
      job.status = "failed";
      job.errorCode = error?.message === "TIMEOUT"
        ? "TRANSLATION_TIMEOUT" : "TRANSLATION_FAILED";
      await this.#persist(job).catch(persistError => this.#logPersistenceError(persistError));
      this.logger?.error("Translation job failed", {
        jobId: job.id,
        progress: job.progress,
        completedCues: job.translations.size,
        errorCode: job.errorCode,
        cause: safeErrorName(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async #translateAdaptive(job, batch, armTimeout, depth) {
    if (job.controller.signal.aborted) throw job.controller.signal.reason;
    const first = batch[0]?.id;
    const last = batch[batch.length - 1]?.id;
    try {
      const translated = await this.translator.translateBatch(batch, {
        sourceLanguage: job.request.sourceLanguage,
        title: job.request.title,
      }, job.controller.signal);
      for (const item of translated) job.translations.set(item.id, item.text);
      job.progress = Math.min(99,
        Math.round((job.translations.size / job.cues.length) * 100));
      await this.#persist(job);
      armTimeout();
      this.logger?.info("Translation batch completed", {
        jobId: job.id, first, last, cues: batch.length, progress: job.progress,
      });
    } catch (error) {
      if (isAdaptiveError(error) && batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        this.logger?.warn("Splitting failed translation batch", {
          jobId: job.id,
          first,
          last,
          cues: batch.length,
          cause: safeErrorName(error),
          depth,
        });
        await this.#translateAdaptive(job, batch.slice(0, middle), armTimeout, depth + 1);
        await this.#translateAdaptive(job, batch.slice(middle), armTimeout, depth + 1);
        return;
      }
      this.logger?.error("Translation batch failed", {
        jobId: job.id,
        first,
        last,
        cues: batch.length,
        cause: safeErrorName(error),
        depth,
      });
      throw error;
    }
  }

  async #complete(job, result) {
    job.status = "ready";
    job.progress = 100;
    job.result = result;
    this.jobsByCacheKey.delete(job.cacheKey);
    await this.jobStore?.remove(job.id);
    this.logger?.info("Translation job completed", {
      jobId: job.id, cues: job.cues.length,
    });
  }

  async #persist(job) {
    if (!this.jobStore) return;
    await this.jobStore.put({
      version: 1,
      id: job.id,
      cacheKey: job.cacheKey,
      createdAt: job.createdAt,
      request: job.request,
      cues: job.cues,
      translations: [...job.translations].map(([id, text]) => ({ id, text })),
    });
  }

  #logPersistenceError(error) {
    this.logger?.error("Translation job persistence failed", {
      cause: safeErrorName(error),
    });
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
  if (!new Set(["srt", "vtt"]).has(request.sourceFormat)) {
    throw new Error("UNSUPPORTED_FORMAT");
  }
  if (request.targetLanguage !== "ces") throw new Error("UNSUPPORTED_LANGUAGE");
  for (const key of ["sourceLanguage", "title", "contentType", "contentId", "client", "clientVersion"]) {
    if (request[key] != null && typeof request[key] !== "string") {
      throw new Error("INVALID_METADATA");
    }
  }
  for (const key of ["season", "episode"]) {
    if (request[key] != null
        && (!Number.isInteger(request[key]) || request[key] < 0)) {
      throw new Error("INVALID_METADATA");
    }
  }
}

function persistentRequest(request) {
  return {
    sourceFormat: request.sourceFormat,
    sourceLanguage: request.sourceLanguage ?? null,
    targetLanguage: request.targetLanguage,
    title: request.title ?? null,
    contentType: request.contentType ?? null,
    contentId: request.contentId ?? null,
    season: request.season ?? null,
    episode: request.episode ?? null,
    client: request.client ?? null,
    clientVersion: request.clientVersion ?? null,
  };
}

function isAdaptiveError(error) {
  return new Set([
    "TRANSLATION_COUNT_MISMATCH",
    "TRANSLATION_ID_MISMATCH",
    "EMPTY_GEMINI_RESPONSE",
    "INVALID_GEMINI_JSON",
    "GEMINI_REQUEST_TIMEOUT",
  ]).has(error?.message);
}

function publicJob(job) {
  if (job.status === "ready") return job.result;
  if (job.status === "failed") {
    return {
      status: "failed",
      errorCode: job.errorCode,
      message: "Překlad se nepodařilo dokončit.",
    };
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
  return String(error?.message || error?.name || "UNKNOWN")
    .replace(/[^A-Z0-9_-]/gi, "_").slice(0, 80);
}
