const TIMESTAMP = /^(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})(?:\s+.*)?$/;

export function normalizeSubtitle(sourceText, sourceFormat) {
  const normalized = String(sourceText)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) throw new Error("EMPTY_SUBTITLE");
  const cues = sourceFormat === "srt" ? parseSrt(normalized) : parseVtt(normalized);
  if (!cues.length) throw new Error("NO_CUES");
  return cues.map((cue, index) => ({ ...cue, id: `cue-${String(index + 1).padStart(6, "0")}` }));
}

function parseSrt(text) {
  const lines = text.split("\n");
  const cues = [];
  for (let index = 0; index < lines.length;) {
    while (index < lines.length && !lines[index].trim()) index++;
    if (index >= lines.length) break;
    if (/^\d+$/.test(lines[index].trim())) index++;
    if (index >= lines.length || !TIMESTAMP.test(lines[index].trim())) throw new Error("INVALID_SRT");
    const timing = normalizeTiming(lines[index++].trim());
    const body = [];
    while (index < lines.length && lines[index].trim()) body.push(lines[index++]);
    if (!body.length) throw new Error("EMPTY_CUE");
    cues.push({ timing, text: body.join("\n") });
  }
  return cues;
}

function parseVtt(text) {
  const lines = text.split("\n");
  if (!/^WEBVTT(?:\s|$)/.test(lines[0].trim())) throw new Error("INVALID_VTT");
  const cues = [];
  for (let index = 1; index < lines.length;) {
    while (index < lines.length && !lines[index].trim()) index++;
    if (index >= lines.length) break;
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[index].trim())) {
      while (index < lines.length && lines[index].trim()) index++;
      continue;
    }
    if (!TIMESTAMP.test(lines[index].trim())) index++;
    if (index >= lines.length || !TIMESTAMP.test(lines[index].trim())) throw new Error("INVALID_VTT");
    const timing = normalizeTiming(lines[index++].trim());
    const body = [];
    while (index < lines.length && lines[index].trim()) body.push(lines[index++]);
    if (!body.length) throw new Error("EMPTY_CUE");
    cues.push({ timing, text: body.join("\n") });
  }
  return cues;
}

function normalizeTiming(value) {
  const match = TIMESTAMP.exec(value);
  if (!match) throw new Error("INVALID_TIMESTAMP");
  return `${time(match[1], match[2], match[3], match[4])} --> ${time(match[5], match[6], match[7], match[8])}`;
}

function time(hours, minutes, seconds, milliseconds) {
  return `${String(hours ?? "0").padStart(2, "0")}:${minutes}:${seconds},${milliseconds}`;
}

export function normalizedCacheSource(cues) {
  return cues.map(({ timing, text }) => `${timing}\n${text.trim()}`).join("\n\n");
}

export function renderSrt(cues, translations) {
  const translated = new Map(translations.map(item => [item.id, item.text]));
  if (translated.size !== cues.length) throw new Error("TRANSLATION_COUNT_MISMATCH");
  return cues.map((cue, index) => {
    const text = translated.get(cue.id);
    if (typeof text !== "string" || !text.trim()) throw new Error("MISSING_TRANSLATION");
    return `${index + 1}\n${cue.timing}\n${text.trim()}`;
  }).join("\n\n") + "\n";
}

export function createBatches(cues, maxCues = 300, maxCharacters = 30000) {
  const batches = [];
  let batch = [];
  let characters = 0;
  for (const cue of cues) {
    const size = cue.id.length + cue.text.length;
    if (batch.length && (batch.length >= maxCues || characters + size > maxCharacters)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push({ id: cue.id, text: cue.text });
    characters += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
