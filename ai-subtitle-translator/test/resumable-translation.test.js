import test from "node:test";
import assert from "node:assert/strict";
import { TranslationService } from "../src/translation-service.js";

const REQUEST = {
  subtitleText: [
    "1", "00:00:01,000 --> 00:00:02,000", "One", "",
    "2", "00:00:02,000 --> 00:00:03,000", "Two", "",
    "3", "00:00:03,000 --> 00:00:04,000", "Three", "",
    "4", "00:00:04,000 --> 00:00:05,000", "Four",
  ].join("\n"),
  sourceFormat: "srt",
  sourceLanguage: "eng",
  targetLanguage: "ces",
  title: "Example",
  client: "test",
  clientVersion: "test",
};

function memoryCache() {
  const values = new Map();
  return {
    get: async key => values.get(key) || null,
    put: async value => values.set(value.cacheKey, value),
  };
}

async function waitFor(service, jobId, expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = service.get(jobId);
    if (status?.status === expected) return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Job ${jobId} did not reach ${expected}`);
}

test("count mismatch splits only the failed batch", async () => {
  const calls = [];
  const service = new TranslationService({
    translator: {
      model: "test",
      translateBatch: async batch => {
        calls.push(batch.length);
        if (batch.length > 2) throw new Error("TRANSLATION_COUNT_MISMATCH");
        return batch.map(item => ({ id: item.id, text: `CZ ${item.text}` }));
      },
    },
    cache: memoryCache(),
    promptVersion: "test",
    batchMaxCues: 4,
    batchMaxCharacters: 10000,
  });

  const submitted = await service.submit(REQUEST);
  const result = await waitFor(service, submitted.job.jobId, "ready");
  assert.deepEqual(calls, [4, 2, 2]);
  assert.match(result.subtitleText, /CZ One/);
  assert.match(result.subtitleText, /CZ Four/);
});

test("persisted partial translations resume without repeating completed cues", async () => {
  let snapshot;
  const store = {
    loadPending: () => snapshot ? [snapshot] : [],
    put: async value => { snapshot = structuredClone(value); },
    remove: async () => { snapshot = null; },
  };
  let calls = 0;
  const first = new TranslationService({
    translator: {
      model: "test",
      translateBatch: async batch => {
        calls++;
        if (calls === 2) throw new Error("GEMINI_HTTP_500");
        return batch.map(item => ({ id: item.id, text: `CZ ${item.text}` }));
      },
    },
    cache: memoryCache(),
    jobStore: store,
    promptVersion: "test",
    batchMaxCues: 2,
    batchMaxCharacters: 10000,
  });

  const submitted = await first.submit(REQUEST);
  await waitFor(first, submitted.job.jobId, "failed");
  assert.equal(snapshot.translations.length, 2);

  const resumedCalls = [];
  const second = new TranslationService({
    translator: {
      model: "test",
      translateBatch: async batch => {
        resumedCalls.push(batch.map(item => item.id));
        return batch.map(item => ({ id: item.id, text: `CZ ${item.text}` }));
      },
    },
    cache: memoryCache(),
    jobStore: store,
    promptVersion: "test",
    batchMaxCues: 2,
    batchMaxCharacters: 10000,
  });

  const result = await waitFor(second, submitted.job.jobId, "ready");
  assert.equal(resumedCalls.length, 1);
  assert.deepEqual(resumedCalls[0], ["cue-000003", "cue-000004"]);
  assert.match(result.subtitleText, /CZ Four/);
});
