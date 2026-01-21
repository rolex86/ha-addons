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

    // Fast lookups by scope + time
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_history_scope_usedat ON history(scope_key, used_at)`,
    );

    // Uniqueness for UPSERT
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

  const m = String(mode || "rolling_days");
  const rd = Number.isFinite(Number(rollingDays)) ? Number(rollingDays) : 90;
  const cap = Number.isFinite(Number(lifetimeCap))
    ? Number(lifetimeCap)
    : 20000;

  if (m === "rolling_days") {
    const cutoff = Date.now() - rd * 24 * 60 * 60 * 1000;
    const rows = await dbAll(
      db,
      `SELECT track_id
       FROM history
       WHERE scope_key=? AND used_at>=?`,
      [key, cutoff],
    );
    return new Set(rows.map((r) => r.track_id));
  }

  // Optional extension (doesn't break anything): exclude everything ever used
  if (m === "lifetime_all") {
    const rows = await dbAll(
      db,
      `SELECT track_id
       FROM history
       WHERE scope_key=?`,
      [key],
    );
    return new Set(rows.map((r) => r.track_id));
  }

  // lifetime_capped: keep last N entries (by used_at DESC, id DESC), exclude all of them
  const rows = await dbAll(
    db,
    `SELECT track_id
     FROM history
     WHERE scope_key=?
     ORDER BY used_at DESC, id DESC
     LIMIT ?`,
    [key, cap],
  );
  return new Set(rows.map((r) => r.track_id));
}

async function recordUsed(db, { historyScope, recipeId, trackIds }) {
  const key = scopeKey({ historyScope, recipeId });
  const now = Date.now();
  const ids = Array.isArray(trackIds) ? trackIds.filter(Boolean) : [];
  if (!ids.length) return;

  // Transaction = way faster than N separate writes
  await dbRun(db, "BEGIN");
  try {
    for (const tid of ids) {
      // UPSERT: if already exists, update used_at to "now"
      await dbRun(
        db,
        `
        INSERT INTO history(scope_key, track_id, used_at)
        VALUES(?,?,?)
        ON CONFLICT(scope_key, track_id)
        DO UPDATE SET used_at=excluded.used_at
        `,
        [key, String(tid), now],
      );
    }
    await dbRun(db, "COMMIT");
  } catch (e) {
    try {
      await dbRun(db, "ROLLBACK");
    } catch (_) {}
    throw e;
  }
}

async function prune(
  db,
  { historyScope, recipeId, mode, rollingDays, lifetimeCap },
) {
  const key = scopeKey({ historyScope, recipeId });

  const m = String(mode || "rolling_days");
  const rd = Number.isFinite(Number(rollingDays)) ? Number(rollingDays) : 90;
  const cap = Number.isFinite(Number(lifetimeCap))
    ? Number(lifetimeCap)
    : 20000;

  if (m === "rolling_days") {
    const cutoff = Date.now() - rd * 24 * 60 * 60 * 1000;
    await dbRun(db, `DELETE FROM history WHERE scope_key=? AND used_at<?`, [
      key,
      cutoff,
    ]);
    return;
  }

  // lifetime_all => no pruning
  if (m === "lifetime_all") return;

  // lifetime_capped: keep last N by (used_at DESC, id DESC)
  // delete everything older than the Nth newest, and handle same-timestamp ties via id
  const rows = await dbAll(
    db,
    `
    SELECT id, used_at
    FROM history
    WHERE scope_key=?
    ORDER BY used_at DESC, id DESC
    LIMIT 1 OFFSET ?
    `,
    [key, cap - 1],
  );
  if (!rows.length) return;

  const thrId = rows[0].id;
  const thrUsedAt = rows[0].used_at;

  await dbRun(
    db,
    `
    DELETE FROM history
    WHERE scope_key=?
      AND (
        used_at < ?
        OR (used_at = ? AND id < ?)
      )
    `,
    [key, thrUsedAt, thrUsedAt, thrId],
  );
}

module.exports = {
  openDb,
  getExcludedSet,
  recordUsed,
  prune,
};
