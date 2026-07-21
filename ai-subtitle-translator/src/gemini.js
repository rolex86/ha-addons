const PROMPT = `You translate subtitle cue text into Czech.
Return JSON only, using exactly this shape: {"translations":[{"id":"cue-id","text":"translated text"}]}.
Keep every input ID exactly once and in the original order. Translate only text. Preserve line breaks, speaker dashes, basic HTML tags, and formatting markers. Do not add notes or timestamps.`;

export const PROMPT_VERSION = "jpp-cs-v2";

export class GeminiTranslator {
  constructor({ apiKey, model = "gemini-3.1-flash-lite", fetchImpl = globalThis.fetch }) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is required");
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
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
        const translations = await this.#request(input, signal);
        validateTranslations(batch, translations);
        return translations;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt === 2) break;
        await delay(750 * (2 ** attempt), signal);
      }
    }
    throw lastError ?? new Error("TRANSLATION_FAILED");
  }

  async #request(input, signal) {
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
      signal,
    });
    if (!response.ok) throw new Error(`GEMINI_HTTP_${response.status}`);
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "").join("");
    if (!text) throw new Error("EMPTY_GEMINI_RESPONSE");
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return Array.isArray(parsed) ? parsed : parsed.translations;
  }
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

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("ABORTED"));
    }, { once: true });
  });
}
