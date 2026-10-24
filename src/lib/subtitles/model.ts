export type SubtitleWord = {
  /** UTF-16 code-unit offset into the cue's unchanged text, inclusive. */
  textStart: number;
  /** UTF-16 code-unit offset into the cue's unchanged text, exclusive. */
  textEnd: number;
  /** Absolute source time in seconds, inclusive. */
  start: number;
  /** Absolute source time in seconds, exclusive. */
  end: number;
};

export type SubtitleCue = {
  id: string;
  start: number;
  end: number;
  text: string;
  words?: SubtitleWord[];
};

export type SubtitleCuePatch = Partial<Pick<SubtitleCue, "start" | "end" | "text">>;

export const MAX_SUBTITLE_CUES = 500;
export const MAX_SUBTITLE_TEXT_LENGTH = 600;

function splitsSurrogatePair(text: string, offset: number) {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Validate text offsets and absolute word times against their unchanged cue text and bounds. */
export function validateSubtitleWords(
  text: string,
  words: unknown,
  bounds?: { start: number; end: number },
): SubtitleWord[] | undefined {
  if (!Array.isArray(words) || words.length === 0 || words.length > MAX_SUBTITLE_TEXT_LENGTH)
    return undefined;
  if (
    bounds &&
    (!Number.isFinite(bounds.start) || !Number.isFinite(bounds.end) || bounds.end <= bounds.start)
  )
    return undefined;

  let previousTextEnd = 0;
  const validWords: SubtitleWord[] = [];
  for (const word of words) {
    if (
      !word ||
      typeof word !== "object" ||
      !Number.isSafeInteger(word.textStart) ||
      !Number.isSafeInteger(word.textEnd) ||
      word.textStart < previousTextEnd ||
      word.textEnd <= word.textStart ||
      word.textEnd > text.length ||
      splitsSurrogatePair(text, word.textStart) ||
      splitsSurrogatePair(text, word.textEnd) ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.end <= word.start ||
      (bounds !== undefined && (word.start < bounds.start || word.end > bounds.end)) ||
      !text.slice(word.textStart, word.textEnd).trim()
    )
      return undefined;
    validWords.push({
      textStart: word.textStart,
      textEnd: word.textEnd,
      start: word.start,
      end: word.end,
    });
    previousTextEnd = word.textEnd;
  }
  return validWords;
}

/** Update a cue while keeping its word timing valid or clearing it. */
export function updateSubtitleCue(oldCue: SubtitleCue, patch: SubtitleCuePatch): SubtitleCue {
  const next: SubtitleCue = { ...oldCue, ...patch };
  const textChanged = next.text !== oldCue.text;
  if (textChanged || !oldCue.words) {
    delete next.words;
    return next;
  }

  const startDelta = next.start - oldCue.start;
  const endDelta = next.end - oldCue.end;
  const words = oldCue.words.map((word) => ({ ...word }));
  if (startDelta === endDelta && startDelta !== 0) {
    for (const word of words) {
      word.start += startDelta;
      word.end += startDelta;
    }
  }
  const validWords = validateSubtitleWords(next.text, words, next);
  if (validWords) next.words = validWords;
  else delete next.words;
  return next;
}

/** Return every nonblank cue active at time, ordered earliest first with stable ties. */
export function activeSubtitles(cues: SubtitleCue[], time: number) {
  return cues
    .map((cue, index) => ({ cue, index }))
    .filter(
      ({ cue }) =>
        Number.isFinite(cue.start) &&
        Number.isFinite(cue.end) &&
        cue.start <= time &&
        time < cue.end &&
        cue.end > cue.start &&
        typeof cue.text === "string" &&
        !!cue.text.trim(),
    )
    .sort((left, right) => left.cue.start - right.cue.start || left.index - right.index)
    .map(({ cue }) => cue);
}
