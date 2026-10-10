import "./export-workflows.css";
import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ExportDestination } from "@/lib/export-destination";
import {
  pickExportDestination,
  pickExportDirectoryDestination,
  supportsDirectoryExport,
  supportsFileExport,
} from "@/lib/export-destination";
import type { ExportJobOutput, ExportJobProgress } from "@/lib/export-job";
import type { ExportPreflightResult } from "@/lib/export-preflight";
import type { ExportRequest, ExportRunState } from "@/lib/export-request";
import { exportDimensions } from "@/lib/export-settings";
import type { ExportAspect } from "@/lib/export-settings";

function aspectName(aspect: ExportAspect) {
  return aspect === "landscape" ? "Landscape" : aspect === "portrait" ? "Portrait" : "Square";
}

function requestSummary(request: ExportRequest, preflight?: ExportPreflightResult | null) {
  const source = request.source;
  const size = exportDimensions(source.format, source.resolution);
  if (request.kind === "still")
    return `${aspectName(source.format)} · ${source.resolution}p · ${size.width} × ${size.height} PNG`;
  return `${aspectName(source.format)} · ${source.resolution}p · ${size.width} × ${size.height} · ${source.frameRate} fps · ${preflight?.extension.toUpperCase() ?? "MP4 or WebM"}`;
}

function statusLabel(status: ExportRunState["items"][number]["status"]) {
  if (status === "pending") return "Waiting";
  if (status === "running") return "In progress";
  if (status === "awaiting-download") return "Ready to download";
  if (status === "complete") return "Complete";
  if (status === "failed") return "Failed";
  return "Stopped";
}

function BatchFilenameField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCommit: (filename: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <label className="batch-filename-field">
      <span>Filename</span>
      <input
        aria-label={`Filename for ${label}`}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

export function BatchExportDialog({
  open,
  onOpenChange,
  requests,
  preflights,
  runState,
  progress,
  exporting,
  pendingDownload,
  onRun,
  onDownloadPending,
  onRetryPending,
  onPause,
  onResume,
  onCancel,
  onClear,
  onRemove,
  onMove,
  onRename,
  queueError = "",
  requestLimit = 20,
  onDismissQueueError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requests: readonly ExportRequest[];
  preflights?: ReadonlyMap<string, ExportPreflightResult | null>;
  runState: ExportRunState | null;
  progress: ExportJobProgress | null;
  exporting: boolean;
  pendingDownload: { requestId: string; label: string; filename: string } | null;
  onRun: (destination?: ExportDestination) => void;
  onDownloadPending: () => void;
  onRetryPending: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onClear?: () => void;
  onRemove?: (id: string) => void;
  onMove?: (id: string, offset: -1 | 1) => void;
  onRename?: (id: string, filename: string) => void;
  queueError?: string;
  requestLimit?: number;
  onDismissQueueError?: () => void;
}) {
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const singleRequest = requests.length === 1 ? requests[0] : null;
  const singleExtension: ExportJobOutput["extension"] | null = singleRequest
    ? singleRequest.kind === "still"
      ? "png"
      : (preflights?.get(singleRequest.id)?.extension ?? null)
    : null;
  const completed = runState?.items.filter((item) => item.status === "complete").length ?? 0;
  const retryable =
    requests.length > 0 &&
    !!runState?.items.some(
      (item) => item.status === "failed" || item.status === "stopped" || item.status === "pending",
    );
  const canPickFile = !!singleRequest && !!singleExtension && supportsFileExport();
  const canPickFolder = requests.length > 1 && supportsDirectoryExport();
  const preflightReady =
    requests.length > 0 &&
    requests.every((request) =>
      request.kind === "still" ? !!preflights?.has(request.id) : !!preflights?.get(request.id),
    );
  const duplicateFilename = (() => {
    const names = new Set<string>();
    for (const request of requests) {
      const extension = request.kind === "still" ? "png" : preflights?.get(request.id)?.extension;
      if (!extension) continue;
      const name = `${request.filename}.${extension}`.toLocaleLowerCase("en-US");
      if (names.has(name)) return name;
      names.add(name);
    }
    return "";
  })();
  const canRun = preflightReady && !duplicateFilename;

  const pickFolderAndRun = () => {
    setPickerBusy(true);
    setPickerError("");
    // Invoke the native picker before doing any asynchronous preparation.
    void pickExportDirectoryDestination()
      .then((destination) => {
        if (destination) onRun(destination);
      })
      .catch((caught) =>
        setPickerError(
          caught instanceof Error ? caught.message : "The folder could not be selected.",
        ),
      )
      .finally(() => setPickerBusy(false));
  };

  const pickFileAndRun = () => {
    if (!singleRequest || !singleExtension) return;
    setPickerBusy(true);
    setPickerError("");
    void pickExportDestination(singleExtension, singleRequest.filename)
      .then((destination) => {
        if (destination) onRun(destination);
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
      <DialogContent className="batch-export-dialog">
        <DialogHeader>
          <div className="dialog-icon">
            <Download size={19} />
          </div>
          <DialogTitle>Export batch</DialogTitle>
          <DialogDescription>
            Each request creates its own file. A playlist request stays together as one continuous
            video.
          </DialogDescription>
        </DialogHeader>

        <div className="batch-export-list" aria-label="Export requests">
          {requests.map((request, index) => {
            const state = runState?.items.find((item) => item.id === request.id);
            return (
              <div className="batch-export-item" key={request.id}>
                <span className="batch-export-number">{index + 1}</span>
                <div className="batch-export-copy">
                  <strong>{request.label}</strong>
                  <span>{requestSummary(request, preflights?.get(request.id))}</span>
                  {onRename ? (
                    <BatchFilenameField
                      key={`${request.id}:${request.filename}`}
                      label={request.label}
                      value={request.filename}
                      disabled={exporting}
                      onCommit={(filename) => onRename(request.id, filename)}
                    />
                  ) : (
                    <small>
                      {request.filename}.
                      {request.kind === "still"
                        ? "png"
                        : (preflights?.get(request.id)?.extension ?? "video")}
                    </small>
                  )}
                  {state?.error && <small className="batch-export-error">{state.error}</small>}
                </div>
                <span className={`batch-export-status status-${state?.status ?? "pending"}`}>
                  {state ? statusLabel(state.status) : "Queued"}
                </span>
                {(onMove || onRemove) && !exporting && (
                  <div className="batch-export-item-actions">
                    {onMove && (
                      <>
                        <button
                          className="icon-text-button"
                          aria-label={`Move ${request.label} up`}
                          disabled={index === 0}
                          onClick={() => onMove(request.id, -1)}
                        >
                          <ChevronUp size={15} />
                        </button>
                        <button
                          className="icon-text-button"
                          aria-label={`Move ${request.label} down`}
                          disabled={index === requests.length - 1}
                          onClick={() => onMove(request.id, 1)}
                        >
                          <ChevronDown size={15} />
                        </button>
                      </>
                    )}
                    {onRemove && (
                      <button
                        className="icon-text-button"
                        aria-label={`Remove ${request.label}`}
                        onClick={() => onRemove(request.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {!requests.length && (
            <p className="export-footnote">Add an export request to start a batch.</p>
          )}
        </div>

        <p className="batch-export-count">
          {requests.length} of {requestLimit} requests
        </p>
        {queueError && (
          <p className="batch-export-error" role="alert">
            {queueError}{" "}
            {onDismissQueueError && (
              <button className="text-button" onClick={onDismissQueueError}>
                Dismiss
              </button>
            )}
          </p>
        )}
        {!preflightReady && requests.length > 0 && (
          <p className="export-footnote" role="status">
            Checking decoder and encoder support…
          </p>
        )}
        {duplicateFilename && (
          <p className="batch-export-error" role="alert">
            Two requests resolve to “{duplicateFilename}”. Rename one before exporting.
          </p>
        )}

        {exporting && (
          <div className="batch-export-progress">
            <div className="batch-progress-heading">
              <strong aria-live="polite">{progress?.phase ?? "Preparing media"}</strong>
              <span>
                {progress?.percent ?? 0}% · {completed} of {requests.length} files ready
              </span>
            </div>
            <progress aria-label="Batch export progress" value={progress?.percent ?? 0} max={100} />
            {pendingDownload && (
              <div className="batch-download-ready" role="status">
                <span>
                  <strong>{pendingDownload.label}</strong> is ready. Download it to continue.
                </span>
                <button className="button export-button" onClick={onDownloadPending}>
                  <Download size={15} /> Download {pendingDownload.filename}
                </button>
              </div>
            )}
            <p className="export-footnote">
              Only one file is held for download at a time. The next request waits for your click.
            </p>
          </div>
        )}

        {pickerError && (
          <p className="batch-export-error" role="alert">
            {pickerError}
          </p>
        )}

        <div className="dialog-actions batch-export-actions">
          {exporting ? (
            <>
              <button
                className="button button-soft"
                onClick={runState?.paused ? onResume : onPause}
              >
                {runState?.paused ? <Play size={15} /> : <Pause size={15} />}
                {runState?.paused ? "Resume after pause" : "Pause after this file"}
              </button>
              <button className="button cancel-export" onClick={onCancel}>
                <X size={15} /> Stop batch
              </button>
              <button className="button button-soft" onClick={() => onOpenChange(false)}>
                Close
              </button>
            </>
          ) : (
            <>
              {onClear && requests.length > 0 && (
                <button className="button button-soft" onClick={onClear}>
                  <Trash2 size={15} /> Clear batch
                </button>
              )}
              {retryable && (
                <button className="button button-soft" onClick={onRetryPending}>
                  <RotateCcw size={15} /> Retry unfinished files
                </button>
              )}
              {canPickFolder && (
                <button
                  className="button button-soft"
                  onClick={pickFolderAndRun}
                  disabled={pickerBusy || !canRun}
                >
                  <FolderOpen size={15} />{" "}
                  {pickerBusy ? "Choosing folder…" : "Choose folder & export"}
                </button>
              )}
              {canPickFile && (
                <button
                  className="button button-soft"
                  onClick={pickFileAndRun}
                  disabled={pickerBusy || !canRun}
                >
                  <FolderOpen size={15} /> {pickerBusy ? "Choosing file…" : "Choose save location"}
                </button>
              )}
              <button
                className="button export-button"
                onClick={() => onRun()}
                disabled={!canRun || pickerBusy}
              >
                <Download size={16} /> Download one file at a time
              </button>
              <button className="button button-soft" onClick={() => onOpenChange(false)}>
                Close
              </button>
            </>
          )}
        </div>
        <p className="export-footnote">
          Export runs locally in this tab. Closing this dialog leaves the active run in progress.
        </p>
      </DialogContent>
    </Dialog>
  );
}
