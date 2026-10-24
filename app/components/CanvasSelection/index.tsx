import { memo } from "react";
import { useCompositionInteraction } from "@/lib/hooks/use-composition-interaction";
import type { CanvasSelectionProps } from "./type";

export const CanvasSelection = memo(function CanvasSelection(props: CanvasSelectionProps) {
  const { selected, ...handlers } = useCompositionInteraction(props);
  return (
    <div
      className="canvas-selection"
      role="group"
      tabIndex={0}
      aria-label="Canvas editor. Select an element; drag its name to move, use corner handles to resize, or arrow keys to nudge."
      {...handlers}
    >
      {selected && (
        <div
          className={`selection-frame ${selected.locked ? "is-locked" : ""}`}
          style={{
            left: `${selected.transform.x * 100}%`,
            top: `${selected.transform.y * 100}%`,
            width: `${selected.transform.width * 100}%`,
            height: `${selected.transform.height * 100}%`,
            transform: `translate(-50%,-50%) rotate(${selected.transform.rotation}deg)`,
          }}
        >
          <span className="selection-name" data-handle="move" title="Drag to move">
            {selected.name}
            {selected.locked ? " · Locked" : ""}
          </span>
          {!selected.locked && (
            <>
              {["nw", "ne", "sw", "se"].map((handle) => (
                <span
                  key={handle}
                  className={`selection-handle ${handle}`}
                  data-handle={handle}
                  title="Resize from center; Shift preserves proportions"
                />
              ))}
              <span className="selection-handle rotate" data-handle="rotate" title="Rotate" />
            </>
          )}
        </div>
      )}
    </div>
  );
});
