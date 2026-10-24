import type { SubtitleEditorProps } from "@/components/SubtitleDialog/type";
import type { UseSubtitleGenerationOptions } from "@/lib/hooks/use-subtitle-generation";

export type SubtitleWorkspaceProps = Omit<SubtitleEditorProps, "generation" | "inline"> & {
  open: boolean;
  options: UseSubtitleGenerationOptions;
  onRunningChange: (running: boolean) => void;
};
