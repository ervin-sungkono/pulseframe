import type { SubtitleCue } from "@/lib/subtitles/model";

export type SubtitleImportPanelProps = {
  trackFile?: File | null;
  duration: number;
  cues: SubtitleCue[];
  onChange: (cues: SubtitleCue[]) => void;
  disabled: boolean;
};
