import test from "node:test";
import assert from "node:assert/strict";
import { buildCacheKey } from "../src/cache.js";
import { TranslationService, validateRequest } from "../src/translation-service.js";

const REQUEST = {
  subtitleText: "1\n00:00:01,000 --> 00:00:03,000\nExample text",
  sourceFormat: "srt",
  sourceLanguage: "eng",
  targetLanguage: "ces",
  title: "Example",
  contentType: "movie",
  contentId: "tt1234567",
  season: null,
  episode: null,
  client: "justplayer-plus",
  clientVersion: "test",
};

function createService(overrides = {}) {
  const values = new Map();
  return new TranslationService({
    translator: {
      model: "test-model",
      translateBatch: async batch => batch.map(item => ({ id: item.id, text: "Příklad textu" })),
    },
    cache: {
      get: async key => values.get(key) || null,
      put: async value => values.set(value.cacheKey, value),
    },
    promptVersion: "test-prompt",
    ...overrides,
  });
}

test("cache key includes model and prompt version", () => {
  const first = buildCacheKey("subtitle", "ces", "model-a", "prompt-1");
  const second = buildCacheKey("subtitle", "ces", "model-b", "prompt-1");
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
});

test("request validation limits format, language and size", () => {
  assert.doesNotThrow(() => validateRequest(REQUEST));
  assert.throws(() => validateRequest({ ...REQUEST, sourceFormat: "ass" }), /UNSUPPORTED_FORMAT/);
  assert.throws(() => validateRequest({ ...REQUEST, targetLanguage: "eng" }), /UNSUPPORTED_LANGUAGE/);
});

test("translation job stores SRT and serves subsequent cache hit", async () => {
  const service = createService();
  const submitted = await service.submit(REQUEST);
  assert.equal(submitted.immediate, false);

  let status;
  for (let attempt = 0; attempt < 20; attempt++) {
    status = service.get(submitted.job.jobId);
    if (status.status !== "pending") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(status.status, "ready");
  assert.match(status.subtitleText, /Příklad textu/);
  assert.equal(status.label, "Čeština (AI)");

  const cached = await service.submit(REQUEST);
  assert.equal(cached.immediate, true);
  assert.equal(cached.result.cached, true);
});

test("pending translation can be cancelled", async () => {
  const service = createService({
    translator: {
      model: "test-model",
      translateBatch: async (_batch, _metadata, signal) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve([]), 5000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    },
  });
  const submitted = await service.submit(REQUEST);
  const cancelled = service.cancel(submitted.job.jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(service.get(submitted.job.jobId).status, "cancelled");
});
