import {
  MAX_SUBTITLE_CUES,
  MAX_SUBTITLE_TEXT_LENGTH,
  validateSubtitleWords,
  type SubtitleCue,
  type SubtitleWord,
} from "./model";

export const MAX_SUBTITLE_IMPORT_BYTES = 2 * 1024 * 1024;
export const SUBTITLE_IMPORT_ACCEPT = ".srt,.vtt,.lrc,.json";
type ImportedCue = Omit<SubtitleCue, "id">;
export type SubtitleImportResult = { cues: ImportedCue[]; notices: string[] };

function fail(message: string): never {
  throw new Error(message);
}

function clock(value: string, short = false): number {
  const pattern = short
    ? /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})$/
    : /^(\d+):(\d{2}):(\d{2})[.,](\d{3})$/;
  const match = value.match(pattern);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60)
    return fail(`Invalid subtitle timestamp: ${value.slice(0, 40)}.`);
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4].padEnd(3, "0")) / 1000
  );
}

function plainTextWithWhitespace(value: string) {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    lrm: "\u200e",
    rlm: "\u200f",
  };
  return value
    .replace(
      /<\/?(?:b|i|u|font|c|v|lang|ruby|rt)(?:[.\s][^>]*)?>|<\d{2}:\d{2}(?::\d{2})?\.\d{3}>/gi,
      "",
    )
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi, (whole, entity: string) => {
      if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? whole;
      const code =
        entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    });
}

function plainText(value: string) {
  return plainTextWithWhitespace(value).trim();
}

function textRange(text: string, offset: number) {
  const trimmedStart = text.length - text.trimStart().length;
  const trimmedEnd = text.trimEnd().length;
  return trimmedEnd > trimmedStart
    ? { textStart: offset + trimmedStart, textEnd: offset + trimmedEnd }
    : null;
}

function joinTimedText(
  fragments: Array<{ raw: string; start: number; end: number }>,
  bounds: { start: number; end: number },
): { text: string; words?: SubtitleWord[] } {
  const cleanFragments = fragments.map((fragment) => ({
    ...fragment,
    text: plainTextWithWhitespace(fragment.raw),
  }));
  const untrimmed = cleanFragments.map((fragment) => fragment.text).join("");
  const leading = untrimmed.length - untrimmed.trimStart().length;
  const text = untrimmed.trim();
  if (!text) return { text };

  let offset = 0;
  const words: SubtitleWord[] = [];
  for (const fragment of cleanFragments) {
    const range = textRange(fragment.text, offset - leading);
    if (range && fragment.end > fragment.start) {
      words.push({ ...range, start: fragment.start, end: fragment.end });
    }
    offset += fragment.text.length;
  }
  return validateSubtitleWords(text, words, bounds) ? { text, words } : { text };
}

function vttText(value: string, start: number, end: number) {
  const marker = /<((?:\d+:)?\d{2}:\d{2}\.\d{3})>/g;
  const matches = [...value.matchAll(marker)];
  if (!matches.length) return { text: plainText(value) };
  const fragments: Array<{ raw: string; start: number; end: number }> = [];
  let cursor = 0;
  let fragmentStart = start;
  for (const match of matches) {
    const markerStart = clock(match[1], true);
    if (markerStart < fragmentStart || markerStart > end)
      fail("WebVTT inline timestamps must increase inside their cue.");
    fragments.push({
      raw: value.slice(cursor, match.index),
      start: fragmentStart,
      end: markerStart,
    });
    cursor = match.index + match[0].length;
    fragmentStart = markerStart;
  }
  fragments.push({ raw: value.slice(cursor), start: fragmentStart, end });
  return joinTimedText(fragments, { start, end });
}

function lrcTime(value: string, offset: number) {
  const match = value.match(/^(\d+):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (!match || Number(match[2]) >= 60) fail("An enhanced LRC timestamp is invalid.");
  return (
    Number(match[1]) * 60 +
    Number(match[2]) +
    Number((match[3] ?? "0").padEnd(3, "0")) / 1000 -
    offset
  );
}

function enhancedLrcText(value: string, start: number, end: number, offset: number) {
  const marker = /<(\d+:\d{2}(?:[.:]\d{1,3})?)>/g;
  const matches = [...value.matchAll(marker)];
  if (!matches.length) return { text: plainText(value) };
  const fragments: Array<{ raw: string; start: number; end: number }> = [];
  let cursor = 0;
  let fragmentStart = start;
  for (const match of matches) {
    const markerStart = lrcTime(match[1], offset);
    if (markerStart < fragmentStart || markerStart > end)
      fail("Enhanced LRC timestamps must increase inside their lyric line.");
    fragments.push({
      raw: value.slice(cursor, match.index),
      start: fragmentStart,
      end: markerStart,
    });
    cursor = match.index + match[0].length;
    fragmentStart = markerStart;
  }
  fragments.push({ raw: value.slice(cursor), start: fragmentStart, end });
  return joinTimedText(fragments, { start, end });
}

function timedText(text: string, vtt: boolean): ImportedCue[] {
  const blocks = text.trim().split(/\n[ \t]*\n/);
  if (vtt && !/^WEBVTT(?:[ \t].*)?$/.test(blocks[0]?.split("\n")[0] ?? ""))
    fail("The WebVTT file needs a WEBVTT header.");
  const cues: ImportedCue[] = [];
  for (const block of vtt ? blocks.slice(1) : blocks) {
    const lines = block.split("\n");
    if (vtt && /^(?:NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0])) continue;
    const timingIndex = lines[0].includes("-->") ? 0 : 1;
    const timing = lines[timingIndex]?.match(/^(\S+)\s+-->\s+(\S+)(?:[ \t]+.*)?$/);
    if (!timing) fail("A subtitle block has no valid timestamp range.");
    const start = clock(timing[1], vtt);
    const end = clock(timing[2], vtt);
    if (lines.slice(timingIndex + 1).some((line) => /^\d[\d:.,]*\s+-->/.test(line)))
      fail("Subtitle blocks must be separated by a blank line.");
    const rawText = lines.slice(timingIndex + 1).join("\n");
    cues.push({
      start,
      end,
      ...(vtt ? vttText(rawText, start, end) : { text: plainText(rawText) }),
    });
  }
  return cues;
}

function lrc(text: string, duration: number): ImportedCue[] {
  const offsets = [...text.matchAll(/^\s*\[offset:([^\]]*)\]\s*$/gim)];
  if (offsets.length > 1) fail("The LRC file contains conflicting offset tags.");
  const offsetText = (offsets[0]?.[1] ?? "0").trim();
  if (!/^[+-]?\d+$/.test(offsetText) || !Number.isSafeInteger(Number(offsetText)))
    fail("The LRC offset must be an integer number of milliseconds.");
  const offset = Number(offsetText) / 1000;
  const rows: Array<{ start: number; rawText: string }> = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || /^\s*\[[a-z][\w-]*:[^\]]*\]\s*$/i.test(line)) continue;
    const match = line.trim().match(/^((?:\[\d+:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/);
    if (!match) fail("LRC lyrics need a [mm:ss.xx] timestamp on each line.");
    for (const tag of match[1].matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)) {
      if (Number(tag[2]) >= 60) fail("An LRC timestamp has invalid seconds.");
      rows.push({
        start:
          Number(tag[1]) * 60 +
          Number(tag[2]) +
          Number((tag[3] ?? "0").padEnd(3, "0")) / 1000 -
          offset,
        rawText: match[2],
      });
      if (rows.length > MAX_SUBTITLE_CUES * 2)
        fail("The LRC file contains too many timestamped lines.");
    }
  }
  rows.sort((a, b) => a.start - b.start);
  return rows.flatMap((row) => {
    const end = rows.find((next) => next.start > row.start)?.start ?? duration;
    const lyric = enhancedLrcText(row.rawText, row.start, end, offset);
    return lyric.text ? [{ start: row.start, end, ...lyric }] : [];
  });
}

function jsonCues(text: string): ImportedCue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("The subtitle JSON is not valid JSON.");
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "cues" in parsed
      ? parsed.cues
      : null;
  if (!Array.isArray(items)) fail("JSON must contain a cue array, or an object with a cues array.");
  return items.map((item: unknown) => {
    if (!item || typeof item !== "object") return fail("Each JSON cue must be an object.");
    const cue = item as Record<string, unknown>;
    const milliseconds = "startMs" in cue || "endMs" in cue;
    if (milliseconds && ("start" in cue || "end" in cue))
      fail("JSON cues must use either seconds or milliseconds, not both.");
    const start = cue[milliseconds ? "startMs" : "start"];
    const end = cue[milliseconds ? "endMs" : "end"];
    if (typeof start !== "number" || typeof end !== "number" || typeof cue.text !== "string")
      fail("JSON cues need numeric start/end times and text.");
    const scale = milliseconds ? 1000 : 1;
    const cueStart = start / scale;
    const cueEnd = end / scale;
    const text = typeof cue.words === "undefined" ? cue.text.trim() : cue.text;
    let words: SubtitleWord[] | undefined;
    if (typeof cue.words !== "undefined") {
      if (!Array.isArray(cue.words)) fail("JSON cue words must be an array.");
      words = cue.words.map((rawWord: unknown) => {
        if (!rawWord || typeof rawWord !== "object") fail("Each JSON word must be an object.");
        const word = rawWord as Record<string, unknown>;
        const wordMilliseconds = "startMs" in word || "endMs" in word;
        if (wordMilliseconds && ("start" in word || "end" in word))
          fail("JSON words must use either seconds or milliseconds, not both.");
        const wordStart = word[wordMilliseconds ? "startMs" : "start"];
        const wordEnd = word[wordMilliseconds ? "endMs" : "end"];
        if (
          typeof word.textStart !== "number" ||
          typeof word.textEnd !== "number" ||
          typeof wordStart !== "number" ||
          typeof wordEnd !== "number"
        )
          fail("JSON words need textStart/textEnd and numeric start/end times.");
        return {
          textStart: word.textStart,
          textEnd: word.textEnd,
          start: wordStart / (wordMilliseconds ? 1000 : 1),
          end: wordEnd / (wordMilliseconds ? 1000 : 1),
        };
      });
      if (!validateSubtitleWords(text, words, { start: cueStart, end: cueEnd }))
        fail("JSON cue words do not match their text or timing range.");
    }
    return { start: cueStart, end: cueEnd, text, ...(words ? { words } : {}) };
  });
}

/** Parse local text only. Keep overlaps and line breaks; never use AI cue normalization. */
export function parseSubtitleImport(
  text: string,
  filename: string,
  duration: number,
): SubtitleImportResult {
  if (!Number.isFinite(duration) || duration <= 0) fail("Load a track before importing subtitles.");
  if (new TextEncoder().encode(text).byteLength > MAX_SUBTITLE_IMPORT_BYTES)
    fail("Subtitle files must be 2 MB or smaller.");
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!source.trim()) fail("The subtitle file is empty.");
  const extension = filename.split(".").at(-1)?.toLowerCase();
  const input =
    extension === "srt"
      ? timedText(source, false)
      : extension === "vtt"
        ? timedText(source, true)
        : extension === "lrc"
          ? lrc(source, duration)
          : extension === "json"
            ? jsonCues(source)
            : fail("Choose an SRT, VTT, LRC, or subtitle JSON file.");
  if (input.length > MAX_SUBTITLE_CUES)
    fail(`The file exceeds the ${MAX_SUBTITLE_CUES}-block limit.`);
  let clipped = 0,
    skipped = 0;
  const cues: ImportedCue[] = [];
  for (const cue of input) {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end))
      fail("A subtitle block has invalid or reversed timestamps.");
    if (cue.text.length > MAX_SUBTITLE_TEXT_LENGTH)
      fail(`A subtitle block exceeds the ${MAX_SUBTITLE_TEXT_LENGTH}-character limit.`);
    if (!cue.text || cue.end <= 0 || cue.start >= duration) {
      skipped++;
      continue;
    }
    if (cue.end <= cue.start) fail("A subtitle block has invalid or reversed timestamps.");
    const start = Math.max(0, cue.start),
      end = Math.min(duration, cue.end);
    if (start !== cue.start || end !== cue.end) clipped++;
    const words = cue.words?.flatMap((word) => {
      const clippedStart = Math.max(start, word.start);
      const clippedEnd = Math.min(end, word.end);
      return clippedEnd > clippedStart ? [{ ...word, start: clippedStart, end: clippedEnd }] : [];
    });
    const imported: ImportedCue = { ...cue, start, end };
    if (words?.length) imported.words = words;
    else delete imported.words;
    cues.push(imported);
  }
  if (!cues.length) fail("No nonempty subtitle blocks fall within the active track.");
  cues.sort((a, b) => a.start - b.start);
  return {
    cues,
    notices: [
      ...(extension === "lrc"
        ? ["LRC block endings follow the next timestamp; the last line ends at the track boundary."]
        : []),
      ...(clipped ? [`${clipped} block(s) clipped to the track duration.`] : []),
      ...(skipped ? [`${skipped} empty or out-of-track block(s) skipped.`] : []),
    ],
  };
}
