export type SubtitleCue = {
  id: string;
  start: number;
  end: number;
  text: string;
};

export const MAX_SUBTITLE_CUES = 500;
export const MAX_SUBTITLE_TEXT_LENGTH = 600;

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

/** Kept for callers that need one cue; renderers should use activeSubtitles to stack overlaps. */
export function activeSubtitle(cues: SubtitleCue[], time: number) {
  return activeSubtitles(cues, time)[0];
}
