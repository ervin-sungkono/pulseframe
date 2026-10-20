import { useId, useRef } from "react";
import { Upload } from "lucide-react";
import { useSubtitleImport } from "@/hooks/use-subtitle-import";
import { SUBTITLE_IMPORT_ACCEPT } from "@/lib/subtitles/import";
import type { SubtitleCue } from "@/lib/subtitles/model";
import { formatTimestamp } from "@/lib/time";

export function SubtitleImportPanel({
  trackFile,
  duration,
  cues,
  onChange,
  disabled,
}: {
  trackFile?: File | null;
  duration: number;
  cues: SubtitleCue[];
  onChange: (cues: SubtitleCue[]) => void;
  disabled: boolean;
}) {
  const existingBlocks = `${cues.length} existing ${cues.length === 1 ? "block" : "blocks"}`;
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const importer = useSubtitleImport({ trackFile, duration, cues, onChange, disabled });
  return (
    <section className="subtitle-import-panel" aria-labelledby={titleId}>
      <h3 id={titleId}>
        <Upload size={16} aria-hidden="true" /> Import
      </h3>
      <p>Use an existing SRT, VTT, LRC, or subtitle JSON file. Files stay on your device.</p>
      <input
        ref={input}
        type="file"
        accept={SUBTITLE_IMPORT_ACCEPT}
        aria-label="Subtitle file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importer.read(file);
        }}
      />
      <button
        className="button button-soft"
        disabled={disabled || importer.loading || !trackFile || !duration}
        onClick={() => input.current?.click()}
      >
        <Upload size={15} /> {importer.loading ? "Reading file…" : "Import subtitle file"}
      </button>
      {importer.error && (
        <p className="subtitle-warning" role="alert">
          {importer.error}
        </p>
      )}
      {importer.pending && (
        <div className="subtitle-import-preview" aria-live="polite">
          <strong>
            {importer.pending.filename} · {importer.pending.cues.length}{" "}
            {importer.pending.cues.length === 1 ? "block" : "blocks"}
          </strong>
          {importer.pending.notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
          <ol>
            {importer.pending.cues.slice(0, 3).map((cue, index) => (
              <li key={index}>
                <span>
                  {formatTimestamp(cue.start, true)} – {formatTimestamp(cue.end, true)}
                </span>
                <p>{cue.text}</p>
              </li>
            ))}
          </ol>
          {cues.length > 0 && <p>Applying this import replaces {existingBlocks}.</p>}
          <div className="subtitle-import-actions">
            <button className="button button-soft" disabled={disabled} onClick={importer.apply}>
              {cues.length
                ? `Replace ${existingBlocks}`
                : `Import ${importer.pending.cues.length} ${importer.pending.cues.length === 1 ? "block" : "blocks"}`}
            </button>
            <button className="button button-soft" onClick={importer.cancel}>
              Cancel import
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
