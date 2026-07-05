const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveItemMetadata } = require("./metadata");

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function createId(prefix, value) {
  return `${prefix}_${sha1(value).slice(0, 16)}`;
}

function formatSizeLabel(bytes) {
  if (!bytes || bytes <= 0) {
    return null;
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function shouldIgnore(entryName, ignorePatterns) {
  const lowerName = entryName.toLowerCase();
  return ignorePatterns.some((pattern) => lowerName.includes(pattern));
}

async function walkMediaDirectory(rootPath, options, onFile) {
  const stack = [rootPath];

  while (stack.length) {
    const currentPath = stack.pop();
    let entries = [];

    try {
      entries = await fsp.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      options.logger.warn(`Cannot read directory ${currentPath}: ${error.message}`);
      continue;
    }

    for (const entry of entries) {
      if (shouldIgnore(entry.name, options.ignorePatterns)) {
        continue;
      }

      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!options.allowedExtensions.includes(extension)) {
        continue;
      }

      let stats;
      try {
        stats = await fsp.stat(fullPath);
      } catch (error) {
        options.logger.warn(`Cannot stat file ${fullPath}: ${error.message}`);
        continue;
      }

      await onFile(fullPath, stats, extension);
    }
  }
}

function buildStremioId(mediaType, fileId, metadata) {
  if (mediaType === "series") {
    if (metadata.imdb_id && metadata.season && metadata.episode) {
      return `${metadata.imdb_id}:${metadata.season}:${metadata.episode}`;
    }
    return `nas_series_${fileId}`;
  }

  return metadata.imdb_id || `nas_movie_${fileId}`;
}

function shouldRefreshMetadata(existingItem, fileChanged, config, forceMetadataRefresh) {
  if (forceMetadataRefresh) {
    return true;
  }

  if (!existingItem) {
    return true;
  }

  if (existingItem.manual_match) {
    return false;
  }

  if (!config.metadata.enabled) {
    return false;
  }

  if (config.metadata.only_fetch_for_new_items && !fileChanged) {
    return false;
  }

  if (!existingItem.metadata_fetched_at) {
    return true;
  }

  if (config.metadata.refresh_existing && existingItem.metadata_refresh_after) {
    return existingItem.metadata_refresh_after <= nowTs();
  }

  return fileChanged;
}

function createScanner({ config, database, logger, dataDir }) {
  const cacheDirs = {
    posters: path.join(dataDir, "posters"),
    backdrops: path.join(dataDir, "backdrops"),
    metadata: path.join(dataDir, "metadata")
  };

  let runningPromise = null;

  function buildItemRecord(fileRecord, resolved, existingItem) {
    const itemId = createId("item", fileRecord.file_id);
    return {
      item_id: itemId,
      file_id: fileRecord.file_id,
      stremio_id: buildStremioId(fileRecord.media_type, fileRecord.file_id, resolved.metadata),
      imdb_id: resolved.metadata.imdb_id,
      tmdb_id: resolved.metadata.tmdb_id,
      media_type: fileRecord.media_type,
      title: resolved.metadata.title || path.basename(fileRecord.path, fileRecord.extension),
      original_title: resolved.metadata.original_title || resolved.metadata.title || path.basename(fileRecord.path, fileRecord.extension),
      year: resolved.metadata.year,
      season: resolved.metadata.season,
      episode: resolved.metadata.episode,
      overview: resolved.metadata.overview,
      poster_path: resolved.metadata.poster_path,
      backdrop_path: resolved.metadata.backdrop_path,
      match_source: resolved.metadata.match_source,
      match_confidence: resolved.metadata.match_confidence,
      needs_review: resolved.metadata.needs_review,
      manual_match: resolved.metadata.manual_match,
      metadata_language: resolved.metadata.metadata_language,
      metadata_fetched_at: resolved.metadata.metadata_fetched_at,
      metadata_refresh_after: resolved.metadata.metadata_refresh_after
    };
  }

  function upsertStreamForItem(fileRecord, itemRecord, quality) {
    database.upsertStream({
      stream_id: createId("stream", fileRecord.file_id),
      item_id: itemRecord.item_id,
      file_id: fileRecord.file_id,
      title: itemRecord.title,
      quality,
      codec: null,
      size_label: formatSizeLabel(fileRecord.size),
      behavior_hints_json: JSON.stringify({ notWebReady: true, bingeGroup: "nas-local" })
    });
  }

  async function runScan(options = {}) {
    if (runningPromise) {
      return { started: false, promise: runningPromise };
    }

    runningPromise = executeScan(options).finally(() => {
      runningPromise = null;
    });

    return { started: true, promise: runningPromise };
  }

  async function executeScan(options = {}) {
    const startedAt = nowTs();
    const scanId = createId("scan", `${startedAt}:${Math.random()}`);
    const scanType = options.scan_type || config.scan.scan_type || "light";
    const forceMetadataRefresh = Boolean(options.force_metadata_refresh);
    const summary = {
      finished_at: startedAt,
      status: "success",
      files_seen: 0,
      files_added: 0,
      files_updated: 0,
      files_missing: 0,
      metadata_fetched: 0,
      errors: 0,
      error_log: ""
    };

    database.startScanRun(scanId, startedAt);
    logger.info(`Scan started (${scanType})`);

    try {
      for (const mediaPath of config.media.paths) {
        if (!(await pathExists(mediaPath.path))) {
          logger.warn(`Media path not found: ${mediaPath.path}`);
          continue;
        }

        await walkMediaDirectory(mediaPath.path, {
          allowedExtensions: config.media.allowed_extensions,
          ignorePatterns: config.media.ignore_patterns,
          logger
        }, async (filePath, stats, extension) => {
          summary.files_seen += 1;

          const existingFile = database.getFileByPath(filePath);
          const fileId = existingFile ? existingFile.file_id : createId("file", filePath);
          const fileChanged = !existingFile || Number(existingFile.size) !== Number(stats.size) || Number(existingFile.mtime) !== Number(Math.floor(stats.mtimeMs));

          const fileRecord = {
            file_id: fileId,
            path: filePath,
            media_type: mediaPath.type,
            size: stats.size,
            mtime: Math.floor(stats.mtimeMs),
            extension,
            folder: path.basename(path.dirname(filePath)),
            is_available: 1,
            first_seen_at: existingFile ? existingFile.first_seen_at : startedAt,
            last_seen_at: startedAt,
            last_scanned_at: startedAt
          };

          database.upsertFile(fileRecord);

          if (!existingFile) {
            summary.files_added += 1;
          } else if (fileChanged || !existingFile.is_available) {
            summary.files_updated += 1;
          }

          const existingItem = database.getItemByFileId(fileId);
          const refreshMetadata = shouldRefreshMetadata(existingItem, fileChanged, config, forceMetadataRefresh);

          let resolved;
          if (refreshMetadata) {
            resolved = await resolveItemMetadata({
              filePath,
              mediaType: mediaPath.type,
              config,
              cacheDirs,
              existingItem,
              forceRefresh: forceMetadataRefresh || scanType === "deep",
              logger
            });

            if (resolved.metadata.metadata_fetched_at) {
              summary.metadata_fetched += 1;
            }
          } else if (existingItem) {
            resolved = {
              parsed: {
                title: existingItem.title,
                year: existingItem.year,
                season: existingItem.season,
                episode: existingItem.episode,
                quality: null
              },
              metadata: {
                imdb_id: existingItem.imdb_id,
                tmdb_id: existingItem.tmdb_id,
                title: existingItem.title,
                original_title: existingItem.original_title,
                year: existingItem.year,
                season: existingItem.season,
                episode: existingItem.episode,
                overview: existingItem.overview,
                poster_path: existingItem.poster_path,
                backdrop_path: existingItem.backdrop_path,
                match_source: existingItem.match_source,
                match_confidence: existingItem.match_confidence,
                needs_review: existingItem.needs_review,
                manual_match: existingItem.manual_match,
                metadata_language: existingItem.metadata_language,
                metadata_fetched_at: existingItem.metadata_fetched_at,
                metadata_refresh_after: existingItem.metadata_refresh_after
              }
            };
          } else {
            resolved = await resolveItemMetadata({
              filePath,
              mediaType: mediaPath.type,
              config,
              cacheDirs,
              existingItem: null,
              forceRefresh: false,
              logger
            });
          }

          const itemRecord = buildItemRecord(fileRecord, resolved, existingItem);
          database.upsertItem(itemRecord);
          upsertStreamForItem(fileRecord, itemRecord, resolved.parsed.quality);
        });
      }

      summary.files_missing = database.markMissingFiles(startedAt, config.media.paths.map((entry) => entry.path), config.scan);
    } catch (error) {
      summary.status = "error";
      summary.errors += 1;
      summary.error_log = `${error.name}: ${error.message}`;
      logger.error(`Scan failed: ${error.stack || error.message}`);
    }

    summary.finished_at = nowTs();
    database.finishScanRun(scanId, summary);
    logger.info(`Scan finished: seen=${summary.files_seen}, added=${summary.files_added}, updated=${summary.files_updated}, metadata=${summary.metadata_fetched}, missing=${summary.files_missing}`);

    return {
      scan_id: scanId,
      ...summary
    };
  }

  return {
    runScan,
    async refreshItemMetadata(itemId) {
      const item = database.getItemByItemId(itemId);
      if (!item) {
        throw new Error("Item not found");
      }

      const fileRecord = database.getFileById(item.file_id);
      if (!fileRecord) {
        throw new Error("Underlying file record not found");
      }

      const resolved = await resolveItemMetadata({
        filePath: item.path,
        mediaType: item.media_type,
        config,
        cacheDirs,
        existingItem: item,
        forceRefresh: true,
        logger
      });

      const itemRecord = buildItemRecord(fileRecord, resolved, item);
      database.upsertItem(itemRecord);
      upsertStreamForItem(fileRecord, itemRecord, resolved.parsed.quality);
      return database.getItemByItemId(itemId);
    },
    isRunning() {
      return Boolean(runningPromise);
    }
  };
}

module.exports = {
  createScanner
};
