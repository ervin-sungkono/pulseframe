import "./export-workflows.css";
import { useState } from "react";
import { Download, FolderOpen, Play, RotateCcw, Scissors } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { EXPORT_FRAME_RATES, type ExportFrameRate } from "@/lib/export-timeline";
import { EXPORT_RESOLUTIONS, type ExportResolution } from "@/lib/export-settings";
import type { ExportProgress } from "@/lib/export-video";
import type { TimeRange } from "@/lib/export-time-estimate";
import type { ExportDestination } from "@/lib/export-destination";
import { pickExportDestination, supportsFileExport } from "@/lib/export-destination";

export function timestamp(value: number, precise = false) {
  const seconds = Math.max(0, Number.isFinite(value) ? value : 0);
  const minutes = Math.floor(seconds / 60);
  const rest = precise
    ? (seconds % 60).toFixed(1).padStart(4, "0")
    : String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${minutes}:${rest}`;
}
function parseTimestamp(raw: string) {
  const parts = raw.trim().split(":");
  if (parts.length > 2 || parts.some((part) => part === "" || !/^\d+(\.\d+)?$/.test(part)))
    return null;
  const seconds = parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0]);
  return Number.isFinite(seconds) ? seconds : null;
}
function estimateLabel(range: TimeRange) {
  const low = Math.max(1, Math.floor(range.minSeconds));
  const high = Math.max(low, Math.ceil(range.maxSeconds));
  if (high < 60) return `about ${low}–${high} seconds`;
  const lowMinutes = Math.max(1, Math.floor(low / 60));
  const highMinutes = Math.max(lowMinutes, Math.ceil(high / 60));
  return lowMinutes === highMinutes
    ? `about ${lowMinutes} ${lowMinutes === 1 ? "minute" : "minutes"}`
    : `about ${lowMinutes}–${highMinutes} minutes`;
}
function TimeField({
  label,
  value,
  onCommit,
  disabled,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="time-field">
      <span>{label}</span>
      <input
        aria-label={`${label} timestamp`}
        inputMode="decimal"
        value={draft ?? timestamp(value, true)}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={() => {
          const parsed = parseTimestamp(draft ?? timestamp(value, true));
          setDraft(null);
          if (parsed !== null) onCommit(parsed);
        }}
      />
    </label>
  );
}

export function ExportDialog({
  open,
  onOpenChange,
  duration,
  range,
  onRangeChange,
  dimensions,
  exporting,
  resolution,
  onResolutionChange,
  videoCompression,
  onVideoCompressionChange,
  frameRate,
  onFrameRateChange,
  progress,
  estimateBeforeExport,
  onExport,
  onCancel,
  onPreview,
  paused = false,
  onPause,
  onResume,
  cachedExtension = null,
  suggestedFilename = "pulseframe-export",
  onExportToFile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  duration: number;
  range: [number, number];
  onRangeChange: (range: [number, number]) => void;
  dimensions: { width: number; height: number; label: string };
  resolution: ExportResolution;
  onResolutionChange: (resolution: ExportResolution) => void;
  videoCompression: boolean;
  onVideoCompressionChange: (enabled: boolean) => void;
  frameRate: ExportFrameRate;
  onFrameRateChange: (rate: ExportFrameRate) => void;
  exporting: boolean;
  progress: ExportProgress | null;
  estimateBeforeExport: TimeRange | null;
  onExport: () => void;
  onCancel: () => void;
  onPreview: () => void;
  paused?: boolean;
  onPause?: () => void;
  onResume?: () => void;
  cachedExtension?: "mp4" | "webm" | null;
  suggestedFilename?: string;
  onExportToFile?: (destination: ExportDestination) => void;
}) {
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const editingDisabled = exporting || pickerBusy;
  const selected = Math.max(0, range[1] - range[0]);
  const remaining = progress?.remainingEstimate?.range;
  const safeChange = (start: number, end: number) => {
    const clampedStart = Math.max(0, Math.min(start, duration - 0.1));
    const clampedEnd = Math.max(clampedStart + 0.1, Math.min(end, duration));
    onRangeChange([clampedStart, clampedEnd]);
  };
  const saveDirectlyToFile = () => {
    if (!cachedExtension || !onExportToFile) return;
    setPickerBusy(true);
    setPickerError("");
    // Open the native picker from the user's click before export preparation.
    void pickExportDestination(cachedExtension, suggestedFilename)
      .then((destination) => {
        if (destination) onExportToFile(destination);
      })
      .catch((caught) =>
        setPickerError(
          caught instanceof Error ? caught.message : "The file could not be selected.",
        ),
      )
      .finally(() => setPickerBusy(false));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="export-dialog">
        <DialogHeader>
          <div className="dialog-icon">
            <Scissors size={19} />
          </div>
          <DialogTitle>Export visualizer</DialogTitle>
          <DialogDescription>
            Choose the section you want. Frames are rendered directly from the media timeline.
          </DialogDescription>
        </DialogHeader>
        <div className="export-range-section">
          <div className="range-heading">
            <strong>Time range</strong>
            <button onClick={() => safeChange(0, duration)} disabled={editingDisabled}>
              <RotateCcw size={13} /> Full track
            </button>
          </div>
          <div className="range-readout">
            <span>{timestamp(range[0], true)}</span>
            <span className="range-duration">{timestamp(selected, true)} selected</span>
            <span>{timestamp(range[1], true)}</span>
          </div>
          <Slider
            aria-label="Selected export time range"
            className="studio-slider range-slider"
            value={range}
            min={0}
            max={duration || 1}
            step={0.1}
            minStepsBetweenThumbs={1}
            disabled={editingDisabled || duration <= 0}
            onValueChange={(values) => safeChange(values[0], values[1])}
          />
          <div className="range-fields">
            <TimeField
              label="Start"
              value={range[0]}
              disabled={editingDisabled}
              onCommit={(value) => safeChange(value, range[1])}
            />
            <TimeField
              label="End"
              value={range[1]}
              disabled={editingDisabled}
              onCommit={(value) => safeChange(range[0], value)}
            />
          </div>
          <button
            className="preview-selection"
            onClick={onPreview}
            disabled={editingDisabled || selected < 0.1}
          >
            <Play size={14} /> Preview selected section
          </button>
        </div>
        <div className="export-quality">
          <strong>Video resolution</strong>
          <div
            className="export-profile-list export-resolution-list"
            role="group"
            aria-label="Video resolution"
          >
            {EXPORT_RESOLUTIONS.map((value) => (
              <button
                key={value}
                className={resolution === value ? "selected" : ""}
                aria-pressed={resolution === value}
                disabled={editingDisabled}
                onClick={() => onResolutionChange(value)}
              >
                <strong>{value}p</strong>
                <span>
                  {value === 480
                    ? "Compact"
                    : value === 720
                      ? "HD"
                      : value === 1080
                        ? "Full HD"
                        : "Quad HD"}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="export-quality">
          <strong>Frame rate</strong>
          <div
            className="export-profile-list export-frame-rate-list"
            role="group"
            aria-label="Frame rate"
          >
            {EXPORT_FRAME_RATES.map((rate) => (
              <button
                key={rate}
                className={frameRate === rate ? "selected" : ""}
                aria-pressed={frameRate === rate}
                disabled={editingDisabled}
                onClick={() => onFrameRateChange(rate)}
              >
                <strong>{rate} fps</strong>
                <span>{rate === 24 ? "Fewer frames" : rate === 30 ? "Balanced" : "Smoother"}</span>
              </button>
            ))}
          </div>
          <p className="export-footnote">
            60 fps makes motion smoother and takes longer to export.
          </p>
        </div>
        <div className="export-quality">
          <label className="video-compression-option">
            <input
              type="checkbox"
              checked={videoCompression}
              disabled={editingDisabled}
              onChange={(event) => onVideoCompressionChange(event.currentTarget.checked)}
            />
            <strong>Video compression</strong>
          </label>
          <p className="export-footnote">
            Reduce file size with a slightly lower video quality setting. Designed for minimal
            visible change; fine details may differ. Resolution, frame rate and audio quality stay
            the same.
          </p>
        </div>
        <div className="export-summary">
          <div>
            <span>Canvas</span>
            <strong>
              {dimensions.label} · {dimensions.width} × {dimensions.height}
            </strong>
          </div>
          <div>
            <span>Frame rate</span>
            <strong>{frameRate} fps</strong>
          </div>
          <div>
            <span>Format</span>
            <strong>MP4 or WebM, based on device support</strong>
          </div>
        </div>
        {!exporting && (
          <p className="export-time-estimate">
            Estimated export time:{" "}
            {estimateBeforeExport
              ? estimateLabel(estimateBeforeExport)
              : "An estimate will be available after export starts."}
          </p>
        )}
        {pickerError && (
          <p className="export-dialog-error" role="alert">
            {pickerError}
          </p>
        )}
        {exporting && (
          <div className="export-progress">
            <div>
              <strong aria-live="polite">{progress?.phase ?? "Preparing media"}</strong>
              <span>{progress?.percent ?? 0}%</span>
            </div>
            <progress aria-label="Export progress" value={progress?.percent ?? 0} max={100} />
            <p>
              Elapsed {timestamp((progress?.elapsedMs ?? 0) / 1000)}
              <span> · </span>
              {remaining
                ? `${estimateLabel(remaining)}${progress?.remainingEstimate?.scope === "rendering" ? " of frame rendering" : " remaining"}`
                : progress?.phase === "Finishing file"
                  ? "Finishing file…"
                  : "Estimating…"}
            </p>
            <p>Keep this tab open while the file is created.</p>
            <p>You can close this dialog while the export continues.</p>
          </div>
        )}
        <div className="dialog-actions">
          {exporting ? (
            <>
              {onPause && onResume && (
                <button
                  className="button button-soft"
                  onClick={paused ? onResume : onPause}
                  aria-pressed={paused}
                >
                  {paused ? "Resume export" : "Pause after this file"}
                </button>
              )}
              <button className="button cancel-export" onClick={onCancel}>
                Cancel export
              </button>
              <button className="button button-soft" onClick={() => onOpenChange(false)}>
                Close
              </button>
            </>
          ) : (
            <>
              {onExportToFile && supportsFileExport() && (
                <button
                  className="button button-soft"
                  onClick={saveDirectlyToFile}
                  disabled={duration <= 0 || selected < 0.1 || !cachedExtension || pickerBusy}
                  title={
                    !cachedExtension
                      ? "Checking whether this video can be exported on this device."
                      : undefined
                  }
                >
                  <FolderOpen size={16} /> {pickerBusy ? "Choosing file…" : "Save directly to file"}
                </button>
              )}
              <button
                className="button export-button"
                onClick={onExport}
                disabled={duration <= 0 || selected < 0.1 || pickerBusy}
              >
                <Download size={18} /> Export selected video
              </button>
            </>
          )}
        </div>
        <p className="export-footnote">
          Export speed depends on your device and clip length. Your file remains in this browser.
        </p>
      </DialogContent>
    </Dialog>
  );
}
