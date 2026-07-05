const fs = require("node:fs");
const fsp = require("node:fs/promises");
const mime = require("mime-types");

async function verifyFileReadable(filePath) {
  await fsp.access(filePath, fs.constants.R_OK);
}

function buildStreamResponse(baseUrl, fileRecord, streamInfo = {}) {
  const extension = String(fileRecord.extension || "").replace(".", "").toUpperCase() || "FILE";
  const parts = ["NAS"];
  if (streamInfo.quality) {
    parts.push(streamInfo.quality);
  }
  parts.push(extension);
  if (streamInfo.size_label) {
    parts.push(streamInfo.size_label);
  }
  const title = parts.join(" - ");

  return {
    streams: [
      {
        name: "NAS",
        title,
        url: `${baseUrl}/file/${encodeURIComponent(fileRecord.file_id)}`,
        behaviorHints: {
          notWebReady: true
        }
      }
    ]
  };
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
  sendFileStream,
  verifyFileReadable
};
