const path = require("node:path");
const { extractImdbIdFromText, parseMediaFromPath } = require("./metadata");
const { hasKnownBadMatch, normalizeComparable, tokenizeComparable } = require("./match-rules");

const REASON_PRIORITY = {
  IMDB_CONFLICT: 100,
  MISSING_DB_META: 85,
  KNOWN_BAD_MATCH: 80,
  YEAR_CONFLICT: 60,
  TITLE_LOW_SIM: 30
};

function tokenize(value) {
  return tokenizeComparable(value);
}

function tokenSimilarity(left, right) {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function bigrams(value) {
  const normalized = normalizeComparable(value).replace(/\s+/g, "");
  if (normalized.length < 2) {
    return normalized ? [normalized] : [];
  }

  const output = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    output.push(normalized.slice(index, index + 2));
  }
  return output;
}

function diceSimilarity(left, right) {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (!leftBigrams.length || !rightBigrams.length) {
    return 0;
  }

  const rightCounts = new Map();
  for (const entry of rightBigrams) {
    rightCounts.set(entry, (rightCounts.get(entry) || 0) + 1);
  }

  let matches = 0;
  for (const entry of leftBigrams) {
    const count = rightCounts.get(entry) || 0;
    if (!count) {
      continue;
    }
    matches += 1;
    rightCounts.set(entry, count - 1);
  }

  return (2 * matches) / (leftBigrams.length + rightBigrams.length);
}

function bestTitleSimilarity(parsedTitle, candidates) {
  let best = 0;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    best = Math.max(best, tokenSimilarity(parsedTitle, candidate), diceSimilarity(parsedTitle, candidate));
  }
  return best;
}

function createFinding(item, reason, severity, details = {}) {
  return {
    reason,
    severity,
    file_id: item.file_id,
    item_id: item.item_id,
    path: item.path,
    media_type: item.media_type,
    title: item.title,
    original_title: item.original_title,
    year: item.year,
    imdb_id: item.imdb_id,
    tmdb_id: item.tmdb_id,
    match_source: item.match_source,
    match_confidence: item.match_confidence,
    details
  };
}

function sortFindings(left, right) {
  if (right.severity !== left.severity) {
    return right.severity - left.severity;
  }

  const leftPriority = REASON_PRIORITY[left.reason] || 0;
  const rightPriority = REASON_PRIORITY[right.reason] || 0;
  if (rightPriority !== leftPriority) {
    return rightPriority - leftPriority;
  }

  return String(left.path || "").localeCompare(String(right.path || ""));
}

function analyzeItem(item) {
  const findings = [];
  const parsed = parseMediaFromPath(item.path, item.media_type);
  const pathImdbId = extractImdbIdFromText(item.path);
  let alternativeTitles = [];
  try {
    alternativeTitles = JSON.parse(item.alternative_titles_json || "[]");
  } catch (_) {
    alternativeTitles = [];
  }

  const folderCandidate = path.basename(path.dirname(item.path || ""));
  const dbTitleCandidates = [
    item.title,
    item.original_title,
    folderCandidate,
    path.basename(item.path || "", path.extname(item.path || "")),
    ...alternativeTitles
  ].filter(Boolean);
  const similarity = bestTitleSimilarity(parsed.title, dbTitleCandidates);
  const strongExplicitId = Boolean(pathImdbId && item.imdb_id && pathImdbId === String(item.imdb_id).toLowerCase());
  const knownBad = hasKnownBadMatch(parsed.title, dbTitleCandidates);

  if (pathImdbId && item.imdb_id && pathImdbId !== String(item.imdb_id).toLowerCase()) {
    findings.push(createFinding(item, "IMDB_CONFLICT", 100, {
      path_imdb_id: pathImdbId,
      db_imdb_id: item.imdb_id
    }));
  }

  if (!item.imdb_id && tokenize(parsed.title).length >= 1) {
    findings.push(createFinding(item, "MISSING_DB_META", pathImdbId ? 95 : 85, {
      parsed_title: parsed.title,
      path_imdb_id: pathImdbId || null
    }));
  }

  if (knownBad) {
    findings.push(createFinding(item, "KNOWN_BAD_MATCH", 90, {
      rule: knownBad
    }));
  }

  if (parsed.year && item.year && Math.abs(Number(parsed.year) - Number(item.year)) > 1) {
    findings.push(createFinding(item, "YEAR_CONFLICT", 65, {
      parsed_year: parsed.year,
      db_year: item.year
    }));
  }

  const fuzzyLikeMatch = ["tmdb", "local", "", null].includes(item.match_source || null);
  if (
    fuzzyLikeMatch &&
    !strongExplicitId &&
    !knownBad &&
    parsed.title &&
    dbTitleCandidates.length &&
    similarity < 0.35
  ) {
    findings.push(createFinding(item, "TITLE_LOW_SIM", 35, {
      parsed_title: parsed.title,
      db_titles: dbTitleCandidates,
      alternative_titles: alternativeTitles,
      similarity: Number(similarity.toFixed(3))
    }));
  }

  return findings;
}

function summarizeFindings(findings) {
  const byReason = {};
  for (const finding of findings) {
    byReason[finding.reason] = (byReason[finding.reason] || 0) + 1;
  }

  return {
    total: findings.length,
    by_reason: byReason,
    critical_total: findings.filter((finding) => finding.severity >= 90).length,
    high_total: findings.filter((finding) => finding.severity >= 70).length
  };
}

function runAudit(items, options = {}) {
  const reasonFilter = options.reason ? String(options.reason).trim() : "";
  const severityFilter = Number(options.min_severity || 0);
  const findings = [];
  for (const item of items || []) {
    findings.push(...analyzeItem(item));
  }

  findings.sort(sortFindings);
  const filtered = findings.filter((finding) => {
    if (reasonFilter && finding.reason !== reasonFilter) {
      return false;
    }
    if (severityFilter && Number(finding.severity || 0) < severityFilter) {
      return false;
    }
    return true;
  });
  const limit = Math.max(1, Number(options.limit) || filtered.length || 1);
  const limited = filtered.slice(0, limit);

  return {
    generated_at: new Date().toISOString(),
    summary: summarizeFindings(findings),
    filtered_summary: summarizeFindings(filtered),
    findings: limited
  };
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function flattenFinding(finding) {
  return {
    severity: finding.severity,
    reason: finding.reason,
    media_type: finding.media_type,
    imdb_id: finding.imdb_id || "",
    tmdb_id: finding.tmdb_id || "",
    title: finding.title || "",
    original_title: finding.original_title || "",
    year: finding.year || "",
    match_source: finding.match_source || "",
    match_confidence: finding.match_confidence ?? "",
    file_id: finding.file_id,
    item_id: finding.item_id,
    path: finding.path,
    details: JSON.stringify(finding.details || {})
  };
}

function findingsToDelimited(findings, delimiter = "\t") {
  const rows = findings.map(flattenFinding);
  const headers = [
    "severity",
    "reason",
    "media_type",
    "imdb_id",
    "tmdb_id",
    "title",
    "original_title",
    "year",
    "match_source",
    "match_confidence",
    "file_id",
    "item_id",
    "path",
    "details"
  ];

  const lines = [
    headers.join(delimiter),
    ...rows.map((row) => headers.map((header) => {
      const value = row[header];
      return delimiter === "," ? escapeCsv(value) : String(value ?? "");
    }).join(delimiter))
  ];

  return `${lines.join("\n")}\n`;
}

function findingsToTopText(findings, limit = 100) {
  const sliced = findings.slice(0, Math.max(1, Number(limit) || 100));
  const lines = sliced.map((finding, index) => {
    const fileName = path.basename(finding.path || "");
    return `${index + 1}. [${finding.reason}] ${finding.title || fileName} :: ${fileName} :: ${finding.path}`;
  });

  return `${lines.join("\n")}\n`;
}

module.exports = {
  findingsToDelimited,
  findingsToTopText,
  runAudit
};
