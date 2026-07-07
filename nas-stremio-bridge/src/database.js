const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function normalizeMediaPath(mediaPath) {
  return String(mediaPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function toPathPrefixes(mediaPaths) {
  return mediaPaths.map((mediaPath) => `${normalizeMediaPath(mediaPath)}/%`);
}

function buildPrefixWhere(prefixes, column = "files.path") {
  if (!prefixes.length) {
    return { sql: "1 = 0", params: [] };
  }

  const clauses = prefixes.map(() => `${column} LIKE ?`);
  return {
    sql: `(${clauses.join(" OR ")})`,
    params: prefixes
  };
}

function buildSearchPattern(searchText) {
  return `%${String(searchText || "").trim().toLowerCase()}%`;
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function createDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "index.db");
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      file_id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      media_type TEXT NOT NULL,
      size INTEGER,
      mtime INTEGER,
      extension TEXT,
      folder TEXT,
      is_available INTEGER DEFAULT 1,
      first_seen_at INTEGER,
      last_seen_at INTEGER,
      last_scanned_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS items (
      item_id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      stremio_id TEXT,
      imdb_id TEXT,
      tmdb_id INTEGER,
      media_type TEXT NOT NULL,
      title TEXT,
      original_title TEXT,
      year INTEGER,
      season INTEGER,
      episode INTEGER,
      overview TEXT,
      poster_path TEXT,
      backdrop_path TEXT,
      match_source TEXT,
      match_confidence REAL,
      needs_review INTEGER DEFAULT 0,
      manual_match INTEGER DEFAULT 0,
      metadata_language TEXT,
      metadata_fetched_at INTEGER,
      metadata_refresh_after INTEGER,
      FOREIGN KEY(file_id) REFERENCES files(file_id)
    );

    CREATE TABLE IF NOT EXISTS streams (
      stream_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      title TEXT,
      quality TEXT,
      codec TEXT,
      size_label TEXT,
      behavior_hints_json TEXT,
      FOREIGN KEY(item_id) REFERENCES items(item_id),
      FOREIGN KEY(file_id) REFERENCES files(file_id)
    );

    CREATE TABLE IF NOT EXISTS scan_runs (
      scan_id TEXT PRIMARY KEY,
      started_at INTEGER,
      finished_at INTEGER,
      status TEXT,
      files_seen INTEGER,
      files_added INTEGER,
      files_updated INTEGER,
      files_missing INTEGER,
      metadata_fetched INTEGER,
      errors INTEGER,
      error_log TEXT
    );

    CREATE TABLE IF NOT EXISTS settings_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    CREATE INDEX IF NOT EXISTS idx_files_media_type ON files(media_type);
    CREATE INDEX IF NOT EXISTS idx_files_last_seen ON files(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_items_file_id ON items(file_id);
    CREATE INDEX IF NOT EXISTS idx_items_media_type ON items(media_type);
    CREATE INDEX IF NOT EXISTS idx_items_stremio_id ON items(stremio_id);
    CREATE INDEX IF NOT EXISTS idx_items_imdb_id ON items(imdb_id);
    CREATE INDEX IF NOT EXISTS idx_items_needs_review ON items(needs_review);
    CREATE INDEX IF NOT EXISTS idx_streams_item_id ON streams(item_id);
  `);

  ensureColumn(db, "scan_runs", "files_ignored", "INTEGER DEFAULT 0");
  ensureColumn(db, "scan_runs", "auto_matched", "INTEGER DEFAULT 0");
  ensureColumn(db, "scan_runs", "manual_imdb_matched", "INTEGER DEFAULT 0");
  ensureColumn(db, "scan_runs", "suspicious_total", "INTEGER DEFAULT 0");
  ensureColumn(db, "items", "alternative_titles_json", "TEXT DEFAULT '[]'");

  const statements = {
    getState: db.prepare("SELECT value FROM settings_state WHERE key = ?"),
    setState: db.prepare(`
      INSERT INTO settings_state (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    getFileByPath: db.prepare("SELECT * FROM files WHERE path = ? LIMIT 1"),
    getFileById: db.prepare("SELECT * FROM files WHERE file_id = ? LIMIT 1"),
    upsertFile: db.prepare(`
      INSERT INTO files (
        file_id, path, media_type, size, mtime, extension, folder,
        is_available, first_seen_at, last_seen_at, last_scanned_at
      )
      VALUES (
        @file_id, @path, @media_type, @size, @mtime, @extension, @folder,
        @is_available, @first_seen_at, @last_seen_at, @last_scanned_at
      )
      ON CONFLICT(file_id) DO UPDATE SET
        path = excluded.path,
        media_type = excluded.media_type,
        size = excluded.size,
        mtime = excluded.mtime,
        extension = excluded.extension,
        folder = excluded.folder,
        is_available = excluded.is_available,
        last_seen_at = excluded.last_seen_at,
        last_scanned_at = excluded.last_scanned_at
    `),
    getItemByFileId: db.prepare("SELECT * FROM items WHERE file_id = ? LIMIT 1"),
    getItemByItemId: db.prepare("SELECT items.*, files.path, files.is_available, files.extension, files.size FROM items JOIN files ON files.file_id = items.file_id WHERE items.item_id = ? LIMIT 1"),
    upsertItem: db.prepare(`
      INSERT INTO items (
        item_id, file_id, stremio_id, imdb_id, tmdb_id, media_type, title, original_title,
        year, season, episode, overview, poster_path, backdrop_path, match_source,
        match_confidence, needs_review, manual_match, metadata_language, metadata_fetched_at,
        metadata_refresh_after, alternative_titles_json
      )
      VALUES (
        @item_id, @file_id, @stremio_id, @imdb_id, @tmdb_id, @media_type, @title, @original_title,
        @year, @season, @episode, @overview, @poster_path, @backdrop_path, @match_source,
        @match_confidence, @needs_review, @manual_match, @metadata_language, @metadata_fetched_at,
        @metadata_refresh_after, @alternative_titles_json
      )
      ON CONFLICT(item_id) DO UPDATE SET
        file_id = excluded.file_id,
        stremio_id = excluded.stremio_id,
        imdb_id = excluded.imdb_id,
        tmdb_id = excluded.tmdb_id,
        media_type = excluded.media_type,
        title = excluded.title,
        original_title = excluded.original_title,
        year = excluded.year,
        season = excluded.season,
        episode = excluded.episode,
        overview = excluded.overview,
        poster_path = excluded.poster_path,
        backdrop_path = excluded.backdrop_path,
        match_source = excluded.match_source,
        match_confidence = excluded.match_confidence,
        needs_review = excluded.needs_review,
        manual_match = excluded.manual_match,
        metadata_language = excluded.metadata_language,
        metadata_fetched_at = excluded.metadata_fetched_at,
        metadata_refresh_after = excluded.metadata_refresh_after,
        alternative_titles_json = excluded.alternative_titles_json
    `),
    upsertStream: db.prepare(`
      INSERT INTO streams (
        stream_id, item_id, file_id, title, quality, codec, size_label, behavior_hints_json
      )
      VALUES (
        @stream_id, @item_id, @file_id, @title, @quality, @codec, @size_label, @behavior_hints_json
      )
      ON CONFLICT(stream_id) DO UPDATE SET
        item_id = excluded.item_id,
        file_id = excluded.file_id,
        title = excluded.title,
        quality = excluded.quality,
        codec = excluded.codec,
        size_label = excluded.size_label,
        behavior_hints_json = excluded.behavior_hints_json
    `),
    getStreamByFileId: db.prepare("SELECT * FROM streams WHERE file_id = ? LIMIT 1"),
    getLatestScanRun: db.prepare("SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 1")
  };

  statements.setState.run("schema_version", "1");

  const helpers = {
    db,
    close() {
      db.close();
    },
    getState(key) {
      const row = statements.getState.get(key);
      return row ? row.value : null;
    },
    setState(key, value) {
      statements.setState.run(key, String(value));
    },
    startScanRun(scanId, startedAt) {
      db.prepare(`
        INSERT INTO scan_runs (
          scan_id, started_at, status, files_seen, files_added, files_updated,
          files_missing, metadata_fetched, errors, error_log, files_ignored,
          auto_matched, manual_imdb_matched, suspicious_total
        )
        VALUES (?, ?, 'running', 0, 0, 0, 0, 0, 0, '', 0, 0, 0, 0)
      `).run(scanId, startedAt);
      helpers.setState("scanner_running", "1");
    },
    finishScanRun(scanId, result) {
      db.prepare(`
        UPDATE scan_runs
        SET finished_at = ?, status = ?, files_seen = ?, files_added = ?, files_updated = ?,
            files_missing = ?, metadata_fetched = ?, errors = ?, error_log = ?,
            files_ignored = ?, auto_matched = ?, manual_imdb_matched = ?, suspicious_total = ?
        WHERE scan_id = ?
      `).run(
        result.finished_at,
        result.status,
        result.files_seen,
        result.files_added,
        result.files_updated,
        result.files_missing,
        result.metadata_fetched,
        result.errors,
        result.error_log,
        result.files_ignored || 0,
        result.auto_matched || 0,
        result.manual_imdb_matched || 0,
        result.suspicious_total || 0,
        scanId
      );
      helpers.setState("scanner_running", "0");
      if (result.status === "success") {
        helpers.setState("last_successful_scan_at", String(result.finished_at));
      }
    },
    getFileByPath(filePath) {
      return statements.getFileByPath.get(filePath);
    },
    getFileById(fileId) {
      return statements.getFileById.get(fileId);
    },
    upsertFile(fileRecord) {
      statements.upsertFile.run(fileRecord);
    },
    getItemByFileId(fileId) {
      return statements.getItemByFileId.get(fileId);
    },
    getItemByItemId(itemId) {
      return statements.getItemByItemId.get(itemId);
    },
    upsertItem(itemRecord) {
      statements.upsertItem.run(itemRecord);
    },
    upsertStream(streamRecord) {
      statements.upsertStream.run(streamRecord);
    },
    getStreamByFileId(fileId) {
      return statements.getStreamByFileId.get(fileId);
    },
    listMoviesByCatalogPath(mediaPath) {
      return db.prepare(`
        SELECT items.*, files.path, files.is_available, files.extension, files.size, files.folder, files.mtime, files.last_seen_at
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.media_type = 'movie'
          AND files.is_available = 1
          AND files.path LIKE ?
        ORDER BY COALESCE(items.year, 0) DESC, LOWER(COALESCE(items.title, files.path)) ASC
      `).all(`${normalizeMediaPath(mediaPath)}/%`);
    },
    searchMoviesByCatalogPath(mediaPath, searchText) {
      const pattern = buildSearchPattern(searchText);
      return db.prepare(`
        SELECT items.*, files.path, files.is_available, files.extension, files.size, files.folder, files.mtime, files.last_seen_at
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.media_type = 'movie'
          AND files.is_available = 1
          AND files.path LIKE ?
          AND (
            LOWER(COALESCE(items.title, '')) LIKE ?
            OR LOWER(COALESCE(items.original_title, '')) LIKE ?
            OR LOWER(COALESCE(files.folder, '')) LIKE ?
            OR LOWER(files.path) LIKE ?
          )
        ORDER BY COALESCE(items.year, 0) DESC, LOWER(COALESCE(items.title, files.path)) ASC
      `).all(`${normalizeMediaPath(mediaPath)}/%`, pattern, pattern, pattern, pattern);
    },
    listSeriesByCatalogPath(mediaPath) {
      return db.prepare(`
        SELECT items.*, files.path, files.is_available, files.extension, files.size, files.folder, files.mtime, files.last_seen_at
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.media_type = 'series'
          AND files.is_available = 1
          AND files.path LIKE ?
        ORDER BY LOWER(COALESCE(items.title, files.path)) ASC, COALESCE(items.season, 0), COALESCE(items.episode, 0)
      `).all(`${normalizeMediaPath(mediaPath)}/%`);
    },
    searchSeriesByCatalogPath(mediaPath, searchText) {
      const pattern = buildSearchPattern(searchText);
      return db.prepare(`
        SELECT items.*, files.path, files.is_available, files.extension, files.size, files.folder, files.mtime, files.last_seen_at
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.media_type = 'series'
          AND files.is_available = 1
          AND files.path LIKE ?
          AND (
            LOWER(COALESCE(items.title, '')) LIKE ?
            OR LOWER(COALESCE(items.original_title, '')) LIKE ?
            OR LOWER(COALESCE(files.folder, '')) LIKE ?
            OR LOWER(files.path) LIKE ?
          )
        ORDER BY LOWER(COALESCE(items.title, files.path)) ASC, COALESCE(items.season, 0), COALESCE(items.episode, 0)
      `).all(`${normalizeMediaPath(mediaPath)}/%`, pattern, pattern, pattern, pattern);
    },
    findMovieByAnyId(id) {
      return db.prepare(`
        SELECT items.*, files.path, files.is_available, files.extension, files.size, files.folder, files.mtime, files.last_seen_at
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.media_type = 'movie'
          AND (items.stremio_id = ? OR items.imdb_id = ? OR items.item_id = ? OR items.file_id = ?)
        LIMIT 1
      `).get(id, id, id, id);
    },
    listMovieCandidatesByAnyId(id) {
      return db.prepare(`
        SELECT
          items.*,
          files.path,
          files.is_available,
          files.extension,
          files.size,
          files.folder,
          files.mtime,
          files.last_seen_at,
          files.first_seen_at,
          streams.stream_id,
          streams.title AS stream_title,
          streams.quality AS stream_quality,
          streams.codec,
          streams.size_label,
          streams.behavior_hints_json
        FROM items
        JOIN files ON files.file_id = items.file_id
        LEFT JOIN streams ON streams.file_id = items.file_id
        WHERE items.media_type = 'movie'
          AND (items.stremio_id = ? OR items.imdb_id = ? OR items.item_id = ? OR items.file_id = ?)
      `).all(id, id, id, id);
    },
    findSeriesEpisodeByAnyId(id) {
      return db.prepare(`
        SELECT items.*, files.path, files.is_available, files.extension, files.size, files.folder, files.mtime, files.last_seen_at
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.media_type = 'series'
          AND (items.stremio_id = ? OR items.item_id = ? OR items.file_id = ?)
        LIMIT 1
      `).get(id, id, id);
    },
    listSeriesEpisodeCandidatesByAnyId(id) {
      return db.prepare(`
        SELECT
          items.*,
          files.path,
          files.is_available,
          files.extension,
          files.size,
          files.folder,
          files.mtime,
          files.last_seen_at,
          files.first_seen_at,
          streams.stream_id,
          streams.title AS stream_title,
          streams.quality AS stream_quality,
          streams.codec,
          streams.size_label,
          streams.behavior_hints_json
        FROM items
        JOIN files ON files.file_id = items.file_id
        LEFT JOIN streams ON streams.file_id = items.file_id
        WHERE items.media_type = 'series'
          AND (items.stremio_id = ? OR items.item_id = ? OR items.file_id = ?)
      `).all(id, id, id);
    },
    listAllAvailableSeries() {
      return db.prepare(`
        SELECT items.*, files.path, files.is_available, files.extension, files.size, files.folder, files.mtime, files.last_seen_at
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.media_type = 'series'
          AND files.is_available = 1
        ORDER BY LOWER(COALESCE(items.title, files.path)) ASC, COALESCE(items.season, 0), COALESCE(items.episode, 0)
      `).all();
    },
    listUnmatched() {
      return db.prepare(`
        SELECT items.*, files.path, files.is_available
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.needs_review = 1
          AND files.is_available = 1
        ORDER BY files.last_seen_at DESC
      `).all();
    },
    listItemsForAudit(includeUnavailable = false) {
      const availabilityClause = includeUnavailable ? "" : "WHERE files.is_available = 1";
      return db.prepare(`
        SELECT items.*, files.path, files.is_available, files.extension, files.size, files.folder, files.mtime, files.last_seen_at
        FROM items
        JOIN files ON files.file_id = items.file_id
        ${availabilityClause}
        ORDER BY files.last_seen_at DESC, LOWER(COALESCE(items.title, files.path)) ASC
      `).all();
    },
    searchItems(searchText, limit = 50) {
      const pattern = buildSearchPattern(searchText);
      return db.prepare(`
        SELECT items.*, files.path, files.is_available, files.extension, files.size, files.folder, files.mtime, files.last_seen_at
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE (
          LOWER(COALESCE(items.title, '')) LIKE ?
          OR LOWER(COALESCE(items.original_title, '')) LIKE ?
          OR LOWER(COALESCE(items.imdb_id, '')) LIKE ?
          OR LOWER(COALESCE(files.path, '')) LIKE ?
          OR LOWER(COALESCE(files.folder, '')) LIKE ?
        )
        ORDER BY files.is_available DESC, files.last_seen_at DESC, LOWER(COALESCE(items.title, files.path)) ASC
        LIMIT ?
      `).all(pattern, pattern, pattern, pattern, pattern, Math.max(1, Number(limit) || 50));
    },
    getStatus(mediaPaths) {
      const prefixes = toPathPrefixes(mediaPaths);
      const where = buildPrefixWhere(prefixes);

      const baseParams = where.params;
      const itemsTotal = db.prepare(`
        SELECT COUNT(*)
        AS total
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE files.is_available = 1 AND ${where.sql}
      `).get(...baseParams).total;

      const moviesTotal = db.prepare(`
        SELECT COUNT(*)
        AS total
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.media_type = 'movie' AND files.is_available = 1 AND ${where.sql}
      `).get(...baseParams).total;

      const episodesTotal = db.prepare(`
        SELECT COUNT(*)
        AS total
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.media_type = 'series' AND files.is_available = 1 AND ${where.sql}
      `).get(...baseParams).total;

      const unmatchedTotal = db.prepare(`
        SELECT COUNT(*)
        AS total
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.needs_review = 1 AND files.is_available = 1 AND ${where.sql}
      `).get(...baseParams).total;

      const seriesTotal = db.prepare(`
        SELECT COUNT(DISTINCT COALESCE(items.imdb_id, items.title || ':' || COALESCE(items.year, '')))
        AS total
        FROM items
        JOIN files ON files.file_id = items.file_id
        WHERE items.media_type = 'series' AND files.is_available = 1 AND ${where.sql}
      `).get(...baseParams).total;

      const latest = statements.getLatestScanRun.get();
      let lastAuditSummary = null;
      try {
        const raw = helpers.getState("last_audit_summary_json");
        lastAuditSummary = raw ? JSON.parse(raw) : null;
      } catch (_) {
        lastAuditSummary = null;
      }

      return {
        scanner_running: helpers.getState("scanner_running") === "1",
        last_successful_scan_at: Number(helpers.getState("last_successful_scan_at") || 0),
        next_scheduled_scan_at: Number(helpers.getState("next_scheduled_scan_at") || 0),
        items_total: itemsTotal,
        movies_total: moviesTotal,
        series_total: seriesTotal,
        episodes_total: episodesTotal,
        unmatched_total: unmatchedTotal,
        latest_scan_run: latest || null,
        last_audit_summary: lastAuditSummary
      };
    },
    applyManualMatch(fileId, payload) {
      const existing = helpers.getItemByFileId(fileId);
      if (!existing) {
        return null;
      }

      const isSeries = payload.type === "series";
      const season = payload.season || existing.season || null;
      const episode = payload.episode || existing.episode || null;
      const stremioId = isSeries
        ? payload.imdb_id && season && episode
          ? `${payload.imdb_id}:${season}:${episode}`
          : String(existing.stremio_id || `nas_series_${fileId}`)
        : String(payload.imdb_id || existing.imdb_id || existing.stremio_id || `nas_movie_${fileId}`);

      const nextItem = {
        ...existing,
        stremio_id: stremioId,
        imdb_id: payload.imdb_id || existing.imdb_id,
        tmdb_id: payload.tmdb_id || existing.tmdb_id,
        media_type: payload.type || existing.media_type,
        title: payload.title || existing.title,
        original_title: payload.original_title || existing.original_title,
        year: payload.year || existing.year,
        season,
        episode,
        overview: payload.overview || existing.overview,
        poster_path: payload.poster_path || existing.poster_path,
        backdrop_path: payload.backdrop_path || existing.backdrop_path,
        match_source: "manual",
        match_confidence: 1,
        needs_review: 0,
        manual_match: 1,
        alternative_titles_json: existing.alternative_titles_json || "[]",
        metadata_language: existing.metadata_language,
        metadata_fetched_at: existing.metadata_fetched_at,
        metadata_refresh_after: existing.metadata_refresh_after
      };

      helpers.upsertItem(nextItem);
      return helpers.getItemByFileId(fileId);
    },
    refreshItemMetadata(itemRecord) {
      helpers.upsertItem(itemRecord);
      return helpers.getItemByItemId(itemRecord.item_id);
    },
    markMissingFiles(scanStartedAt, mediaPaths, scanConfig) {
      const prefixes = toPathPrefixes(mediaPaths);
      const where = buildPrefixWhere(prefixes);

      const missingFiles = db.prepare(`
        SELECT file_id
        FROM files
        WHERE is_available = 1
          AND last_seen_at < ?
          AND ${where.sql.replace(/files\./g, "")}
      `).all(scanStartedAt, ...where.params);

      if (!missingFiles.length) {
        return 0;
      }

      const markUnavailable = db.prepare(`
        UPDATE files
        SET is_available = 0
        WHERE file_id = ?
      `);
      const deleteStreams = db.prepare("DELETE FROM streams WHERE file_id = ?");
      const deleteItems = db.prepare("DELETE FROM items WHERE file_id = ?");
      const deleteFiles = db.prepare("DELETE FROM files WHERE file_id = ?");

      const transaction = db.transaction(() => {
        for (const row of missingFiles) {
          if (scanConfig.remove_missing) {
            deleteStreams.run(row.file_id);
            deleteItems.run(row.file_id);
            deleteFiles.run(row.file_id);
            continue;
          }

          if (scanConfig.mark_missing_unavailable) {
            markUnavailable.run(row.file_id);
          }
        }
      });

      transaction();
      return missingFiles.length;
    }
  };

  return helpers;
}

module.exports = {
  createDatabase
};
