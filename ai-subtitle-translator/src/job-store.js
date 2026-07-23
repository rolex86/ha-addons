import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const JOB_ID = /^[0-9a-f-]{36}$/;

export class JobStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  loadPending() {
    const snapshots = [];
    for (const filename of readdirSync(this.directory)) {
      if (!filename.endsWith(".json")) continue;
      try {
        const snapshot = JSON.parse(
          readFileSync(path.join(this.directory, filename), "utf8"),
        );
        if (validSnapshot(snapshot)) snapshots.push(snapshot);
      } catch {
        // Ignore partial or obsolete files. Atomic writes keep valid snapshots intact.
      }
    }
    return snapshots;
  }

  async put(snapshot) {
    if (!validSnapshot(snapshot)) throw new Error("INVALID_JOB_SNAPSHOT");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, `${snapshot.id}.json`);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  async remove(jobId) {
    if (!JOB_ID.test(String(jobId))) return;
    try {
      await unlink(path.join(this.directory, `${jobId}.json`));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function validSnapshot(value) {
  return value && value.version === 1 && JOB_ID.test(String(value.id))
    && /^[a-f0-9]{64}$/.test(String(value.cacheKey))
    && Number.isFinite(value.createdAt)
    && Array.isArray(value.cues) && value.cues.length > 0
    && Array.isArray(value.translations)
    && value.request && value.request.targetLanguage === "ces";
}
