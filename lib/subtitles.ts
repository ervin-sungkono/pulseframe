export type SubtitleCue = {
  id: string;
  start: number;
  end: number;
  text: string;
};

export const MAX_SUBTITLE_CUES = 500;
export const MAX_SUBTITLE_TEXT_LENGTH = 600;
export const MAX_SUBTITLE_HISTORY = 20;

function copyCues(cues: SubtitleCue[]) {
  return cues.map((cue) => ({ ...cue }));
}

/** Bounded cue-only undo history; snapshots never retain media resources. */
export class SubtitleHistory {
  private current: SubtitleCue[];
  private past: SubtitleCue[][] = [];
  private future: SubtitleCue[][] = [];
  private lastGroup: string | null = null;
  private version = 0;
  private listeners = new Set<() => void>();

  constructor(cues: SubtitleCue[] = []) {
    this.current = copyCues(cues);
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.version;

  private notify() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  endGroup() {
    this.lastGroup = null;
  }

  sync(cues: SubtitleCue[]) {
    const same =
      cues.length === this.current.length &&
      cues.every((cue, index) => {
        const previous = this.current[index];
        return (
          cue.id === previous.id &&
          cue.start === previous.start &&
          cue.end === previous.end &&
          cue.text === previous.text
        );
      });
    if (same) return;
    this.current = copyCues(cues);
    this.past = [];
    this.future = [];
    this.lastGroup = null;
    this.notify();
  }

  commit(cues: SubtitleCue[], group?: string) {
    if (!group || this.lastGroup !== group) {
      this.past = [...this.past, copyCues(this.current)].slice(-MAX_SUBTITLE_HISTORY);
    }
    this.current = copyCues(cues);
    this.future = [];
    this.lastGroup = group ?? null;
    this.notify();
    return copyCues(this.current);
  }

  undo() {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future = [...this.future, copyCues(this.current)].slice(-MAX_SUBTITLE_HISTORY);
    this.current = previous;
    this.lastGroup = null;
    this.notify();
    return copyCues(this.current);
  }

  redo() {
    const next = this.future.pop();
    if (!next) return null;
    this.past = [...this.past, copyCues(this.current)].slice(-MAX_SUBTITLE_HISTORY);
    this.current = next;
    this.lastGroup = null;
    this.notify();
    return copyCues(this.current);
  }
}

/**
 * Cues use half-open intervals. In an overlap, the earliest-start nonblank cue
 * wins; stable input order breaks ties between cues with the same start.
 */

export function activeSubtitle(cues: SubtitleCue[], time: number) {
  return cues.reduce<SubtitleCue | undefined>(
    (first, cue) =>
      cue.start <= time && time < cue.end && cue.text.trim() && (!first || cue.start < first.start)
        ? cue
        : first,
    undefined,
  );
}

export function hasSubtitleOverlap(cues: SubtitleCue[]) {
  const sorted = cues.slice().sort((a, b) => a.start - b.start);
  let furthestEnd = Number.NEGATIVE_INFINITY;
  for (const cue of sorted) {
    if (cue.start < furthestEnd) return true;
    furthestEnd = Math.max(furthestEnd, cue.end);
  }
  return false;
}
