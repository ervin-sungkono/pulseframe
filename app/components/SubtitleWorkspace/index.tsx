import { useEffect } from "react";
import { SubtitleEditor } from "@/components/SubtitleEditor";
import { SubtitleGenerationStatus } from "@/components/SubtitleGenerationPanel";
import { useSubtitleGeneration } from "@/lib/hooks/use-subtitle-generation";

import type { SubtitleWorkspaceProps } from "./type";

/** Keeps generation progress local while the workspace is opened and closed. */
export function SubtitleWorkspace({
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
      <section
        className="lyrics-workspace"
        aria-label="Subtitle workspace"
        hidden={!open}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            editor.onOpenChange(false);
          }
        }}
      >
        <SubtitleEditor {...editor} generation={generation} />
      </section>
      {!open && (
        <SubtitleGenerationStatus
          generation={generation}
          onOpen={() => editor.onOpenChange(true)}
        />
      )}
    </>
  );
}
