import { memo, useCallback, useState } from "react";
import { Play, Trash2 } from "lucide-react";
import { formatTimestamp, parseTimestamp } from "@/lib/time";
import { MAX_SUBTITLE_TEXT_LENGTH } from "@/lib/subtitles/model";
import type { SubtitleCueRowProps } from "./type";

function CueTime({
  label,
  ariaLabel,
  value,
  max,
  onChange,
  disabled,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  max: number;
  onChange: (time: number) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="cue-time">
      <span>{label}</span>
      <input
        inputMode="decimal"
        aria-label={ariaLabel}
        value={draft ?? formatTimestamp(value, true)}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={() => {
          const parsed = parseTimestamp(draft ?? formatTimestamp(value, true));
          setDraft(null);
          if (parsed !== null) onChange(Math.min(max, Math.max(0, parsed)));
        }}
      />
    </label>
  );
}

export const SubtitleCueRow = memo(function SubtitleCueRow({
  cue,
  index,
  editorId,
  active,
  duration,
  editingDisabled,
  previewDisabled,
  actions,
}: SubtitleCueRowProps) {
  const setElement = useCallback(
    (element: HTMLDivElement | null) => actions.setElement(cue.id, element),
    [actions, cue.id],
  );
  return (
    <div ref={setElement} className="subtitle-block" data-active={active} data-cue-id={cue.id}>
      <div className="subtitle-block-heading">
        <strong>
          Block {index + 1}
          {active && <span className="subtitle-current-label">Current</span>}
        </strong>
        <div>
          <button
            disabled={previewDisabled}
            onClick={() => actions.onPreview(cue.id)}
            title="Play from this block"
            aria-label={`Preview block ${index + 1}`}
          >
            <Play size={13} aria-hidden="true" /> Play from here
          </button>
          <button
            disabled={editingDisabled}
            onClick={() => actions.onRemove(cue.id)}
            title="Remove block"
            aria-label={`Remove block ${index + 1}`}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <textarea
        id={`${editorId}-${cue.id}`}
        aria-label={`Subtitle text for block ${index + 1}`}
        placeholder="Type the subtitle here…"
        rows={2}
        maxLength={MAX_SUBTITLE_TEXT_LENGTH}
        value={cue.text}
        disabled={editingDisabled}
        onChange={(event) => actions.onTextChange(cue.id, event.target.value)}
      />
      <div className="cue-range">
        <CueTime
          label="Start"
          ariaLabel={`Block ${index + 1} start timestamp`}
          value={cue.start}
          max={Math.max(0, cue.end - 0.1)}
          disabled={editingDisabled}
          onChange={(time) => actions.onStartChange(cue.id, time)}
        />
        <CueTime
          label="End"
          ariaLabel={`Block ${index + 1} end timestamp`}
          value={cue.end}
          max={duration}
          disabled={editingDisabled}
          onChange={(time) => actions.onEndChange(cue.id, time)}
        />
      </div>
    </div>
  );
});

export type { SubtitleCueRowActions } from "./type";
