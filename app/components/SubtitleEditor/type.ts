import type { SubtitleGenerationController } from "@/lib/hooks/use-subtitle-generation";
import type { SubtitleCue } from "@/lib/subtitles/model";

export type SubtitleEditorProps = {
  onOpenChange: (open: boolean) => void;
  cues: SubtitleCue[];
  onChange: (cues: SubtitleCue[]) => void;
  position: number;
  duration: number;
  onPreview: (time: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  onEditStyle?: () => void;
  generation?: SubtitleGenerationController;
  trackFile?: File | null;
  disabled?: boolean;
};
