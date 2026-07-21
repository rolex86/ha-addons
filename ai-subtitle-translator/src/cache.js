import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function buildCacheKey(normalizedSubtitle, targetLanguage, model, promptVersion) {
  return createHash("sha256")
    .update(normalizedSubtitle)
    .update("\0").update(targetLanguage)
    .update("\0gemini\0").update(model)
    .update("\0").update(promptVersion)
    .update("\0srt")
    .digest("hex");
}

export class ResultCache {
  constructor(directory) {
    this.directory = path.resolve(directory);
  }

  async get(cacheKey) {
    if (!safeKey(cacheKey)) return null;
    try {
      const value = JSON.parse(await readFile(path.join(this.directory, `${cacheKey}.json`), "utf8"));
      return validResult(value, cacheKey) ? value : null;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async put(result) {
    if (!validResult(result, result.cacheKey)) throw new Error("INVALID_CACHE_RESULT");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, `${result.cacheKey}.json`);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }
}

function safeKey(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validResult(value, cacheKey) {
  return value && value.status === "ready" && value.cacheKey === cacheKey
    && value.outputFormat === "srt" && value.language === "ces"
    && typeof value.label === "string" && value.label.length > 0
    && typeof value.subtitleText === "string" && value.subtitleText.length > 0;
}
