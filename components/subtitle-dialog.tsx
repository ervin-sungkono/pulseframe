import { useState } from "react";
import { Captions, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SubtitleGenerationPanel } from "@/components/subtitle-generation-panel";
import type { SubtitleGenerationController } from "@/hooks/use-subtitle-generation";
import { timestamp } from "./export-dialog";
import { MAX_SUBTITLE_CUES, MAX_SUBTITLE_TEXT_LENGTH, type SubtitleCue } from "@/lib/subtitles";

function readTime(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length > 2 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  const seconds = parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0]);
  return Number.isFinite(seconds) ? seconds : null;
}

function CueTime({
  label,
  value,
  max,
  onChange,
  disabled,
}: {
  label: string;
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
        aria-label={label + " timestamp"}
        value={draft ?? timestamp(value, true)}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={() => {
          const parsed = readTime(draft ?? timestamp(value, true));
          setDraft(null);
          if (parsed !== null) onChange(Math.min(max, Math.max(0, parsed)));
        }}
      />
    </label>
  );
}

export function SubtitleDialog({
  open,
  onOpenChange,
  cues,
  onChange,
  position,
  duration,
  onSeek,
  generation,
  trackFile,
  disabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cues: SubtitleCue[];
  onChange: (cues: SubtitleCue[]) => void;
  position: number;
  duration: number;
  onSeek: (time: number) => void;
  generation?: SubtitleGenerationController;
  trackFile?: File | null;
  disabled?: boolean;
}) {
  const editingDisabled = disabled || !!generation?.running;
  const update = (id: string, change: Partial<SubtitleCue>) =>
    onChange(cues.map((cue) => (cue.id === id ? { ...cue, ...change } : cue)));
  const add = () => {
    const start = Math.max(0, Math.min(position, Math.max(0, duration - 0.2)));
    const end = Math.min(duration, start + 2.5);
    const id = crypto.randomUUID();
    onChange([...cues, { id, start, end, text: "" }]);
  };
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const overlaps = sorted.some((cue, index) => index > 0 && cue.start < sorted[index - 1].end);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="subtitle-dialog">
        <DialogHeader>
          <div className="dialog-icon">
            <Captions size={19} />
          </div>
          <DialogTitle>Subtitles</DialogTitle>
          <DialogDescription>
            Add timed caption blocks or generate subtitles from the complete audio track.
          </DialogDescription>
        </DialogHeader>
        <div className="subtitle-dialog-scroll">
          {generation && (
            <SubtitleGenerationPanel
              generation={generation}
              trackFile={trackFile}
              disabled={disabled}
            />
          )}
          <div className="subtitle-topline">
            <span>
              {cues.length} {cues.length === 1 ? "block" : "blocks"}
            </span>
            <button
              className="button button-soft"
              onClick={add}
              disabled={editingDisabled || !duration || cues.length >= MAX_SUBTITLE_CUES}
            >
              <Plus size={16} /> Add at {timestamp(position, true)}
            </button>
          </div>
          <div className="subtitle-list">
            {!cues.length && (
              <div className="subtitle-empty">
                Move to a point in your song, then add a subtitle block.
              </div>
            )}
            {sorted.map((cue, index) => (
              <div key={cue.id} className="subtitle-block">
                <div className="subtitle-block-heading">
                  <strong>Block {index + 1}</strong>
                  <div>
                    <button
                      disabled={editingDisabled}
                      onClick={() => {
                        onSeek(cue.start);
                        onOpenChange(false);
                      }}
                      title="Preview at start"
                      aria-label={"Preview block " + (index + 1)}
                    >
                      Preview
                    </button>
                    <button
                      disabled={editingDisabled}
                      onClick={() => onChange(cues.filter((item) => item.id !== cue.id))}
                      title="Remove block"
                      aria-label={"Remove block " + (index + 1)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                <textarea
                  aria-label={"Subtitle text for block " + (index + 1)}
                  placeholder="Type the subtitle here…"
                  rows={2}
                  maxLength={MAX_SUBTITLE_TEXT_LENGTH}
                  value={cue.text}
                  disabled={editingDisabled}
                  onChange={(event) => update(cue.id, { text: event.target.value })}
                />
                <div className="cue-range">
                  <CueTime
                    label={"Block " + (index + 1) + " start"}
                    value={cue.start}
                    max={Math.max(0, cue.end - 0.1)}
                    disabled={editingDisabled}
                    onChange={(start) => update(cue.id, { start })}
                  />
                  <CueTime
                    label={"Block " + (index + 1) + " end"}
                    value={cue.end}
                    max={duration}
                    disabled={editingDisabled}
                    onChange={(end) => update(cue.id, { end: Math.max(cue.start + 0.1, end) })}
                  />
                </div>
              </div>
            ))}
          </div>
          {overlaps && (
            <p className="subtitle-warning">
              Overlapping blocks stack by start time. Earlier blocks appear above later blocks.
            </p>
          )}
        </div>
        <button className="button done-button subtitle-done" onClick={() => onOpenChange(false)}>
          Done
        </button>
      </DialogContent>
    </Dialog>
  );
}
