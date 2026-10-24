import {
  MAX_SUBTITLE_CUES,
  MAX_SUBTITLE_TEXT_LENGTH,
  validateSubtitleWords,
  type SubtitleCue,
  type SubtitleWord,
} from "../subtitles/model";
import type { GeneratedApplication, GeneratedCue, GeneratedWord } from "./types";

export type GeneratedCueInput = {
  startMs?: number | null;
  endMs?: number | null;
  text?: string | null;
  words?: GeneratedWord[] | null;
};

export type CueWindowOwnership = {
  /** Absolute source time where this window begins. Segment times are relative to it. */
  startMs: number;
  /** Absolute source time where this window ends. */
  endMs: number;
  /** Absolute start of the midpoint-owned region, inclusive. */
  ownsStartMs: number;
  /** Absolute end of the midpoint-owned region, exclusive. */
  ownsEndMs: number;
};

export type GeneratedSubtitleFormat = "srt" | "vtt" | "lrc" | "json";

function cleanCueText(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function generatedWordsAreValid(
  text: string,
  words: unknown,
  bounds?: { startMs: number; endMs: number },
): words is GeneratedWord[] {
  if (!Array.isArray(words)) return false;
  const subtitleWords: SubtitleWord[] = words.map((word) => ({
    textStart: word?.textStart,
    textEnd: word?.textEnd,
    start: word?.startMs,
    end: word?.endMs,
  }));
  return (
    validateSubtitleWords(
      text,
      subtitleWords,
      bounds ? { start: bounds.startMs, end: bounds.endMs } : undefined,
    ) !== undefined
  );
}

function normalizedTextAndWords(text: string, words: unknown) {
  const normalizedText = cleanCueText(text);
  if (!generatedWordsAreValid(text, words)) return { text: normalizedText };
  const mapOffset = (offset: number) =>
    text.slice(0, offset).replace(/\s+/gu, " ").trimStart().length;
  const normalizedWords = words.map((word) => ({
    ...word,
    textStart: mapOffset(word.textStart),
    textEnd: mapOffset(word.textEnd),
  }));
  return generatedWordsAreValid(normalizedText, normalizedWords)
    ? { text: normalizedText, words: normalizedWords }
    : { text: normalizedText };
}

function fitGeneratedWords(
  text: string,
  words: GeneratedWord[] | undefined,
  startMs: number,
  endMs: number,
) {
  if (!generatedWordsAreValid(text, words)) return undefined;
  const fitted = words.flatMap((word) => {
    const start = Math.max(startMs, word.startMs);
    const end = Math.min(endMs, word.endMs);
    return end > start ? [{ ...word, startMs: start, endMs: end }] : [];
  });
  return generatedWordsAreValid(text, fitted, { startMs, endMs }) ? fitted : undefined;
}

function cloneCue(cue: GeneratedCue): GeneratedCue {
  return { ...cue, ...(cue.words ? { words: cue.words.map((word) => ({ ...word })) } : {}) };
}

function mergeWordSpans(text: string, first?: GeneratedWord[], second?: GeneratedWord[]) {
  if (!generatedWordsAreValid(text, first))
    return generatedWordsAreValid(text, second) ? second.map((word) => ({ ...word })) : undefined;
  if (!generatedWordsAreValid(text, second)) return first.map((word) => ({ ...word }));
  const merged = first.map((word) => ({ ...word }));
  for (const candidate of second) {
    const overlappingText = merged.findIndex(
      (word) => candidate.textStart < word.textEnd && word.textStart < candidate.textEnd,
    );
    if (overlappingText >= 0) {
      const existing = merged[overlappingText];
      if (
        existing.textStart === candidate.textStart &&
        existing.textEnd === candidate.textEnd &&
        candidate.startMs < existing.endMs &&
        existing.startMs < candidate.endMs
      ) {
        existing.startMs = Math.min(existing.startMs, candidate.startMs);
        existing.endMs = Math.max(existing.endMs, candidate.endMs);
      }
      continue;
    }
    merged.push({ ...candidate });
  }
  merged.sort((left, right) => left.textStart - right.textStart || left.startMs - right.startMs);
  return generatedWordsAreValid(text, merged) ? merged : first.map((word) => ({ ...word }));
}

function estimateMissingEndMs(
  startMs: number,
  nextStartMs: number | undefined,
  windowEndMs: number,
) {
  const nextBoundaryMs =
    nextStartMs !== undefined && nextStartMs > startMs ? nextStartMs : windowEndMs;
  return Math.min(nextBoundaryMs, windowEndMs);
}

function findNextValidStart(
  input: readonly GeneratedCueInput[],
  afterOrder: number,
  startMs: number,
) {
  return input
    .slice(afterOrder + 1)
    .flatMap((next) => {
      if (
        typeof next?.startMs !== "number" ||
        !Number.isFinite(next.startMs) ||
        next.startMs <= startMs ||
        typeof next.text !== "string" ||
        !cleanCueText(next.text) ||
        (next.endMs !== undefined &&
          next.endMs !== null &&
          (typeof next.endMs !== "number" ||
            !Number.isFinite(next.endMs) ||
            next.endMs <= next.startMs))
      )
        return [];
      return [next.startMs];
    })
    .sort((a, b) => a - b)[0];
}

function mergeMatchingOverlaps(cues: GeneratedCue[]) {
  const result: GeneratedCue[] = [];
  for (const cue of cues) {
    const previous = result.at(-1);
    if (previous && previous.text === cue.text && cue.startMs < previous.endMs) {
      previous.startMs = Math.min(previous.startMs, cue.startMs);
      previous.endMs = Math.max(previous.endMs, cue.endMs);
      previous.words = mergeWordSpans(previous.text, previous.words, cue.words);
      if (!previous.words) delete previous.words;
      continue;
    }
    result.push(cloneCue(cue));
  }
  return result;
}

function resolveResidualOverlaps(cues: GeneratedCue[]) {
  const result: GeneratedCue[] = [];
  for (const input of cues) {
    const cue = { ...input };
    while (result.length && result[result.length - 1].endMs > cue.startMs) {
      const previous = result[result.length - 1];
      if (previous.text === cue.text) {
        previous.startMs = Math.min(previous.startMs, cue.startMs);
        previous.endMs = Math.max(previous.endMs, cue.endMs);
        previous.words = mergeWordSpans(previous.text, previous.words, cue.words);
        if (!previous.words) delete previous.words;
        cue.startMs = previous.startMs;
        cue.endMs = previous.endMs;
        result.pop();
        continue;
      }
      previous.endMs = cue.startMs;
      previous.words = fitGeneratedWords(
        previous.text,
        previous.words,
        previous.startMs,
        previous.endMs,
      );
      if (!previous.words) delete previous.words;
      if (previous.endMs <= previous.startMs) result.pop();
      else break;
    }
    if (cue.endMs > cue.startMs) result.push(cloneCue(cue));
  }
  return result;
}

/** Clean provider output while retaining repeats at distinct points in the song. */
export function normalizeGeneratedCues(
  input: readonly GeneratedCueInput[],
  durationMs: number,
): GeneratedCue[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Array.isArray(input)) return [];

  const candidates = input.flatMap((raw, order) => {
    if (!raw || typeof raw.text !== "string" || typeof raw.startMs !== "number") return [];
    if (!Number.isFinite(raw.startMs)) return [];
    const normalized = normalizedTextAndWords(raw.text, raw.words);
    const { text } = normalized;
    if (!text) return [];
    const unclampedStart = raw.startMs;
    const startMs = Math.max(0, Math.min(durationMs, unclampedStart));
    if (startMs >= durationMs) return [];

    let endMs: number;
    if (raw.endMs === undefined || raw.endMs === null) {
      const nextStartMs = findNextValidStart(input, order, unclampedStart);
      endMs = estimateMissingEndMs(startMs, nextStartMs, durationMs);
    } else {
      if (typeof raw.endMs !== "number" || !Number.isFinite(raw.endMs)) return [];
      endMs = raw.endMs;
    }
    endMs = Math.min(durationMs, endMs);
    if (endMs <= startMs) return [];
    const words = fitGeneratedWords(text, normalized.words, startMs, endMs);
    return [{ cue: { startMs, endMs, text, ...(words ? { words } : {}) }, order }];
  });

  const sorted = candidates
    .sort((a, b) => a.cue.startMs - b.cue.startMs || a.order - b.order)
    .map(({ cue }) => cue);
  return resolveResidualOverlaps(mergeMatchingOverlaps(sorted));
}

/** Convert one inference window's relative timestamps and assign overlap ownership. */
export function normalizeWindowCues(
  input: readonly GeneratedCueInput[],
  window: CueWindowOwnership,
  trackDurationMs: number,
): GeneratedCue[] {
  if (
    !Number.isFinite(window.startMs) ||
    !Number.isFinite(window.endMs) ||
    window.endMs <= window.startMs ||
    !Number.isFinite(window.ownsStartMs) ||
    !Number.isFinite(window.ownsEndMs) ||
    window.ownsEndMs <= window.ownsStartMs
  )
    return [];
  const localDurationMs = window.endMs - window.startMs;
  const owned = input.flatMap((raw, order) => {
    if (!raw || typeof raw.text !== "string" || typeof raw.startMs !== "number") return [];
    if (!Number.isFinite(raw.startMs)) return [];
    const normalized = normalizedTextAndWords(raw.text, raw.words);
    const { text } = normalized;
    if (!text) return [];
    const localStartMs = Math.max(0, Math.min(localDurationMs, raw.startMs));
    if (localStartMs >= localDurationMs) return [];
    let localEndMs: number;
    if (raw.endMs === undefined || raw.endMs === null) {
      const nextStartMs = findNextValidStart(input, order, raw.startMs);
      localEndMs = estimateMissingEndMs(
        localStartMs,
        typeof nextStartMs === "number" ? nextStartMs : undefined,
        localDurationMs,
      );
    } else {
      if (typeof raw.endMs !== "number" || !Number.isFinite(raw.endMs)) return [];
      localEndMs = raw.endMs;
    }
    localEndMs = Math.min(localDurationMs, localEndMs);
    if (localEndMs <= localStartMs) return [];
    const startMs = window.startMs + localStartMs;
    const endMs = Math.min(trackDurationMs, window.startMs + localEndMs);
    const midpointMs = (startMs + endMs) / 2;
    if (midpointMs < window.ownsStartMs || midpointMs >= window.ownsEndMs) return [];
    const words = fitGeneratedWords(
      text,
      normalized.words?.map((word) => ({
        ...word,
        startMs: window.startMs + word.startMs,
        endMs: window.startMs + word.endMs,
      })),
      startMs,
      endMs,
    );
    return [{ startMs, endMs, text, ...(words ? { words } : {}) }];
  });
  return normalizeGeneratedCues(owned, trackDurationMs);
}

export function canApplyGeneratedCues(
  input: readonly GeneratedCueInput[],
  durationMs: number,
): { canApply: boolean; error: string | null; estimatedCueBytes: number } {
  const cues = normalizeGeneratedCues(input, durationMs);
  const estimatedCueBytes = new TextEncoder().encode(
    JSON.stringify(
      cues.map((cue, index) => ({
        id: `generated-${index.toString().padStart(4, "0")}`,
        start: cue.startMs / 1000,
        end: cue.endMs / 1000,
        text: cue.text,
        ...(cue.words ? { words: cue.words } : {}),
      })),
    ),
  ).byteLength;
  if (!Number.isFinite(durationMs) || durationMs <= 0)
    return {
      canApply: false,
      error: "Load a track before applying generated subtitles.",
      estimatedCueBytes,
    };
  if (cues.length > MAX_SUBTITLE_CUES)
    return {
      canApply: false,
      error: "This result exceeds the 500-subtitle limit. Download the complete result instead.",
      estimatedCueBytes,
    };
  if (cues.some((cue) => cue.text.length > MAX_SUBTITLE_TEXT_LENGTH))
    return {
      canApply: false,
      error:
        "One or more subtitle lines exceed the 600-character limit. Download the complete result instead.",
      estimatedCueBytes,
    };
  if (
    cues.some(
      (cue) =>
        !Number.isFinite(cue.startMs) ||
        !Number.isFinite(cue.endMs) ||
        cue.startMs < 0 ||
        cue.endMs <= cue.startMs ||
        cue.endMs > durationMs,
    )
  )
    return {
      canApply: false,
      error:
        "Some subtitle times fall outside the active track. Download the complete result instead.",
      estimatedCueBytes,
    };
  return { canApply: true, error: null, estimatedCueBytes };
}

function makeSubtitleId(index: number) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `generated-${Date.now().toString(36)}-${index.toString(36)}`;
}

/** Convert generated milliseconds to canonical Pulseframe seconds exactly once. */
export function generatedCuesToSubtitles(
  input: readonly GeneratedCueInput[],
  durationMs: number,
  makeId: (index: number) => string = makeSubtitleId,
): GeneratedApplication {
  const generated = normalizeGeneratedCues(input, durationMs);
  const admission = canApplyGeneratedCues(generated, durationMs);
  if (!admission.canApply) return { cues: [], error: admission.error };

  const usedIds = new Set<string>();
  const cues: SubtitleCue[] = generated.map((cue, index) => {
    const provided = makeId(index).slice(0, 80);
    let id = provided || `generated-${index.toString(36)}`;
    let suffix = 1;
    while (usedIds.has(id)) {
      const nextSuffix = `-${suffix++}`;
      id = `${provided.slice(0, 80 - nextSuffix.length)}${nextSuffix}`;
    }
    usedIds.add(id);
    return {
      id,
      start: cue.startMs / 1000,
      end: cue.endMs / 1000,
      text: cue.text,
      ...(cue.words
        ? {
            words: cue.words.map((word) => ({
              textStart: word.textStart,
              textEnd: word.textEnd,
              start: word.startMs / 1000,
              end: word.endMs / 1000,
            })),
          }
        : {}),
    };
  });
  return { cues, error: null };
}

function escapeVttText(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lrcTimestamp(valueMs: number) {
  const centiseconds = Math.max(0, Math.round(valueMs / 10));
  const minutes = Math.floor(centiseconds / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}]`;
}

function textWithWordMarkers(
  text: string,
  words: GeneratedWord[] | undefined,
  marker: (timeMs: number) => string,
  escape: (value: string) => string = (value) => value,
  cueEndMs?: number,
) {
  if (!words?.length) return escape(text);
  if (words.some((word, index) => index > 0 && word.startMs < words[index - 1].endMs))
    return escape(text);
  let output = "";
  let offset = 0;
  let lastMarker: number | undefined;
  const addMarker = (timeMs: number) => {
    if (timeMs !== lastMarker) output += marker(timeMs);
    lastMarker = timeMs;
  };
  for (const [index, word] of words.entries()) {
    output += escape(text.slice(offset, word.textStart));
    addMarker(word.startMs);
    output += escape(text.slice(word.textStart, word.textEnd));
    const next = words[index + 1];
    if (next ? word.endMs !== next.startMs : word.endMs !== cueEndMs) addMarker(word.endMs);
    offset = word.textEnd;
  }
  return output + escape(text.slice(offset));
}

/** Serialize the complete generated result, independent of project apply limits. */
export function serializeGeneratedSubtitles(
  input: readonly GeneratedCueInput[],
  durationMs: number,
  format: GeneratedSubtitleFormat,
) {
  const cues = normalizeGeneratedCues(input, durationMs);
  if (format === "json") {
    return JSON.stringify(
      {
        version: 1,
        generated: true,
        durationMs: Math.max(0, durationMs),
        cues: cues.map(({ startMs, endMs, text, words }) => ({
          startMs,
          endMs,
          text,
          ...(words
            ? {
                words: words.map(({ textStart, textEnd, startMs: wordStart, endMs: wordEnd }) => ({
                  textStart,
                  textEnd,
                  startMs: wordStart,
                  endMs: wordEnd,
                })),
              }
            : {}),
        })),
      },
      null,
      2,
    );
  }
  if (format === "lrc") {
    const inlineTimestamp = (timeMs: number) =>
      lrcTimestamp(timeMs).replaceAll("[", "<").replaceAll("]", ">");
    return [
      "[by:Pulseframe]",
      "[re:Machine-generated lyrics]",
      ...cues.map(
        (cue) =>
          lrcTimestamp(cue.startMs) +
          textWithWordMarkers(cue.text, cue.words, inlineTimestamp, (value) => value, cue.endMs),
      ),
    ].join("\n");
  }
  const stamp = (milliseconds: number, separator: string) => {
    const total = Math.max(0, Math.round(milliseconds));
    const hours = Math.floor(total / 3_600_000);
    const minutes = Math.floor((total % 3_600_000) / 60_000);
    const seconds = Math.floor((total % 60_000) / 1000);
    const fraction = total % 1000;
    return (
      String(hours).padStart(2, "0") +
      ":" +
      String(minutes).padStart(2, "0") +
      ":" +
      String(seconds).padStart(2, "0") +
      separator +
      String(fraction).padStart(3, "0")
    );
  };
  const body = cues
    .map((cue, index) => {
      const lines =
        stamp(cue.startMs, format === "vtt" ? "." : ",") +
        " --> " +
        stamp(cue.endMs, format === "vtt" ? "." : ",") +
        "\n" +
        (format === "vtt"
          ? textWithWordMarkers(
              cue.text,
              cue.words,
              (timeMs) => "<" + stamp(timeMs, ".") + ">",
              escapeVttText,
              cue.endMs,
            )
          : cue.text);
      return (format === "srt" ? String(index + 1) + "\n" : "") + lines;
    })
    .join("\n\n");
  return format === "vtt" ? "WEBVTT\n\n" + body + "\n" : body + "\n";
}
