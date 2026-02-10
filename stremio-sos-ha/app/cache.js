import fs from "fs";
import path from "path";

function nowMs() {
  return Date.now();
}

export class Cache {
  constructor({ dataDir, ttlDays, negativeTtlHours, streamTtlMinutes, log }) {
    this.dataDir = dataDir;
    this.ttlMs = (ttlDays ?? 14) * 24 * 60 * 60 * 1000;
    this.negativeTtlMs = (negativeTtlHours ?? 12) * 60 * 60 * 1000;
    this.streamTtlMs = (streamTtlMinutes ?? 20) * 60 * 1000;
    this.log = log;
    this.filePath = path.join(this.dataDir, "cache.json");
    this.db = { version: 1, items: {} };
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.db = JSON.parse(raw);
        if (!this.db.items) this.db.items = {};
        this.log.debug?.(
          `Cache loaded: ${Object.keys(this.db.items).length} items`,
        );
      }
    } catch (e) {
      this.log.warn?.(`Cache load failed, starting fresh: ${String(e)}`);
      this.db = { version: 1, items: {} };
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.db, null, 2),
        "utf-8",
      );
    } catch (e) {
      this.log.warn?.(`Cache save failed: ${String(e)}`);
    }
  }

  get(key) {
    const entry = this.db.items[key];
    if (!entry) return null;

    const age = nowMs() - (entry.updatedAt ?? 0);
    const ttl =
      entry.kind === "negative"
        ? this.negativeTtlMs
        : entry.kind === "streams"
          ? this.streamTtlMs
          : this.ttlMs;

    if (age > ttl) {
      delete this.db.items[key];
      return null;
    }
    return entry;
  }

  setPositive(key, value) {
    this.db.items[key] = { kind: "positive", updatedAt: nowMs(), ...value };
    this.save();
  }

  setNegative(key, reason = "not_found") {
    this.db.items[key] = { kind: "negative", updatedAt: nowMs(), reason };
    this.save();
  }

  setStreams(key, streams) {
    this.db.items[key] = { kind: "streams", updatedAt: nowMs(), streams };
    this.save();
  }

  stats() {
    const items = this.db?.items ?? {};
    const keys = Object.keys(items);
    const counts = { total: keys.length, positive: 0, negative: 0, streams: 0 };
    for (const k of keys) {
      const kind = items[k]?.kind;
      if (kind === "positive") counts.positive += 1;
      else if (kind === "negative") counts.negative += 1;
      else if (kind === "streams") counts.streams += 1;
    }
    return counts;
  }
}
