import type { ComponentProps } from "react";
import type { SubtitleEditor } from "@/components/SubtitleDialog";
import type { UseSubtitleGenerationOptions } from "@/lib/hooks/use-subtitle-generation";

type SubtitleEditorProps = Omit<ComponentProps<typeof SubtitleEditor>, "generation" | "inline">;

export type SubtitleWorkspaceProps = SubtitleEditorProps & {
  desktopLayout: boolean;
  open: boolean;
  options: UseSubtitleGenerationOptions;
  onRunningChange: (running: boolean) => void;
};
