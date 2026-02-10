import fs from "fs";
import path from "path";

function nowMs() {
  return Date.now();
}

export class Cache {
  constructor({ dataDir, ttlDays, negativeTtlHours, log }) {
    this.dataDir = dataDir;
    this.ttlMs = (ttlDays ?? 14) * 24 * 60 * 60 * 1000;
    this.negativeTtlMs = (negativeTtlHours ?? 12) * 60 * 60 * 1000;
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
    const ttl = entry.kind === "negative" ? this.negativeTtlMs : this.ttlMs;

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
}
