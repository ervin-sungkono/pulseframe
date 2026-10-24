import { useEffect } from "react";
import { SubtitleDialog, SubtitleEditor } from "@/components/SubtitleDialog";
import { SubtitleGenerationStatus } from "@/components/SubtitleGenerationPanel";
import { useSubtitleGeneration } from "@/lib/hooks/use-subtitle-generation";

import type { SubtitleWorkspaceProps } from "./type";

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
      {desktopLayout && (
        <section
          className="lyrics-workspace subtitle-dialog subtitle-panel"
          aria-label="Subtitle workspace"
          hidden={!open}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.preventDefault();
              editor.onOpenChange(false);
            }
          }}
        >
          <SubtitleEditor inline {...editor} generation={generation} />
        </section>
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
