import type { SubtitleEditorProps } from "@/components/SubtitleEditor/type";
import type { UseSubtitleGenerationOptions } from "@/lib/hooks/use-subtitle-generation";

export type SubtitleWorkspaceProps = Omit<SubtitleEditorProps, "generation"> & {
  open: boolean;
  options: UseSubtitleGenerationOptions;
  onRunningChange: (running: boolean) => void;
};
