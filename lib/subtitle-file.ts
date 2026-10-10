import { MAX_SUBTITLE_CUES, MAX_SUBTITLE_TEXT_LENGTH, type SubtitleCue } from "./subtitles";

export type SubtitleFormat = "srt" | "vtt";
export type SubtitleImport = { format: SubtitleFormat; cues: SubtitleCue[]; warnings: string[] };
export type SubtitleImportIdentity = {
  sourceFile: object | null;
  trackDuration: number;
  generation: number;
};
export const MAX_SUBTITLE_FILE_BYTES = 2 * 1024 * 1024;

/** Discard completed file reads whose track or generation has changed. */
export function isCurrentSubtitleImport(
  current: SubtitleImportIdentity,
  expected: SubtitleImportIdentity,
) {
  return (
    current.sourceFile === expected.sourceFile &&
    current.trackDuration === expected.trackDuration &&
    current.generation === expected.generation
  );
}

function fail(message: string): never {
  throw new Error(message);
}

function asText(input: string | Uint8Array | ArrayBuffer) {
  let text: string;
  if (typeof input === "string") text = input;
  else {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.byteLength > MAX_SUBTITLE_FILE_BYTES) fail("Subtitle files must be 2 MB or smaller.");
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("This subtitle file is not valid UTF-8 text.");
    }
  }
  if (new TextEncoder().encode(text).byteLength > MAX_SUBTITLE_FILE_BYTES)
    fail("Subtitle files must be 2 MB or smaller.");
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function parseTimestamp(value: string, format: SubtitleFormat) {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match || (format === "vtt" && value.includes(","))) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (minutes > 59 || seconds > 59) return null;
  const time = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  return Number.isFinite(time) ? time : null;
}

function parseBlocks(text: string, format: SubtitleFormat): SubtitleImport {
  const warnings = new Set<string>();
  const lines = text.split("\n");
  let cursor = 0;
  if (format === "vtt") {
    if (!/^WEBVTT(?:\s|$)/.test(lines[0]?.trim() ?? ""))
      fail("WebVTT files must begin with a WEBVTT header.");
    cursor = 1;
    while (cursor < lines.length && lines[cursor].trim() !== "") cursor += 1;
    while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
  }

  const cues: SubtitleCue[] = [];
  const blocks: string[][] = [];
  let block: string[] = [];
  for (; cursor <= lines.length; cursor += 1) {
    const line = lines[cursor] ?? "";
    if (line.trim() === "") {
      if (block.length) blocks.push(block);
      block = [];
    } else block.push(line);
  }

  for (const current of blocks) {
    const first = current[0]?.trim() ?? "";
    if (format === "vtt" && /^NOTE(?:\s|$)/.test(first)) continue;
    if (format === "vtt" && /^(STYLE|REGION)(?:\s|$)/.test(first)) {
      warnings.add(
        "WebVTT STYLE and REGION blocks are ignored; this editor supports plain cue text.",
      );
      continue;
    }

    const arrowIndex = current.findIndex((line) => line.includes("-->"));
    if (arrowIndex < 0)
      fail(`Could not find a timestamp line in subtitle block ${cues.length + 1}.`);
    const identifier = arrowIndex > 0 ? current[arrowIndex - 1].trim() : "";
    if (arrowIndex > 1)
      fail(`Subtitle block ${cues.length + 1} has unexpected lines before its timestamp.`);
    const timing = /^\s*(\S+)\s+-->\s+(\S+)(.*)$/.exec(current[arrowIndex]);
    if (!timing) fail(`Subtitle block ${cues.length + 1} has an invalid timestamp line.`);
    const start = parseTimestamp(timing[1], format);
    const end = parseTimestamp(timing[2], format);
    if (start === null || end === null || end <= start)
      fail(`Subtitle block ${cues.length + 1} has an invalid time range.`);
    const settings = timing[3].trim();
    if (format === "vtt" && settings) {
      warnings.add(
        "WebVTT cue position, alignment, size, vertical, and region settings are not applied.",
      );
    }
    const textLines = current.slice(arrowIndex + 1);
    const cueText = textLines.join("\n");
    if (cueText.length > MAX_SUBTITLE_TEXT_LENGTH)
      fail(`Subtitle block ${cues.length + 1} exceeds the 600-character limit.`);
    if (format === "vtt" && /<[^>]*>/.test(cueText)) {
      warnings.add("WebVTT styling markup is kept as literal text; styling is not applied.");
    }
    cues.push({
      id: identifier && identifier.length <= 80 ? identifier : `import-${cues.length + 1}`,
      start,
      end,
      text: cueText,
    });
    if (cues.length > MAX_SUBTITLE_CUES) fail("Subtitle files can contain at most 500 cues.");
  }

  if (!cues.length) fail("No subtitle cues were found in this file.");

  const sorted = cues
    .map((cue, order) => ({ cue, order }))
    .sort((a, b) => a.cue.start - b.cue.start || a.order - b.order)
    .map(({ cue }) => cue);
  return { format, cues: sorted, warnings: [...warnings] };
}

export function parseSrt(input: string | Uint8Array | ArrayBuffer): SubtitleImport {
  return parseBlocks(asText(input), "srt");
}

export function parseVtt(input: string | Uint8Array | ArrayBuffer): SubtitleImport {
  return parseBlocks(asText(input), "vtt");
}

/**
 * Supported subset: UTF-8 SRT and plain-text WebVTT, optional cue identifiers,
 * multiline cue text, and the format's comma/dot millisecond separator. NOTE
 * blocks are ignored. Styling markup stays literal, and VTT cue positioning or
 * STYLE/REGION blocks produce warnings instead of being interpreted.
 */
export function parseSubtitleFile(
  input: string | Uint8Array | ArrayBuffer,
  format?: SubtitleFormat,
): SubtitleImport {
  const text = asText(input);
  const detected = format ?? (/^WEBVTT(?:\s|$)/.test(text.trimStart()) ? "vtt" : "srt");
  return parseBlocks(text, detected);
}

function validateCue(cue: SubtitleCue, duration: number) {
  if (
    !Number.isFinite(cue.start) ||
    !Number.isFinite(cue.end) ||
    cue.start < 0 ||
    cue.end <= cue.start ||
    cue.end > duration ||
    typeof cue.text !== "string" ||
    cue.text.length > MAX_SUBTITLE_TEXT_LENGTH
  ) {
    fail("Subtitle cues must have valid times within the track and text up to 600 characters.");
  }
}

function uniqueLocalId(used: Set<string>) {
  let candidate = "";
  do {
    candidate =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `cue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  } while (used.has(candidate));
  used.add(candidate);
  return candidate;
}

export function applySubtitleImport(
  existing: SubtitleCue[],
  incoming: SubtitleCue[],
  mode: "replace" | "append",
  duration: number,
) {
  if (!Number.isFinite(duration) || duration <= 0) fail("Load a track before importing subtitles.");
  if (incoming.length > MAX_SUBTITLE_CUES) fail("Subtitle files can contain at most 500 cues.");
  const result = mode === "append" ? existing.map((cue) => ({ ...cue })) : [];
  const used = new Set(result.map((cue) => cue.id));
  for (const cue of incoming) {
    validateCue(cue, duration);
    result.push({ id: uniqueLocalId(used), start: cue.start, end: cue.end, text: cue.text });
    if (result.length > MAX_SUBTITLE_CUES) fail("A track can contain at most 500 subtitles.");
  }
  return result
    .map((cue, order) => ({ cue, order }))
    .sort((a, b) => a.cue.start - b.cue.start || a.order - b.order)
    .map(({ cue }) => cue);
}

/** Explicitly trim cues to the source track. Fully out-of-range cues are removed. */
export function trimSubtitleCues(cues: SubtitleCue[], duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) fail("Track duration must be positive.");
  const trimmed: SubtitleCue[] = [];
  let removed = 0;
  for (const cue of cues) {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) {
      fail("Subtitle cues must have finite times and end after they start.");
    }
    const start = Math.max(0, cue.start);
    const end = Math.min(duration, cue.end);
    if (end <= start) {
      removed += 1;
      continue;
    }
    trimmed.push({ ...cue, start, end });
  }
  return { cues: trimmed, removed };
}

export function offsetSubtitleCues(cues: SubtitleCue[], offset: number, duration: number) {
  if (!Number.isFinite(offset)) fail("Enter a finite timing offset.");
  const shifted = cues.map((cue) => ({ ...cue, start: cue.start + offset, end: cue.end + offset }));
  for (const cue of shifted) validateCue(cue, duration);
  return shifted
    .map((cue, order) => ({ cue, order }))
    .sort((a, b) => a.cue.start - b.cue.start || a.order - b.order)
    .map(({ cue }) => cue);
}

function stamp(seconds: number, format: SubtitleFormat) {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((millis % 60_000) / 1000);
  const fraction = millis % 1000;
  const separator = format === "srt" ? "," : ".";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}${separator}${String(fraction).padStart(3, "0")}`;
}

/** Export full source-time cues or clip/rebase them into a selected range. */
export function exportSubtitles(
  cues: SubtitleCue[],
  format: SubtitleFormat,
  range?: [number, number],
) {
  if (range && (!Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[1] <= range[0]))
    fail("Subtitle export range must have a positive duration.");
  const selected = cues.flatMap((cue) => {
    const start = range ? Math.max(cue.start, range[0]) : cue.start;
    const end = range ? Math.min(cue.end, range[1]) : cue.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const offset = range?.[0] ?? 0;
    const localStart = Math.max(0, start - offset);
    const localEnd = Math.max(localStart + 0.001, end - offset);
    return [{ cue, start: localStart, end: localEnd }];
  });
  const blocks = selected.map(({ cue, start, end }, index) =>
    format === "vtt"
      ? `${String(cue.id || `cue-${index + 1}`).replace(/[\r\n]/g, " ")}\n${stamp(start, format)} --> ${stamp(end, format)}\n${cue.text}`
      : `${index + 1}\n${stamp(start, format)} --> ${stamp(end, format)}\n${cue.text}`,
  );
  return format === "vtt"
    ? `WEBVTT\n\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`
    : `${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
}
