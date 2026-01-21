const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { DATA_DIR } = require("./config");

const DB_PATH = path.join(DATA_DIR, "history.sqlite");

function openDb() {
  const db = new sqlite3.Database(DB_PATH);
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        track_id TEXT NOT NULL,
        used_at INTEGER NOT NULL
      )
    `);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_history_scope_usedat ON history(scope_key, used_at)`,
    );
    db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS u_history_scope_track ON history(scope_key, track_id)`,
    );
  });
  return db;
}

function scopeKey({ historyScope, recipeId }) {
  return historyScope === "global" ? "GLOBAL" : `RECIPE:${recipeId}`;
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function getExcludedSet(
  db,
  { historyScope, recipeId, mode, rollingDays, lifetimeCap },
) {
  const key = scopeKey({ historyScope, recipeId });

  if (mode === "rolling_days") {
    const cutoff = Date.now() - rollingDays * 24 * 60 * 60 * 1000;
    const rows = await dbAll(
      db,
      `SELECT track_id FROM history WHERE scope_key=? AND used_at>=?`,
      [key, cutoff],
    );
    return new Set(rows.map((r) => r.track_id));
  }

  // lifetime_capped: keep last N entries (by used_at), exclude all of them
  const rows = await dbAll(
    db,
    `SELECT track_id FROM history WHERE scope_key=? ORDER BY used_at DESC LIMIT ?`,
    [key, lifetimeCap],
  );
  return new Set(rows.map((r) => r.track_id));
}

async function recordUsed(db, { historyScope, recipeId, trackIds }) {
  const key = scopeKey({ historyScope, recipeId });
  const now = Date.now();
  // Insert ignore duplicates
  for (const tid of trackIds) {
    try {
      await dbRun(
        db,
        `INSERT OR IGNORE INTO history(scope_key, track_id, used_at) VALUES(?,?,?)`,
        [key, tid, now],
      );
    } catch (_) {}
  }
}

async function prune(
  db,
  { historyScope, recipeId, mode, rollingDays, lifetimeCap },
) {
  const key = scopeKey({ historyScope, recipeId });

  if (mode === "rolling_days") {
    const cutoff = Date.now() - rollingDays * 24 * 60 * 60 * 1000;
    await dbRun(db, `DELETE FROM history WHERE scope_key=? AND used_at<?`, [
      key,
      cutoff,
    ]);
    return;
  }

  // lifetime_capped: keep last N by used_at
  // delete all older than the Nth newest
  const rows = await dbAll(
    db,
    `SELECT used_at FROM history WHERE scope_key=? ORDER BY used_at DESC LIMIT 1 OFFSET ?`,
    [key, lifetimeCap - 1],
  );
  if (rows.length === 0) return;
  const threshold = rows[0].used_at;
  await dbRun(db, `DELETE FROM history WHERE scope_key=? AND used_at<?`, [
    key,
    threshold,
  ]);
}

module.exports = {
  openDb,
  getExcludedSet,
  recordUsed,
  prune,
};
