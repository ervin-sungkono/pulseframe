export type SubtitleCue = {
  id: string;
  start: number;
  end: number;
  text: string;
};

export function activeSubtitle(cues: SubtitleCue[], time: number) {
  return cues.reduce<SubtitleCue | undefined>(
    (first, cue) =>
      cue.start <= time && time < cue.end && cue.text.trim() && (!first || cue.start < first.start)
        ? cue
        : first,
    undefined,
  );
}
