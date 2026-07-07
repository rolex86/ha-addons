const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const mime = require("mime-types");
const { parseMediaFromPath } = require("./metadata");

async function verifyFileReadable(filePath) {
  await fsp.access(filePath, fs.constants.R_OK);
}

function formatSizeLabel(bytes) {
  if (!bytes || bytes <= 0) {
    return null;
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function buildEpisodeLabel(item) {
  if (!item || !item.season || !item.episode) {
    return null;
  }

  return `S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`;
}

function qualityRank(value) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === "2160P") {
    return 4;
  }
  if (normalized === "1080P") {
    return 3;
  }
  if (normalized === "720P") {
    return 2;
  }
  if (normalized === "480P") {
    return 1;
  }
  return 0;
}

function sortStreamCandidates(candidates = []) {
  return [...candidates].sort((left, right) => {
    if (Number(right.is_available || 0) !== Number(left.is_available || 0)) {
      return Number(right.is_available || 0) - Number(left.is_available || 0);
    }

    const lastSeenDiff = Number(right.last_seen_at || 0) - Number(left.last_seen_at || 0);
    if (lastSeenDiff !== 0) {
      return lastSeenDiff;
    }

    const mtimeDiff = Number(right.mtime || 0) - Number(left.mtime || 0);
    if (mtimeDiff !== 0) {
      return mtimeDiff;
    }

    const qualityDiff = qualityRank(right.release_quality || right.stream_quality) - qualityRank(left.release_quality || left.stream_quality);
    if (qualityDiff !== 0) {
      return qualityDiff;
    }

    const sizeDiff = Number(right.size || 0) - Number(left.size || 0);
    if (sizeDiff !== 0) {
      return sizeDiff;
    }

    return String(left.path || "").localeCompare(String(right.path || ""));
  });
}

function enrichCandidate(candidate) {
  const parsed = parseMediaFromPath(candidate.path, candidate.media_type);
  return {
    ...candidate,
    release_quality: candidate.stream_quality || parsed.quality || null,
    release_source: parsed.source || null,
    file_name: path.basename(candidate.path || ""),
    folder_name: path.basename(path.dirname(candidate.path || "")),
    size_label: candidate.size_label || formatSizeLabel(candidate.size),
    episode_label: buildEpisodeLabel(candidate)
  };
}

function buildStreamName(candidate) {
  const nameBits = ["NAS", candidate.title || candidate.original_title || "Soubor"];
  if (candidate.media_type === "movie" && candidate.year) {
    nameBits[nameBits.length - 1] = `${nameBits[nameBits.length - 1]} (${candidate.year})`;
  }

  return nameBits.join(" • ");
}

function buildStreamTitle(candidate, config) {
  const infoBits = [];
  if (candidate.media_type === "series" && candidate.episode_label) {
    infoBits.push(candidate.episode_label);
  }
  if (candidate.release_quality) {
    infoBits.push(candidate.release_quality);
  }
  if (candidate.release_source) {
    infoBits.push(candidate.release_source);
  }

  const extension = String(candidate.extension || "").replace(".", "").toUpperCase() || "FILE";
  infoBits.push(extension);
  if (candidate.size_label) {
    infoBits.push(candidate.size_label);
  }

  const lines = [infoBits.join(" • ")];
  if (config.streaming.show_filename_in_title) {
    lines.push(`Soubor: ${candidate.file_name}`);
  }
  if (config.streaming.show_folder_in_title) {
    lines.push(`Slozka: ${candidate.folder_name}`);
  }

  return lines.join("\n");
}

function buildStreamResponse(baseUrl, candidates = [], config) {
  const ordered = sortStreamCandidates(candidates).map(enrichCandidate);
  const preferred = ordered.filter((candidate) => Number(candidate.is_available || 0) === 1);
  const selected = preferred.length ? preferred : ordered;

  return {
    streams: selected.map((candidate) => ({
      name: buildStreamName(candidate),
      title: buildStreamTitle(candidate, config),
      url: `${baseUrl}/file/${encodeURIComponent(candidate.file_id)}`,
      behaviorHints: {
        notWebReady: true
      }
    }))
  };
}

function pickPrimaryCandidate(candidates = []) {
  const ordered = sortStreamCandidates(candidates).map(enrichCandidate);
  const preferred = ordered.find((candidate) => Number(candidate.is_available || 0) === 1);
  return preferred || ordered[0] || null;
}

function parseRange(rangeHeader, totalSize) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || "").trim());
  if (!match) {
    return null;
  }

  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);

  if (start === null && end === null) {
    return null;
  }

  if (start === null) {
    const suffixLength = end;
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else if (end === null || end >= totalSize) {
    end = totalSize - 1;
  }

  if (start < 0 || end < start || start >= totalSize) {
    return { invalid: true };
  }

  return { start, end };
}

async function sendFileStream(req, res, fileRecord, config) {
  const stat = await fsp.stat(fileRecord.path);
  const totalSize = stat.size;
  const contentType = mime.lookup(fileRecord.path) || config.streaming.mime_fallback || "video/mp4";
  const rangeHeader = config.streaming.enable_range_requests ? req.headers.range : null;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, no-store");

  const pipeReadStream = (streamOptions = {}, statusCode = 200, extraHeaders = {}) => new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(fileRecord.path, streamOptions);
    let settled = false;

    readStream.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (!res.headersSent) {
        reject(error);
        return;
      }
      res.destroy(error);
    });

    readStream.on("open", () => {
      if (settled) {
        return;
      }
      settled = true;
      res.status(statusCode);
      for (const [header, value] of Object.entries(extraHeaders)) {
        res.setHeader(header, value);
      }
      readStream.pipe(res);
      resolve();
    });
  });

  if (!rangeHeader) {
    res.setHeader("Content-Length", totalSize);
    await pipeReadStream({}, 200);
    return;
  }

  const parsedRange = parseRange(rangeHeader, totalSize);
  if (!parsedRange || parsedRange.invalid) {
    res.setHeader("Content-Range", `bytes */${totalSize}`);
    res.status(416).end();
    return;
  }

  const chunkSize = parsedRange.end - parsedRange.start + 1;
  await pipeReadStream({
    start: parsedRange.start,
    end: parsedRange.end
  }, 206, {
    "Content-Range": `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`,
    "Content-Length": chunkSize
  });
}

module.exports = {
  buildStreamResponse,
  pickPrimaryCandidate,
  sendFileStream,
  sortStreamCandidates,
  verifyFileReadable
};
