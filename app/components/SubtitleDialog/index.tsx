import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Captions, Pause, Play, Plus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { SubtitleImportPanel } from "@/components/SubtitleImportPanel";
import { SubtitleCueRow, type SubtitleCueRowActions } from "@/components/SubtitleCueRow";
import { SubtitleGenerationPanel } from "@/components/SubtitleGenerationPanel";
import { formatTimestamp } from "@/lib/time";
import { MAX_SUBTITLE_CUES, type SubtitleCuePatch, updateSubtitleCue } from "@/lib/subtitles/model";
import type { SubtitleDialogProps, SubtitleEditorProps } from "./type";

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
  onEditStyle,
  generation,
  trackFile,
  disabled = false,
}: SubtitleEditorProps) {
  const editorId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"edit" | "import" | "generate">(() =>
    generation?.running ? "generate" : "edit",
  );
  const [followPlayhead, setFollowPlayhead] = useState(false);
  const [wordTimingNotice, setWordTimingNotice] = useState(false);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    if (inline) scrollRef.current?.closest<HTMLElement>(".lyrics-workspace")?.scrollTo({ top: 0 });
  }, [tab, inline]);
  const editTabRef = useRef<HTMLButtonElement>(null);
  const focusCue = useRef<string | null>(null);
  const cueElements = useRef(new Map<string, HTMLDivElement>());
  const editorActionState = useRef({
    cues,
    onChange,
    onPreview,
    onOpenChange,
    inline,
    onWordTimingCleared: () => setWordTimingNotice(true),
  });
  useEffect(() => {
    editorActionState.current = {
      cues,
      onChange,
      onPreview,
      onOpenChange,
      inline,
      onWordTimingCleared: () => setWordTimingNotice(true),
    };
  }, [cues, onChange, onOpenChange, onPreview, inline]);
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
  const applyCuePatch = useCallback((id: string, patch: SubtitleCuePatch) => {
    const current = editorActionState.current;
    const oldCue = current.cues.find((cue) => cue.id === id);
    if (!oldCue) return;
    const updated = updateSubtitleCue(oldCue, patch);
    if (oldCue.words && !updated.words) current.onWordTimingCleared();
    current.onChange(current.cues.map((cue) => (cue.id === id ? updated : cue)));
  }, []);
  const onStartChange = useCallback(
    (id: string, time: number) => {
      const cue = editorActionState.current.cues.find((item) => item.id === id);
      if (cue)
        applyCuePatch(id, { start: Math.min(Math.max(0, time), Math.max(0, cue.end - 0.1)) });
    },
    [applyCuePatch],
  );
  const onEndChange = useCallback(
    (id: string, time: number) => {
      const cue = editorActionState.current.cues.find((item) => item.id === id);
      if (cue) applyCuePatch(id, { end: Math.max(cue.start + 0.1, time) });
    },
    [applyCuePatch],
  );
  const onRemove = useCallback((id: string) => {
    const current = editorActionState.current;
    current.onChange(current.cues.filter((cue) => cue.id !== id));
  }, []);
  const onPreviewCue = useCallback((id: string) => {
    const current = editorActionState.current;
    const cue = current.cues.find((item) => item.id === id);
    if (!cue) return;
    current.onPreview(cue.start);
    if (!current.inline) current.onOpenChange(false);
  }, []);
  const setCueElement = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) cueElements.current.set(id, element);
    else cueElements.current.delete(id);
  }, []);
  const cueActions = useMemo<SubtitleCueRowActions>(
    () => ({
      onTextChange: (id, text) => applyCuePatch(id, { text }),
      onStartChange,
      onEndChange,
      onRemove,
      onPreview: onPreviewCue,
      setElement: setCueElement,
    }),
    [applyCuePatch, onEndChange, onPreviewCue, onRemove, onStartChange, setCueElement],
  );
  const add = () => {
    const start = Math.max(0, Math.min(position, Math.max(0, duration - 0.2)));
    const end = Math.min(duration, start + 2.5);
    const id = crypto.randomUUID();
    focusCue.current = id;
    onChange([...cues, { id, start, end, text: "" }]);
  };
  const sorted = useMemo(() => [...cues].sort((a, b) => a.start - b.start), [cues]);
  const overlaps = useMemo(
    () => sorted.some((cue, index) => index > 0 && cue.start < sorted[index - 1].end),
    [sorted],
  );
  const activeCueId = sorted.find((cue) => cue.start <= position && position < cue.end)?.id ?? null;
  const previousActiveCueId = useRef<string | null>(null);
  useEffect(() => {
    if (previousActiveCueId.current === activeCueId) return;
    previousActiveCueId.current = activeCueId;
    if (
      !followPlayhead ||
      tab !== "edit" ||
      !activeCueId ||
      document.activeElement instanceof HTMLTextAreaElement
    )
      return;
    cueElements.current.get(activeCueId)?.scrollIntoView({ block: "nearest" });
  }, [activeCueId, followPlayhead, tab]);

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
          disabled={disabled || !duration}
          aria-label={playing ? "Pause subtitle preview" : "Play subtitle preview"}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
          {playing ? "Pause" : "Play"}
        </button>
        <span>
          Playhead <time>{formatTimestamp(position, true)}</time>
        </span>
        <label>
          <input
            type="checkbox"
            checked={followPlayhead}
            onChange={(event) => setFollowPlayhead(event.target.checked)}
          />
          Follow playhead
        </label>
      </div>
      <div className="subtitle-topline" hidden={tab !== "edit"}>
        <span>
          {cues.length} {cues.length === 1 ? "block" : "blocks"}
        </span>
        {onEditStyle && (
          <button className="button button-soft" onClick={onEditStyle}>
            Style &amp; animation
          </button>
        )}
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
              <SubtitleCueRow
                key={cue.id}
                cue={cue}
                index={index}
                editorId={editorId}
                active={cue.id === activeCueId}
                duration={duration}
                editingDisabled={editingDisabled}
                previewDisabled={disabled}
                actions={cueActions}
              />
            ))}
          </div>
          {wordTimingNotice && (
            <p className="subtitle-warning" role="status">
              Text or timing changes that invalidate word timing remove it from this caption.
            </p>
          )}
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

export function SubtitleDialog({ open, ...props }: SubtitleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent className="subtitle-dialog">
        <SubtitleEditor {...props} />
      </DialogContent>
    </Dialog>
  );
}
