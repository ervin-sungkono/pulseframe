import type { SubtitleCue } from "@/lib/subtitles/model";

export type SubtitleCueRowActions = {
  onTextChange: (id: string, text: string) => void;
  onStartChange: (id: string, time: number) => void;
  onEndChange: (id: string, time: number) => void;
  onRemove: (id: string) => void;
  onPreview: (id: string) => void;
  setElement: (id: string, element: HTMLDivElement | null) => void;
};

export type SubtitleCueRowProps = {
  cue: SubtitleCue;
  index: number;
  editorId: string;
  active: boolean;
  duration: number;
  editingDisabled: boolean;
  previewDisabled: boolean;
  actions: SubtitleCueRowActions;
};
