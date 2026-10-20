import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { Captions, Pause, Play, Plus, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { SubtitleImportPanel } from "@/components/SubtitleImportPanel";
import { SubtitleGenerationPanel } from "@/components/SubtitleGenerationPanel";
import type { SubtitleGenerationController } from "@/hooks/use-subtitle-generation";
import { formatTimestamp, parseTimestamp } from "@/lib/time";
import { MAX_SUBTITLE_CUES, MAX_SUBTITLE_TEXT_LENGTH, type SubtitleCue } from "@/lib/subtitles";

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

export function SubtitleEditor({
  inline = false,
  onOpenChange,
  cues,
  onChange,
  position,
  duration,
  onPreview,
  playing,
  onTogglePlay,
  generation,
  trackFile,
  disabled = false,
}: {
  inline?: boolean;
  onOpenChange: (open: boolean) => void;
  cues: SubtitleCue[];
  onChange: (cues: SubtitleCue[]) => void;
  position: number;
  duration: number;
  onPreview: (time: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  generation?: SubtitleGenerationController;
  trackFile?: File | null;
  disabled?: boolean;
}) {
  const editorId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"edit" | "import" | "generate">(() =>
    generation?.running ? "generate" : "edit",
  );
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab]);
  const editTabRef = useRef<HTMLButtonElement>(null);
  const focusCue = useRef<string | null>(null);
  useEffect(() => {
    if (!focusCue.current) return;
    const field = document.getElementById(`${editorId}-${focusCue.current}`);
    if (field) {
      focusCue.current = null;
      field.focus({ preventScroll: true });
      field.scrollIntoView({ block: "nearest" });
    }
  }, [cues, editorId]);
  const showEditor = () => {
    setTab("edit");
    editTabRef.current?.focus();
  };
  const tabs = (["edit", "import", "generate"] as const).filter(
    (item) => item !== "generate" || generation,
  );
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (inline) titleRef.current?.focus();
  }, [inline]);
  const Title = inline ? "h2" : DialogTitle;
  const Description = inline ? "p" : DialogDescription;
  const editingDisabled = disabled || !!generation?.running;
  const update = (id: string, change: Partial<SubtitleCue>) =>
    onChange(cues.map((cue) => (cue.id === id ? { ...cue, ...change } : cue)));
  const add = () => {
    const start = Math.max(0, Math.min(position, Math.max(0, duration - 0.2)));
    const end = Math.min(duration, start + 2.5);
    const id = crypto.randomUUID();
    focusCue.current = id;
    onChange([...cues, { id, start, end, text: "" }]);
  };
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const overlaps = sorted.some((cue, index) => index > 0 && cue.start < sorted[index - 1].end);

  return (
    <>
      {inline && (
        <button
          className="subtitle-panel-close"
          onClick={() => onOpenChange(false)}
          aria-label="Close subtitle editor"
        >
          <X size={18} />
        </button>
      )}
      <DialogHeader>
        <Title
          ref={titleRef}
          tabIndex={inline ? -1 : undefined}
          data-slot="dialog-title"
          className="subtitle-editor-title"
        >
          <Captions size={19} aria-hidden="true" /> Subtitles
        </Title>
        <Description data-slot="dialog-description">
          Edit captions while listening. Changes appear in the preview immediately.
        </Description>
      </DialogHeader>
      <div className="subtitle-editor-tabs" role="tablist" aria-label="Subtitle tools">
        {tabs.map((item) => (
          <button
            key={item}
            ref={item === "edit" ? editTabRef : undefined}
            type="button"
            role="tab"
            id={`${editorId}-tab-${item}`}
            aria-controls={`${editorId}-panel-${item}`}
            aria-selected={tab === item}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => setTab(item)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const index = tabs.indexOf(item);
              const next =
                event.key === "Home"
                  ? tabs[0]
                  : event.key === "End"
                    ? tabs[tabs.length - 1]
                    : tabs[
                        (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
                      ];
              setTab(next);
              document.getElementById(`${editorId}-tab-${next}`)?.focus();
            }}
          >
            {item === "edit" ? "Edit" : item === "import" ? "Import" : "Generate"}
            {item === "generate" && generation?.running && (
              <span className="subtitle-tab-busy" aria-hidden="true">
                {" "}
                •
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="subtitle-editor-transport">
        <button
          className="button button-soft"
          onClick={onTogglePlay}
          disabled={editingDisabled || !duration}
          aria-label={playing ? "Pause subtitle preview" : "Play subtitle preview"}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
          {playing ? "Pause" : "Play"}
        </button>
        <span>
          Playhead <time>{formatTimestamp(position, true)}</time>
        </span>
      </div>
      <div className="subtitle-topline" hidden={tab !== "edit"}>
        <span>
          {cues.length} {cues.length === 1 ? "block" : "blocks"}
        </span>
        <button
          className="button button-soft"
          onClick={add}
          title={`Add a block at ${formatTimestamp(position, true)}`}
          disabled={editingDisabled || !duration || cues.length >= MAX_SUBTITLE_CUES}
        >
          <Plus size={16} /> Add block
        </button>
      </div>
      <div className="subtitle-dialog-scroll" ref={scrollRef}>
        <div
          role="tabpanel"
          id={`${editorId}-panel-edit`}
          aria-labelledby={`${editorId}-tab-edit`}
          hidden={tab !== "edit"}
        >
          <div className="subtitle-list">
            {!cues.length && (
              <div className="subtitle-empty">
                Seek to a lyric, choose Add block, then type your caption. Use Import for an
                existing subtitle file or Generate for automatic captions.
              </div>
            )}
            {sorted.map((cue, index) => (
              <div
                key={cue.id}
                className="subtitle-block"
                data-active={cue.start <= position && position < cue.end}
              >
                <div className="subtitle-block-heading">
                  <strong>
                    Block {index + 1}
                    {cue.start <= position && position < cue.end && (
                      <span className="subtitle-current-label">Current</span>
                    )}
                  </strong>
                  <div>
                    <button
                      disabled={editingDisabled}
                      onClick={() => {
                        onPreview(cue.start);
                        if (!inline) onOpenChange(false);
                      }}
                      title="Play from this block"
                      aria-label={"Preview block " + (index + 1)}
                    >
                      <Play size={13} aria-hidden="true" /> Play from here
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
                  id={`${editorId}-${cue.id}`}
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
                    label="Start"
                    ariaLabel={"Block " + (index + 1) + " start timestamp"}
                    value={cue.start}
                    max={Math.max(0, cue.end - 0.1)}
                    disabled={editingDisabled}
                    onChange={(start) => update(cue.id, { start })}
                  />
                  <CueTime
                    label="End"
                    ariaLabel={"Block " + (index + 1) + " end timestamp"}
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
        <div
          role="tabpanel"
          id={`${editorId}-panel-import`}
          aria-labelledby={`${editorId}-tab-import`}
          hidden={tab !== "import"}
        >
          <SubtitleImportPanel
            trackFile={trackFile}
            duration={duration}
            cues={cues}
            onChange={(next) => {
              onChange(next);
              showEditor();
            }}
            disabled={editingDisabled}
          />
        </div>
        {generation && (
          <div
            role="tabpanel"
            id={`${editorId}-panel-generate`}
            aria-labelledby={`${editorId}-tab-generate`}
            hidden={tab !== "generate"}
          >
            <SubtitleGenerationPanel
              generation={generation}
              trackFile={trackFile}
              disabled={disabled}
              onApplied={showEditor}
            />
          </div>
        )}
      </div>
      <button className="button done-button subtitle-done" onClick={() => onOpenChange(false)}>
        Done
      </button>
    </>
  );
}

export function SubtitleDialog({
  open,
  ...props
}: ComponentProps<typeof SubtitleEditor> & { open: boolean }) {
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent className="subtitle-dialog">
        <SubtitleEditor {...props} />
      </DialogContent>
    </Dialog>
  );
}
