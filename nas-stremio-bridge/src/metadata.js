const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const VIDEO_TAGS = [
  "2160p", "1080p", "720p", "480p", "bluray", "brrip", "webrip", "web-dl",
  "hdrip", "dvdrip", "x264", "x265", "h264", "h265", "hevc", "dts", "aac",
  "ac3", "truehd", "atmos", "sample", "trailer"
];

function normalizeWhitespace(value) {
  return String(value || "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTitle(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function extractImdbIdFromText(value) {
  const match = String(value || "").match(/tt\d{7,10}/i);
  return match ? match[0].toLowerCase() : null;
}

function readNfoImdbId(filePath) {
  const basename = path.basename(filePath, path.extname(filePath));
  const directory = path.dirname(filePath);
  const candidates = [
    path.join(directory, `${basename}.nfo`),
    path.join(directory, "movie.nfo"),
    path.join(directory, "tvshow.nfo")
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const imdbMatch = raw.match(/<imdbid>\s*(tt\d{7,10})\s*<\/imdbid>/i);
      if (imdbMatch) {
        return imdbMatch[1].toLowerCase();
      }

      const urlMatch = raw.match(/imdb\.com\/title\/(tt\d{7,10})/i);
      if (urlMatch) {
        return urlMatch[1].toLowerCase();
      }
    } catch (_) {
      continue;
    }
  }

  return null;
}

function detectQuality(name) {
  const match = String(name || "").match(/(2160p|1080p|720p|480p)/i);
  return match ? match[1].toUpperCase() : null;
}

function extractSeriesEpisodeInfo(text) {
  const value = normalizeWhitespace(text);
  const patterns = [
    /\bS(\d{1,2})E(\d{1,3})\b/i,
    /\b(\d{1,2})x(\d{1,3})\b/i,
    /\bSeason\s*(\d{1,2})\s*Episode\s*(\d{1,3})\b/i,
    /\bSeason\s*(\d{1,2})\b.*\bEpisode\s*(\d{1,3})\b/i
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return {
        season: Number(match[1]),
        episode: Number(match[2]),
        index: match.index || 0
      };
    }
  }

  return null;
}

function parseMovieFilename(baseName) {
  const cleaned = normalizeWhitespace(baseName.replace(/\[[^\]]*tt\d{7,10}[^\]]*\]/ig, ""));
  const yearMatch = cleaned.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const cutPoint = yearMatch ? yearMatch.index : cleaned.length;
  const rawTitle = cleaned.slice(0, cutPoint);
  const title = normalizeWhitespace(
    rawTitle
      .split(" ")
      .filter((part) => !VIDEO_TAGS.includes(part.toLowerCase()))
      .join(" ")
  );

  return {
    type: "movie",
    title: title || cleaned,
    year,
    quality: detectQuality(cleaned)
  };
}

function parseSeriesFilename(baseName, filePath) {
  const cleaned = normalizeWhitespace(baseName);
  const episodeInfo = extractSeriesEpisodeInfo(cleaned);
  const yearMatch = cleaned.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);

  if (episodeInfo) {
    const title = normalizeWhitespace(cleaned.slice(0, episodeInfo.index));
    return {
      type: "series",
      title: title || cleaned,
      year: yearMatch ? Number(yearMatch[1]) : null,
      season: episodeInfo.season,
      episode: episodeInfo.episode,
      quality: detectQuality(cleaned)
    };
  }

  const folderName = path.basename(path.dirname(filePath || baseName));
  const parentFolderName = path.basename(path.dirname(path.dirname(filePath || baseName)));
  const seasonFromFolder = normalizeWhitespace(folderName).match(/\bSeason\s*(\d{1,2})\b/i);
  const episodeFromFilename = normalizeWhitespace(cleaned).match(/\bEpisode\s*(\d{1,3})\b/i);

  if (seasonFromFolder && episodeFromFilename) {
    return {
      type: "series",
      title: normalizeWhitespace(parentFolderName || cleaned),
      year: yearMatch ? Number(yearMatch[1]) : null,
      season: Number(seasonFromFolder[1]),
      episode: Number(episodeFromFilename[1]),
      quality: detectQuality(cleaned)
    };
  }

  return null;
}

function parseMediaFromPath(filePath, mediaType) {
  const baseName = path.basename(filePath, path.extname(filePath));
  if (mediaType === "series") {
    return parseSeriesFilename(baseName, filePath) || {
      type: "series",
      title: normalizeWhitespace(baseName),
      season: null,
      episode: null,
      year: null,
      quality: detectQuality(baseName)
    };
  }

  return parseMovieFilename(baseName);
}

function createPublicAssetPath(kind, key) {
  return `/${kind}/${key}.jpg`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function downloadToFile(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await fsp.writeFile(targetPath, Buffer.from(arrayBuffer));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

function scoreTmdbCandidate(parsed, candidate) {
  const parsedTitle = normalizeTitle(parsed.title);
  const candidateTitle = normalizeTitle(candidate.title || candidate.name);
  let score = 0.55;

  if (parsedTitle && candidateTitle === parsedTitle) {
    score += 0.3;
  } else if (parsedTitle && candidateTitle.includes(parsedTitle)) {
    score += 0.15;
  }

  const candidateYear = Number(String(candidate.release_date || candidate.first_air_date || "").slice(0, 4)) || null;
  if (parsed.year && candidateYear) {
    if (parsed.year === candidateYear) {
      score += 0.15;
    } else if (Math.abs(parsed.year - candidateYear) === 1) {
      score += 0.05;
    } else {
      score -= 0.1;
    }
  }

  return Math.max(0, Math.min(1, score));
}

function buildTmdbAssetUrl(assetPath) {
  return assetPath ? `https://image.tmdb.org/t/p/original${assetPath}` : null;
}

async function maybeCacheAsset(url, targetPath, forceRefresh) {
  if (!url) {
    return false;
  }
  if (!forceRefresh && fs.existsSync(targetPath)) {
    return false;
  }
  await downloadToFile(url, targetPath);
  return true;
}

async function fetchTmdbDetailsByTmdbId(mediaType, tmdbId, config) {
  const primaryLanguage = config.metadata.language;
  const fallbackLanguage = config.metadata.fallback_language;
  const language = encodeURIComponent(primaryLanguage);
  const apiKey = encodeURIComponent(config.metadata.tmdb_api_key);
  const tmdbType = mediaType === "series" ? "tv" : "movie";
  const detailsUrl = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${apiKey}&language=${language}`;
  const externalIdsUrl = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}/external_ids?api_key=${apiKey}`;

  const [details, externalIds] = await Promise.all([
    fetchJson(detailsUrl),
    fetchJson(externalIdsUrl)
  ]);

  if (fallbackLanguage && fallbackLanguage !== primaryLanguage) {
    const needsFallback = !details.overview || !(details.title || details.name || details.original_title || details.original_name);
    if (needsFallback) {
      const fallbackUrl = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${apiKey}&language=${encodeURIComponent(fallbackLanguage)}`;
      const fallbackDetails = await fetchJson(fallbackUrl);
      return {
        details: {
          ...fallbackDetails,
          ...details,
          overview: details.overview || fallbackDetails.overview,
          title: details.title || fallbackDetails.title,
          name: details.name || fallbackDetails.name,
          original_title: details.original_title || fallbackDetails.original_title,
          original_name: details.original_name || fallbackDetails.original_name
        },
        externalIds
      };
    }
  }

  return {
    details,
    externalIds
  };
}

async function fetchTmdbDetailsByImdbId(imdbId, mediaType, config) {
  const apiKey = encodeURIComponent(config.metadata.tmdb_api_key);
  const findUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${apiKey}&external_source=imdb_id`;
  const findResult = await fetchJson(findUrl);
  const collection = mediaType === "series" ? findResult.tv_results : findResult.movie_results;
  if (!Array.isArray(collection) || !collection.length) {
    return null;
  }

  return fetchTmdbDetailsByTmdbId(mediaType, collection[0].id, config);
}

async function searchTmdb(parsed, mediaType, config) {
  const apiKey = encodeURIComponent(config.metadata.tmdb_api_key);
  const tmdbType = mediaType === "series" ? "tv" : "movie";
  const languages = [config.metadata.language, config.metadata.fallback_language]
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
  let candidates = [];

  for (const languageCode of languages) {
    const query = encodeURIComponent(parsed.title);
    const yearParam = parsed.year ? mediaType === "series" ? `&first_air_date_year=${parsed.year}` : `&year=${parsed.year}` : "";
    const url = `https://api.themoviedb.org/3/search/${tmdbType}?api_key=${apiKey}&language=${encodeURIComponent(languageCode)}&query=${query}${yearParam}`;
    const result = await fetchJson(url);
    candidates = Array.isArray(result.results) ? result.results : [];
    if (candidates.length) {
      break;
    }
  }

  if (!candidates.length) {
    return null;
  }

  const ranked = candidates
    .map((candidate) => ({ candidate, confidence: scoreTmdbCandidate(parsed, candidate) }))
    .sort((left, right) => right.confidence - left.confidence);

  const best = ranked[0];
  const detailsBundle = await fetchTmdbDetailsByTmdbId(mediaType, best.candidate.id, config);
  return {
    confidence: best.confidence,
    ...detailsBundle
  };
}

async function storeMetadataCache(cacheDirs, cacheKey, payload) {
  ensureDir(cacheDirs.metadata);
  const metadataPath = path.join(cacheDirs.metadata, `${cacheKey}.json`);
  await fsp.writeFile(metadataPath, JSON.stringify(payload, null, 2));
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
}

function toYearFromDetails(details, mediaType) {
  const rawDate = mediaType === "series" ? details.first_air_date : details.release_date;
  const year = Number(String(rawDate || "").slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

async function enrichFromTmdb({ mediaType, parsed, imdbId, tmdbId, config, cacheDirs, logger, forceRefresh = false }) {
  if (!config.metadata.enabled || config.metadata.provider !== "tmdb" || !config.metadata.tmdb_api_key) {
    return null;
  }

  let bundle = null;
  let confidence = 0;

  if (tmdbId) {
    bundle = await fetchTmdbDetailsByTmdbId(mediaType, tmdbId, config);
    confidence = 1;
  } else if (imdbId) {
    bundle = await fetchTmdbDetailsByImdbId(imdbId, mediaType, config);
    confidence = 1;
  } else {
    const searchResult = await searchTmdb(parsed, mediaType, config);
    if (searchResult) {
      bundle = searchResult;
      confidence = searchResult.confidence;
    }
  }

  if (!bundle) {
    return null;
  }

  const { details, externalIds } = bundle;
  const resolvedImdbId = imdbId || externalIds.imdb_id || null;
  const cacheKey = resolvedImdbId || `tmdb-${mediaType}-${details.id}`;
  const posterTarget = path.join(cacheDirs.posters, `${cacheKey}.jpg`);
  const backdropTarget = path.join(cacheDirs.backdrops, `${cacheKey}.jpg`);

  ensureDir(cacheDirs.posters);
  ensureDir(cacheDirs.backdrops);

  if (config.metadata.cache_posters) {
    try {
      await maybeCacheAsset(buildTmdbAssetUrl(details.poster_path), posterTarget, forceRefresh);
    } catch (error) {
      logger.warn(`Poster cache failed for ${cacheKey}: ${error.message}`);
    }
  }

  if (config.metadata.cache_backdrops) {
    try {
      await maybeCacheAsset(buildTmdbAssetUrl(details.backdrop_path), backdropTarget, forceRefresh);
    } catch (error) {
      logger.warn(`Backdrop cache failed for ${cacheKey}: ${error.message}`);
    }
  }

  await storeMetadataCache(cacheDirs, cacheKey, {
    fetched_at: Math.floor(Date.now() / 1000),
    media_type: mediaType,
    parsed,
    tmdb: details,
    external_ids: externalIds
  });

  return {
    imdb_id: resolvedImdbId || null,
    tmdb_id: details.id,
    title: details.title || details.name || parsed.title,
    original_title: details.original_title || details.original_name || details.title || details.name || parsed.title,
    year: toYearFromDetails(details, mediaType) || parsed.year,
    overview: details.overview || null,
    poster_path: details.poster_path ? createPublicAssetPath("posters", cacheKey) : null,
    backdrop_path: details.backdrop_path ? createPublicAssetPath("backdrops", cacheKey) : null,
    match_source: imdbId ? "imdb" : "tmdb",
    match_confidence: confidence,
    metadata_language: config.metadata.language,
    metadata_fetched_at: Math.floor(Date.now() / 1000),
    metadata_refresh_after: Math.floor(Date.now() / 1000) + (config.metadata.refresh_after_days * 86400)
  };
}

async function resolveItemMetadata({ filePath, mediaType, config, cacheDirs, existingItem, forceRefresh = false, logger }) {
  const parsed = parseMediaFromPath(filePath, mediaType);
  const nfoImdbId = config.metadata.prefer_nfo ? readNfoImdbId(filePath) : null;
  const inlineImdbId = extractImdbIdFromText(filePath);
  const isManualMatch = Boolean(existingItem && existingItem.manual_match);
  const directImdbId = isManualMatch
    ? existingItem.imdb_id || null
    : nfoImdbId || inlineImdbId || null;
  const directTmdbId = isManualMatch ? existingItem.tmdb_id || null : null;

  let tmdbMetadata = null;
  try {
    tmdbMetadata = await enrichFromTmdb({
      mediaType,
      parsed,
      imdbId: directImdbId,
      tmdbId: directTmdbId,
      config,
      cacheDirs,
      logger,
      forceRefresh
    });
  } catch (error) {
    logger.warn(`Metadata lookup failed for ${path.basename(filePath)}: ${error.message}`);
  }

  const imdbId = isManualMatch
    ? existingItem.imdb_id || (tmdbMetadata && tmdbMetadata.imdb_id) || null
    : directImdbId || (tmdbMetadata && tmdbMetadata.imdb_id) || null;
  const title = isManualMatch
    ? existingItem.title || (tmdbMetadata && tmdbMetadata.title) || parsed.title
    : (tmdbMetadata && tmdbMetadata.title) || parsed.title;
  const year = isManualMatch
    ? existingItem.year || (tmdbMetadata && tmdbMetadata.year) || parsed.year || null
    : (tmdbMetadata && tmdbMetadata.year) || parsed.year || null;
  const confidence = directImdbId ? 1 : (tmdbMetadata ? tmdbMetadata.match_confidence : 0);
  const needsReview = isManualMatch
    ? 0
    : confidence < Number(config.metadata.min_auto_match_confidence || 0.9)
      ? 1
      : 0;

  return {
    parsed,
    metadata: {
      imdb_id: imdbId,
      tmdb_id: isManualMatch
        ? existingItem.tmdb_id || (tmdbMetadata ? tmdbMetadata.tmdb_id : null)
        : tmdbMetadata ? tmdbMetadata.tmdb_id : null,
      title,
      original_title: isManualMatch
        ? existingItem.original_title || (tmdbMetadata && tmdbMetadata.original_title) || title
        : (tmdbMetadata && tmdbMetadata.original_title) || title,
      year,
      season: isManualMatch ? existingItem.season || parsed.season || null : parsed.season || null,
      episode: isManualMatch ? existingItem.episode || parsed.episode || null : parsed.episode || null,
      overview: isManualMatch
        ? existingItem.overview || (tmdbMetadata && tmdbMetadata.overview) || null
        : (tmdbMetadata && tmdbMetadata.overview) || null,
      poster_path: isManualMatch
        ? existingItem.poster_path || (tmdbMetadata ? tmdbMetadata.poster_path : null)
        : tmdbMetadata ? tmdbMetadata.poster_path : null,
      backdrop_path: isManualMatch
        ? existingItem.backdrop_path || (tmdbMetadata ? tmdbMetadata.backdrop_path : null)
        : tmdbMetadata ? tmdbMetadata.backdrop_path : null,
      match_source: isManualMatch ? "manual" : nfoImdbId ? "nfo" : inlineImdbId ? "filename_imdb" : tmdbMetadata ? tmdbMetadata.match_source : "local",
      match_confidence: confidence,
      needs_review: needsReview,
      manual_match: isManualMatch ? 1 : 0,
      metadata_language: tmdbMetadata ? tmdbMetadata.metadata_language : existingItem ? existingItem.metadata_language : null,
      metadata_fetched_at: tmdbMetadata ? tmdbMetadata.metadata_fetched_at : existingItem ? existingItem.metadata_fetched_at : null,
      metadata_refresh_after: tmdbMetadata ? tmdbMetadata.metadata_refresh_after : existingItem ? existingItem.metadata_refresh_after : null
    }
  };
}

module.exports = {
  extractImdbIdFromText,
  hashText,
  parseMediaFromPath,
  resolveItemMetadata
};
