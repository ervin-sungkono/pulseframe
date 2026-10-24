import { useEffect, type ComponentProps } from "react";
import { SubtitleDialog, SubtitleEditor } from "@/components/SubtitleDialog";
import { SubtitleGenerationStatus } from "@/components/SubtitleGenerationPanel";
import type { UseSubtitleGenerationOptions } from "@/lib/hooks/use-subtitle-generation";
import { useSubtitleGeneration } from "@/lib/hooks/use-subtitle-generation";

type SubtitleEditorProps = Omit<ComponentProps<typeof SubtitleEditor>, "generation" | "inline">;

type SubtitleWorkspaceProps = SubtitleEditorProps & {
  desktopLayout: boolean;
  open: boolean;
  options: UseSubtitleGenerationOptions;
  onRunningChange: (running: boolean) => void;
};

/** Keeps generation state alive while the editor changes between inline and modal layouts. */
export function SubtitleWorkspace({
  desktopLayout,
  open,
  options,
  onRunningChange,
  ...editor
}: SubtitleWorkspaceProps) {
  const generation = useSubtitleGeneration(options);

  useEffect(() => {
    onRunningChange(generation.running);
  }, [generation.running, onRunningChange]);

  return (
    <>
      {desktopLayout && open && (
        <aside
          className="subtitle-dialog subtitle-panel"
          aria-label="Subtitle editor"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.preventDefault();
              editor.onOpenChange(false);
            }
          }}
        >
          <SubtitleEditor inline {...editor} generation={generation} />
        </aside>
      )}
      {!desktopLayout && <SubtitleDialog open={open} {...editor} generation={generation} />}
      {!open && (
        <SubtitleGenerationStatus
          generation={generation}
          onOpen={() => editor.onOpenChange(true)}
        />
      )}
    </>
  );
}
