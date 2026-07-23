const PROMPT = `You translate subtitle cue text into Czech.
Return JSON only, using exactly this shape: {"translations":[{"id":"cue-id","text":"translated text"}]}.
Keep every input ID exactly once and in the original order. Translate only text. Preserve line breaks, speaker dashes, basic HTML tags, and formatting markers. Do not add notes or timestamps.`;

export const PROMPT_VERSION = "jpp-cs-v3";

export class GeminiTranslator {
  constructor({
    apiKey,
    model = "gemini-3.1-flash-lite",
    fetchImpl = globalThis.fetch,
    sleepImpl = delay,
    requestTimeoutMs = 45_000,
    minimumRequestIntervalMs = 4_100,
  }) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is required");
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    if (typeof sleepImpl !== "function") throw new Error("sleep is unavailable");
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.minimumRequestIntervalMs = minimumRequestIntervalMs;
    this.nextRequestAt = 0;
  }

  async translateBatch(batch, { sourceLanguage, title }, signal) {
    const input = JSON.stringify({
      sourceLanguage: sourceLanguage || null,
      targetLanguage: "ces",
      title: title || null,
      cues: batch,
    });
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.#waitForRateSlot(signal);
        const translations = await this.#request(input, signal);
        validateTranslations(batch, translations);
        return translations;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || isOutputShapeError(error) || attempt === 2) break;
        if (!isTransient(error)) break;
        const waitMs = error instanceof GeminiHttpError && error.status === 429
          ? (error.retryAfterMs ?? 65_000)
          : 750 * (2 ** attempt);
        await this.sleep(waitMs, signal);
      }
    }
    throw lastError ?? new Error("TRANSLATION_FAILED");
  }

  async #waitForRateSlot(signal) {
    const waitMs = Math.max(0, this.nextRequestAt - Date.now());
    if (waitMs > 0) await this.sleep(waitMs, signal);
    this.nextRequestAt = Date.now() + this.minimumRequestIntervalMs;
  }

  async #request(input, parentSignal) {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal.reason ?? new Error("ABORTED"));
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("GEMINI_REQUEST_TIMEOUT")),
      this.requestTimeoutMs,
    );
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
      const response = await this.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: PROMPT }] },
          contents: [{ role: "user", parts: [{ text: input }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new GeminiHttpError(
          response.status,
          parseRetryAfter(response.headers?.get?.("retry-after")),
        );
      }
      const payload = await response.json();
      const text = payload?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "").join("");
      if (!text) throw new Error("EMPTY_GEMINI_RESPONSE");
      let parsed;
      try {
        parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      } catch {
        throw new Error("INVALID_GEMINI_JSON");
      }
      return Array.isArray(parsed) ? parsed : parsed.translations;
    } catch (error) {
      if (controller.signal.aborted && !parentSignal?.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason : new Error("GEMINI_REQUEST_TIMEOUT");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }
}

class GeminiHttpError extends Error {
  constructor(status, retryAfterMs = null) {
    super(`GEMINI_HTTP_${status}`);
    this.name = "GeminiHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(120_000, Math.max(1_000, Math.ceil(seconds * 1000)));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.min(120_000, Math.max(1_000, date - now));
}

export function validateTranslations(batch, translations) {
  if (!Array.isArray(translations) || translations.length !== batch.length) {
    throw new Error("TRANSLATION_COUNT_MISMATCH");
  }
  for (let index = 0; index < batch.length; index++) {
    const actual = translations[index];
    if (!actual || actual.id !== batch[index].id
        || typeof actual.text !== "string" || !actual.text.trim()) {
      throw new Error("TRANSLATION_ID_MISMATCH");
    }
  }
}

function isOutputShapeError(error) {
  return new Set([
    "TRANSLATION_COUNT_MISMATCH",
    "TRANSLATION_ID_MISMATCH",
    "EMPTY_GEMINI_RESPONSE",
    "INVALID_GEMINI_JSON",
  ]).has(error?.message);
}

function isTransient(error) {
  return error instanceof GeminiHttpError || error?.message === "GEMINI_REQUEST_TIMEOUT"
    || error?.name === "TypeError" || error?.code === "ECONNRESET"
    || error?.code === "ETIMEDOUT";
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("ABORTED"));
    }, { once: true });
  });
}
