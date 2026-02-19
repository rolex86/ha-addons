import { normalizeTitle } from "./text.js";

// Basic scoring: title match + year + SxxExx
export function scoreCandidate(
  { wantedTitle, wantedYear, wantedSxxExx },
  candidate,
) {
  const candTitle = candidate.title || "";
  const candNorm = normalizeTitle(candTitle);
  const wantNorm = normalizeTitle(wantedTitle);

  let score = 0;

  // title overlap
  if (candNorm === wantNorm) score += 60;
  else if (candNorm.includes(wantNorm) || wantNorm.includes(candNorm))
    score += 35;
  else {
    const wantTokens = new Set(wantNorm.split(" ").filter(Boolean));
    const candTokens = new Set(candNorm.split(" ").filter(Boolean));
    let common = 0;
    for (const t of wantTokens) if (candTokens.has(t)) common++;
    score += Math.min(25, common * 5);
  }

  // year
  if (wantedYear && candidate.year) {
    if (String(candidate.year) === String(wantedYear)) score += 20;
    else score -= 5;
  }

  // episode marker
  if (wantedSxxExx) {
    const upper = candTitle.toUpperCase();
    if (upper.includes(wantedSxxExx.toUpperCase())) score += 35;
    else score -= 10;
  }

  // penalize low-quality hints
  const bad = ["cam", "ts", "telesync", "hdrip", "dvdscr"];
  const up = candTitle.toLowerCase();
  if (bad.some((x) => up.includes(x))) score -= 15;

  return score;
}
