import test from "node:test";
import assert from "node:assert/strict";
import { GeminiTranslator, parseRetryAfter } from "../src/gemini.js";

const BATCH = [{ id: "cue-1", text: "Hello" }];
const SUCCESS = {
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      translations: [{ id: "cue-1", text: "Ahoj" }],
    }) }] } }],
  }),
};

test("429 retry respects Retry-After before retrying", async () => {
  const waits = [];
  let calls = 0;
  const translator = new GeminiTranslator({
    apiKey: "test",
    fetchImpl: async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: name => name === "retry-after" ? "2" : null },
        };
      }
      return SUCCESS;
    },
    sleepImpl: async milliseconds => waits.push(milliseconds),
  });

  const result = await translator.translateBatch(BATCH, {}, new AbortController().signal);
  assert.deepEqual(result, [{ id: "cue-1", text: "Ahoj" }]);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});

test("429 without Retry-After waits for the rate-limit window", async () => {
  const waits = [];
  let calls = 0;
  const translator = new GeminiTranslator({
    apiKey: "test",
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? { ok: false, status: 429, headers: { get: () => null } }
        : SUCCESS;
    },
    sleepImpl: async milliseconds => waits.push(milliseconds),
  });

  await translator.translateBatch(BATCH, {}, new AbortController().signal);
  assert.deepEqual(waits, [65000]);
});

test("parses numeric and HTTP-date Retry-After values", () => {
  assert.equal(parseRetryAfter("1.5"), 1500);
  assert.equal(parseRetryAfter("invalid"), null);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:01:00 GMT", 0), 60000);
});
