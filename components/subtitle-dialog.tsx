"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Captions, Download, Plus, Redo2, Trash2, Undo2, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { timestamp } from "./export-dialog";
import {
  hasSubtitleOverlap,
  MAX_SUBTITLE_CUES,
  MAX_SUBTITLE_TEXT_LENGTH,
  SubtitleHistory,
  type SubtitleCue,
} from "@/lib/subtitles";
import {
  applySubtitleImport,
  exportSubtitles,
  isCurrentSubtitleImport,
  MAX_SUBTITLE_FILE_BYTES,
  offsetSubtitleCues,
  parseSubtitleFile,
  trimSubtitleCues,
  type SubtitleFormat,
} from "@/lib/subtitle-file";

type PendingImport = {
  name: string;
  format: SubtitleFormat;
  cues: SubtitleCue[];
  warnings: string[];
  sourceFile: File;
  trackDuration: number;
  generation: number;
};
type ImportSession = {
  sourceFile: File | null;
  trackDuration: number;
  generation: number;
  pendingImport: PendingImport | null;
  error: string | null;
};

function readTime(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length > 2 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  const seconds = parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0]);
  return Number.isFinite(seconds) ? seconds : null;
}

function readOffset(value: string) {
  const clean = value.trim();
  const sign = clean.startsWith("-") ? -1 : 1;
  const parsed = readTime(clean.replace(/^[+-]/, ""));
  return parsed === null ? null : parsed * sign;
}

function cueId(existing: SubtitleCue[]) {
  const ids = new Set(existing.map((cue) => cue.id));
  let id = "";
  do {
    id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `cue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  } while (ids.has(id));
  return id;
}

function CueTime({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (time: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="cue-time">
      <span>{label}</span>
      <input
        inputMode="decimal"
        aria-label={`${label} timestamp`}
        value={draft ?? timestamp(value, true)}
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
  trackFile,
  selectedRange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cues: SubtitleCue[];
  onChange: (cues: SubtitleCue[]) => void;
  position: number;
  duration: number;
  onSeek: (time: number) => void;
  trackFile?: File | null;
  selectedRange?: [number, number];
}) {
  const importInput = useRef<HTMLInputElement>(null);
  const [history] = useState(() => new SubtitleHistory(cues));
  const historyVersion = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    history.getSnapshot,
  );
  const [importSession, setImportSession] = useState<ImportSession>(() => ({
    sourceFile: trackFile ?? null,
    trackDuration: duration,
    generation: 0,
    pendingImport: null,
    error: null,
  }));
  if (
    importSession.sourceFile !== (trackFile ?? null) ||
    importSession.trackDuration !== duration
  ) {
    setImportSession((current) => ({
      sourceFile: trackFile ?? null,
      trackDuration: duration,
      generation: current.generation + 1,
      pendingImport: null,
      error: null,
    }));
  }
  const { pendingImport, error: importError } = importSession;
  const [importMode, setImportMode] = useState<"replace" | "append">("replace");
  const [bulkOffset, setBulkOffset] = useState("0");
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);

  useEffect(() => {
    history.sync(cues);
  }, [cues, history]);

  const updateImportSession = (change: Partial<ImportSession>) =>
    setImportSession((current) => ({ ...current, ...change }));
  const setPendingImport = (value: PendingImport | null) =>
    updateImportSession({ pendingImport: value });
  const setImportError = (value: string | null) => updateImportSession({ error: value });

  const commit = (next: SubtitleCue[], textCueId?: string) => {
    const committed = history.commit(next, textCueId);
    onChange(committed);
  };
  const undo = () => {
    const previous = history.undo();
    if (!previous) return;
    onChange(previous);
  };
  const redo = () => {
    const next = history.redo();
    if (!next) return;
    onChange(next);
  };
  const update = (id: string, change: Partial<SubtitleCue>, textEdit = false) =>
    commit(
      cues.map((cue) => (cue.id === id ? { ...cue, ...change } : cue)),
      textEdit ? id : undefined,
    );
  const add = () => {
    const start = Math.max(0, Math.min(position, Math.max(0, duration - 0.2)));
    const end = Math.min(duration, start + 2.5);
    const next = [...cues, { id: cueId(cues), start, end, text: "" }];
    setSelectedCueId(next[next.length - 1].id);
    commit(next);
  };

  const outOfRangeCount = pendingImport
    ? pendingImport.cues.filter((cue) => cue.start < 0 || cue.end > duration).length
    : 0;
  const hasCurrentOutOfRange = cues.some((cue) => cue.start < 0 || cue.end > duration);
  const sorted = cues
    .map((cue, order) => ({ cue, order }))
    .sort((a, b) => a.cue.start - b.cue.start || a.order - b.order)
    .map(({ cue }) => cue);
  const overlaps = hasSubtitleOverlap(sorted);

  const applyPendingImport = () => {
    if (!pendingImport) return;
    if (
      !isCurrentSubtitleImport(importSession, {
        sourceFile: pendingImport.sourceFile,
        trackDuration: pendingImport.trackDuration,
        generation: pendingImport.generation,
      })
    ) {
      setPendingImport(null);
      setImportError("The active track changed. Choose the subtitle file again to preview it.");
      return;
    }
    try {
      const next = applySubtitleImport(cues, pendingImport.cues, importMode, duration);
      commit(next);
      setSelectedCueId(next[0]?.id ?? null);
      setPendingImport(null);
      setImportError(null);
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Could not import this subtitle file.",
      );
    }
  };

  const chooseImport = async (file: File | undefined) => {
    if (!file) return;
    if (!trackFile) {
      setImportError("Load a track before importing subtitles.");
      return;
    }
    const generation = importSession.generation + 1;
    const sourceFile = trackFile;
    const trackDuration = duration;
    setImportSession((current) => ({
      ...current,
      generation,
      pendingImport: null,
      error: null,
    }));
    setImportMode("replace");
    if (file.size > MAX_SUBTITLE_FILE_BYTES) {
      setImportError("Subtitle files must be 2 MB or smaller.");
      return;
    }
    const format = file.name.toLowerCase().endsWith(".vtt") ? "vtt" : "srt";
    try {
      const parsed = parseSubtitleFile(await file.text(), format);
      setImportSession((current) => {
        if (!isCurrentSubtitleImport(current, { sourceFile, trackDuration, generation }))
          return current;
        return {
          ...current,
          pendingImport: { name: file.name, ...parsed, sourceFile, trackDuration, generation },
          error: null,
        };
      });
    } catch (error) {
      setImportSession((current) => {
        if (!isCurrentSubtitleImport(current, { sourceFile, trackDuration, generation }))
          return current;
        return {
          ...current,
          error: error instanceof Error ? error.message : "Could not read this subtitle file.",
        };
      });
    }
  };

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      setImportSession((current) => ({
        ...current,
        generation: current.generation + 1,
        pendingImport: null,
        error: null,
      }));
    }
    onOpenChange(nextOpen);
  };

  const trimPendingImport = () => {
    if (!pendingImport) return;
    if (
      !isCurrentSubtitleImport(importSession, {
        sourceFile: pendingImport.sourceFile,
        trackDuration: pendingImport.trackDuration,
        generation: pendingImport.generation,
      })
    ) {
      setPendingImport(null);
      setImportError("The active track changed. Choose the subtitle file again to preview it.");
      return;
    }
    try {
      const result = trimSubtitleCues(pendingImport.cues, duration);
      setPendingImport({ ...pendingImport, cues: result.cues });
      setImportError(
        result.removed
          ? `Trimmed to this track; ${result.removed} fully out-of-range ${result.removed === 1 ? "cue was" : "cues were"} removed.`
          : "Trimmed cue ends to the track duration.",
      );
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not trim these cues.");
    }
  };

  const applyBulkOffset = () => {
    const offset = readOffset(bulkOffset);
    if (offset === null) {
      setBulkError("Enter a time such as 1.5 or -00:02.000.");
      return;
    }
    try {
      commit(offsetSubtitleCues(cues, offset, duration));
      setBulkError(null);
    } catch (error) {
      setBulkError(
        error instanceof Error ? error.message : "The offset would move cues outside the track.",
      );
    }
  };

  const markSelected = (edge: "start" | "end") => {
    const cue = cues.find((item) => item.id === selectedCueId);
    if (!cue) return;
    if ((edge === "start" && position >= cue.end) || (edge === "end" && position <= cue.start)) {
      setBulkError(
        `Move the playhead ${edge === "start" ? "before the cue end" : "after the cue start"} to mark its ${edge}.`,
      );
      return;
    }
    setBulkError(null);
    update(cue.id, { [edge]: position });
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      )
        return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        markSelected("start");
      } else if (event.key.toLowerCase() === "e") {
        event.preventDefault();
        markSelected("end");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const download = (format: SubtitleFormat, range?: [number, number]) => {
    const body = exportSubtitles(cues, format, range);
    const base = trackFile?.name.replace(/\.[^.]+$/, "") || "subtitles";
    const fileName = `${base}${range ? "-selection" : ""}.${format}`;
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="subtitle-dialog">
        <DialogHeader>
          <div className="dialog-icon">
            <Captions size={19} />
          </div>
          <DialogTitle>Subtitles</DialogTitle>
          <DialogDescription>
            Edit source-time captions, import SRT or plain-text WebVTT, and download a sidecar file.
            Overlaps use the earliest-start nonblank cue.
          </DialogDescription>
        </DialogHeader>
        <div className="subtitle-topline">
          <span>
            {cues.length} {cues.length === 1 ? "block" : "blocks"}
          </span>
          <div
            data-history-version={historyVersion}
            style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}
          >
            <button
              className="button button-soft"
              onClick={undo}
              disabled={!history.canUndo}
              title="Undo subtitle change"
            >
              <Undo2 size={15} /> Undo
            </button>
            <button
              className="button button-soft"
              onClick={redo}
              disabled={!history.canRedo}
              title="Redo subtitle change"
            >
              <Redo2 size={15} /> Redo
            </button>
            <button
              className="button button-soft"
              onClick={add}
              disabled={!duration || cues.length >= MAX_SUBTITLE_CUES}
            >
              <Plus size={16} /> Add at {timestamp(position, true)}
            </button>
          </div>
        </div>

        <section
          aria-label="Subtitle file actions"
          style={{ display: "grid", gap: 9, marginBottom: 12 }}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="button button-soft"
              onClick={() => importInput.current?.click()}
              disabled={!trackFile || !duration}
            >
              <Upload size={15} /> Import SRT/VTT
            </button>
            <input
              ref={importInput}
              type="file"
              accept=".srt,.vtt,text/plain,text/vtt,application/x-subrip"
              hidden
              onChange={(event) => {
                void chooseImport(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
            <button
              className="button button-soft"
              onClick={() => download("srt")}
              disabled={!cues.length}
            >
              <Download size={15} /> Full SRT
            </button>
            <button
              className="button button-soft"
              onClick={() => download("vtt")}
              disabled={!cues.length}
            >
              <Download size={15} /> Full VTT
            </button>
          </div>
          {selectedRange && selectedRange[1] > selectedRange[0] && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="button button-soft"
                onClick={() => download("srt", selectedRange)}
                disabled={!cues.length}
              >
                Selected range SRT
              </button>
              <button
                className="button button-soft"
                onClick={() => download("vtt", selectedRange)}
                disabled={!cues.length}
              >
                Selected range VTT
              </button>
            </div>
          )}
        </section>
        {importError && (
          <p className="subtitle-warning" role="status">
            {importError}
          </p>
        )}
        {pendingImport && (
          <section
            className="subtitle-block"
            aria-label="Subtitle import preview"
            style={{ marginBottom: 12 }}
          >
            <strong>Preview: {pendingImport.name}</strong>
            <span style={{ color: "#aebbd0", fontSize: 12 }}>
              {pendingImport.cues.length} cues · {pendingImport.format.toUpperCase()}
              {outOfRangeCount
                ? ` · ${outOfRangeCount} outside this track`
                : " · all cues fit this track"}
            </span>
            {pendingImport.warnings.map((warning) => (
              <span key={warning} className="subtitle-warning">
                {warning}
              </span>
            ))}
            {pendingImport.cues.slice(0, 3).map((cue, index) => (
              <div key={`${cue.id}-${index}`} style={{ fontSize: 12, color: "#d5deee" }}>
                {timestamp(cue.start, true)}–{timestamp(cue.end, true)} ·{" "}
                {cue.text.replace(/\n/g, " / ").slice(0, 100) || "(empty cue)"}
              </div>
            ))}
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              <button
                className={`button ${importMode === "replace" ? "button-soft" : ""}`}
                onClick={() => setImportMode("replace")}
              >
                Replace current
              </button>
              <button
                className={`button ${importMode === "append" ? "button-soft" : ""}`}
                onClick={() => setImportMode("append")}
              >
                Append
              </button>
              {outOfRangeCount > 0 && (
                <button className="button button-soft" onClick={trimPendingImport}>
                  Trim to track duration
                </button>
              )}
              <button
                className="button button-soft"
                onClick={applyPendingImport}
                disabled={
                  outOfRangeCount > 0 ||
                  (importMode === "append" &&
                    cues.length + pendingImport.cues.length > MAX_SUBTITLE_CUES)
                }
              >
                Apply import
              </button>
              <button className="button" onClick={() => setPendingImport(null)}>
                Cancel
              </button>
            </div>
            {importMode === "append" &&
              cues.length + pendingImport.cues.length > MAX_SUBTITLE_CUES && (
                <span className="subtitle-warning">
                  A track can contain at most {MAX_SUBTITLE_CUES} cues.
                </span>
              )}
          </section>
        )}

        <section
          className="subtitle-block"
          aria-label="Bulk subtitle timing"
          style={{ marginBottom: 12 }}
        >
          <strong>Timing tools</strong>
          <div style={{ display: "flex", alignItems: "end", gap: 8, flexWrap: "wrap" }}>
            <label className="cue-time" style={{ maxWidth: 170 }}>
              <span>Offset all cues (seconds or MM:SS)</span>
              <input
                value={bulkOffset}
                onChange={(event) => setBulkOffset(event.target.value)}
                aria-label="Subtitle timing offset"
              />
            </label>
            <button
              className="button button-soft"
              onClick={applyBulkOffset}
              disabled={!cues.length}
            >
              Apply offset
            </button>
            <button
              className="button button-soft"
              onClick={() => markSelected("start")}
              disabled={!selectedCueId}
            >
              Mark selected start · S
            </button>
            <button
              className="button button-soft"
              onClick={() => markSelected("end")}
              disabled={!selectedCueId}
            >
              Mark selected end · E
            </button>
            {hasCurrentOutOfRange && (
              <button
                className="button button-soft"
                onClick={() => {
                  const result = trimSubtitleCues(cues, duration);
                  commit(result.cues);
                }}
              >
                Trim cues to track
              </button>
            )}
          </div>
          {bulkError && (
            <span className="subtitle-warning" role="status">
              {bulkError}
            </span>
          )}
          <span style={{ color: "#8998af", fontSize: 11 }}>
            Select a cue, move the playhead, then press S or E to mark its start or end.
          </span>
        </section>

        <div className="subtitle-list">
          {!cues.length && (
            <div className="subtitle-empty">
              Move to a point in your song, then add a subtitle block or import a file.
            </div>
          )}
          {sorted.map((cue, index) => (
            <div
              key={cue.id}
              className="subtitle-block"
              onFocusCapture={() => setSelectedCueId(cue.id)}
              onClick={() => setSelectedCueId(cue.id)}
              style={selectedCueId === cue.id ? { borderColor: "#a18ad4" } : undefined}
            >
              <div className="subtitle-block-heading">
                <strong>Block {index + 1}</strong>
                <div>
                  <button
                    onClick={() => {
                      setSelectedCueId(cue.id);
                      onSeek(cue.start);
                      onOpenChange(false);
                    }}
                    title="Preview at start"
                    aria-label={`Preview block ${index + 1}`}
                  >
                    Preview
                  </button>
                  <button
                    onClick={() => commit(cues.filter((item) => item.id !== cue.id))}
                    title="Remove block"
                    aria-label={`Remove block ${index + 1}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <textarea
                aria-label={`Subtitle text for block ${index + 1}`}
                placeholder="Type the subtitle here…"
                rows={2}
                maxLength={MAX_SUBTITLE_TEXT_LENGTH}
                value={cue.text}
                onChange={(event) => update(cue.id, { text: event.target.value }, true)}
                onBlur={() => history.endGroup()}
              />
              <div className="cue-range">
                <CueTime
                  label={`Block ${index + 1} start`}
                  value={cue.start}
                  max={Math.max(0, cue.end - 0.1)}
                  onChange={(start) => update(cue.id, { start })}
                />
                <CueTime
                  label={`Block ${index + 1} end`}
                  value={cue.end}
                  max={duration}
                  onChange={(end) => update(cue.id, { end: Math.max(cue.start + 0.1, end) })}
                />
              </div>
            </div>
          ))}
        </div>
        {overlaps && (
          <p className="subtitle-warning">
            Some blocks overlap. The earliest-start nonblank block appears at that moment.
          </p>
        )}
        <button className="button done-button subtitle-done" onClick={() => onOpenChange(false)}>
          Done
        </button>
      </DialogContent>
    </Dialog>
  );
}
