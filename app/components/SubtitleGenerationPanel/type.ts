import type { SubtitleGenerationController } from "@/lib/hooks/use-subtitle-generation";

export type SubtitleGenerationPanelProps = {
  generation: SubtitleGenerationController;
  trackFile?: File | null;
  disabled?: boolean;
  onApplied?: () => void;
};

export type SubtitleGenerationStatusProps = {
  generation: SubtitleGenerationController;
  onOpen: () => void;
};
