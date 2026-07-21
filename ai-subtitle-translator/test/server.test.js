import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "../src/server.js";
import { TranslationService } from "../src/translation-service.js";

function requestBody() {
  return {
    subtitleText: "1\n00:00:01,000 --> 00:00:02,000\nHello",
    sourceFormat: "srt",
    sourceLanguage: "eng",
    targetLanguage: "ces",
    title: null,
    contentType: null,
    contentId: null,
    season: null,
    episode: null,
    client: "justplayer-plus",
    clientVersion: "test",
  };
}

function service() {
  const stored = new Map();
  return new TranslationService({
    translator: {
      model: "test-model",
      translateBatch: async batch => batch.map(cue => ({ ...cue, text: "Ahoj" })),
    },
    cache: {
      get: async key => stored.get(key) || null,
      put: async value => stored.set(value.cacheKey, value),
    },
    promptVersion: "test-prompt",
  });
}

async function listen(server, t) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return server.address().port;
}

test("HTTP API returns 202, pollable result and a cache hit", async t => {
  const server = createServer(service());
  const port = await listen(server, t);
  const first = await fetch(`http://127.0.0.1:${port}/v1/translations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody()),
  });
  assert.equal(first.status, 202);
  const pending = await first.json();

  let ready;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/translations/${pending.jobId}`);
    ready = await response.json();
    if (ready.status === "ready") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(ready.status, "ready");

  const second = await fetch(`http://127.0.0.1:${port}/v1/translations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody()),
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).cached, true);
});

test("Bearer authentication protects translation routes but not health", async t => {
  const server = createServer(service(), { apiToken: "secret-token" });
  const port = await listen(server, t);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);

  const denied = await fetch(`http://127.0.0.1:${port}/v1/translations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody()),
  });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`http://127.0.0.1:${port}/v1/translations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret-token",
    },
    body: JSON.stringify(requestBody()),
  });
  assert.equal(accepted.status, 202);
});

test("HTTP API rejects unsupported input without exposing request content", async t => {
  const server = createServer({ submit: async () => { throw new Error("INVALID_REQUEST"); } });
  const port = await listen(server, t);
  const response = await fetch(`http://127.0.0.1:${port}/v1/translations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "INVALID_REQUEST" });
});
