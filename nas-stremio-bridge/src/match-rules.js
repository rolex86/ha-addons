const STOP_WORDS = new Set([
  "the", "a", "an", "and", "of", "part", "movie", "film", "serial", "series",
  "season", "episode", "cz", "eng", "en", "dub", "dabing", "sub", "subs"
]);

const KNOWN_BAD_MATCHES = [
  ["hot rod", "hot bods and hot rods"],
  ["wall e", "wall e s treasures trinkets"],
  ["breaking bad", "breaking bad original minisodes"],
  ["tokyo ghoul", "tokyo ghoul 2026"],
  ["bears", "boonie bears"],
  ["warrior", "dragon warrior"],
  ["warrior", "13th warrior"],
  ["experiment", "stonehearst asylum"]
];

function stripDiacritics(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeComparable(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeComparable(value) {
  return normalizeComparable(value)
    .split(" ")
    .filter((token) => token && token.length > 1 && !STOP_WORDS.has(token));
}

function hasKnownBadMatch(expectedTitle, candidateTitles = []) {
  const normalizedExpected = normalizeComparable(expectedTitle);
  for (const candidateTitle of candidateTitles) {
    const normalizedCandidate = normalizeComparable(candidateTitle);
    for (const [expected, forbidden] of KNOWN_BAD_MATCHES) {
      if (normalizedExpected.includes(expected) && normalizedCandidate.includes(forbidden)) {
        return `${expected} -> ${forbidden}`;
      }
    }
  }
  return null;
}

module.exports = {
  KNOWN_BAD_MATCHES,
  hasKnownBadMatch,
  normalizeComparable,
  tokenizeComparable
};
