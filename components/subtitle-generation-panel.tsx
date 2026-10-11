"use client";

import { useEffect, useState } from "react";
import { Download, KeyRound, LoaderCircle, ShieldCheck, X } from "lucide-react";
import type { SubtitleGenerationController } from "@/hooks/use-subtitle-generation";
import { serializeGeneratedSubtitles } from "@/lib/lyrics/cues";
import type { GeneratedSubtitleFormat } from "@/lib/lyrics/cues";
import type { LyricsStage } from "@/lib/lyrics/types";

const stageLabels: Record<LyricsStage, string> = {
  prepare: "Prepare audio",
  download: "Load local models",
  isolate: "Isolate vocals",
  send: "Send audio",
  transcribe: "Transcribe lyrics",
  format: "Format subtitles",
};

function elapsedLabel(milliseconds: number) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function useVisibleElapsedTime(generation: SubtitleGenerationController) {
  const [elapsedMs, setElapsedMs] = useState(generation.elapsedMs);
  useEffect(() => {
    if (!generation.running || generation.startedAt === null) return;
    const startedAt = generation.startedAt;
    const update = () => setElapsedMs(Math.max(0, Date.now() - startedAt));
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [generation.running, generation.startedAt]);
  return generation.running ? elapsedMs : generation.elapsedMs;
}

function displaySize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.ceil(bytes / 1024)} KiB`;
}

function downloadResult(
  generation: SubtitleGenerationController,
  filename: string,
  format: GeneratedSubtitleFormat,
) {
  const snapshot = generation.result;
  if (!snapshot?.result.cues.length) return;
  const body = serializeGeneratedSubtitles(
    snapshot.result.cues,
    snapshot.result.durationMs,
    format,
  );
  const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filename.replace(/\.[^.]+$/, "")}-generated.${format}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function diagnosticSummary(result: NonNullable<SubtitleGenerationController["result"]>["result"]) {
  const items = [
    ["Vocal isolation", result.diagnostics.isolation === "none" ? "Not used" : "Used"],
    ["Isolation backend", result.diagnostics.isolationBackend],
    ["Transcription backend", result.diagnostics.whisperBackend],
    [
      "Graph capture",
      result.diagnostics.graphCapture === undefined
        ? undefined
        : result.diagnostics.graphCapture
          ? "used"
          : "not used",
    ],
    ["Requested CPU threads", result.diagnostics.requestedThreads?.toString()],
    ["Audio chunks", result.diagnostics.chunks.toString()],
    ["Attempts", result.diagnostics.attempts.toString()],
    ["Rechecks", result.diagnostics.rechecks.toString()],
    ...(result.diagnostics.tokenUsage
      ? [
          [
            "Provider tokens",
            `${result.diagnostics.tokenUsage.input} in / ${result.diagnostics.tokenUsage.output} out`,
          ],
        ]
      : []),
  ].filter((item): item is [string, string] => typeof item[1] === "string");
  const timings = Object.entries(result.diagnostics.timings).filter(
    ([, value]) => Number.isFinite(value) && value >= 0,
  );
  return { items, timings };
}

export function SubtitleGenerationPanel({
  generation,
  trackFile,
  disabled = false,
}: {
  generation: SubtitleGenerationController;
  trackFile?: File | null;
  disabled?: boolean;
}) {
  const elapsedMs = useVisibleElapsedTime(generation);
  const { items: diagnostics, timings } = generation.result
    ? diagnosticSummary(generation.result.result)
    : { items: [], timings: [] };
  const result = generation.result?.result ?? null;
  const busy = generation.running;
  const canEditOptions = !busy && !disabled;
  const canStart = generation.canGenerate && !disabled;
  const canRecover = generation.phase === "error" || (!!generation.result && !result?.cues.length);
  const canRetry = canRecover && generation.retryable;
  const baseName = trackFile?.name || "subtitles";

  return (
    <section className="subtitle-generation" aria-label="Generate subtitles">
      <div className="subtitle-generation-heading">
        <div>
          <strong>Generate subtitles</strong>
          <span>
            {trackFile
              ? `${trackFile.name} · ${displaySize(trackFile.size)} · full track`
              : "Transcribe the complete active track. Generated times stay on the source timeline."}
          </span>
        </div>
        <ShieldCheck size={18} aria-hidden="true" />
      </div>

      <fieldset className="subtitle-generation-method" disabled={!canEditOptions}>
        <legend>Method</legend>
        <label>
          <input
            type="radio"
            name="subtitle-generation-method"
            value="local"
            checked={generation.method === "local"}
            onChange={() => generation.setMethod("local")}
          />
          <span>On-device</span>
        </label>
        <label>
          <input
            type="radio"
            name="subtitle-generation-method"
            value="gemini"
            checked={generation.method === "gemini"}
            onChange={() => generation.setMethod("gemini")}
          />
          <span>Gemini API · cloud</span>
        </label>
      </fieldset>

      {generation.method === "local" ? (
        <p className="subtitle-generation-note">
          Audio stays on this device. Model files download the first time you generate.
        </p>
      ) : (
        <div className="subtitle-cloud-settings">
          <p className="subtitle-cloud-warning">
            Audio is sent to Google. API usage may incur charges. Only this track&apos;s audio is
            sent.
          </p>
          <label className="subtitle-api-key">
            <span>
              <KeyRound size={14} aria-hidden="true" /> Gemini API key
            </span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={generation.apiKey}
              onChange={(event) => generation.setApiKey(event.target.value)}
              disabled={!canEditOptions}
              aria-label="Gemini API key"
              placeholder="Enter your own key"
            />
          </label>
          <div className="subtitle-key-actions">
            <button
              type="button"
              className="button button-soft"
              onClick={generation.disconnectGemini}
              disabled={!generation.apiKey && !generation.cloudConsent}
            >
              <X size={14} /> Disconnect
            </button>
            <span role="status">
              {generation.apiKey
                ? "Key entered · request not yet verified"
                : "No session key entered"}
            </span>
          </div>
          <small className="subtitle-server-key-status" aria-label="Server key availability">
            {generation.serverKeyAvailabilityLoading
              ? "Checking server-key availability…"
              : generation.serverKeyAvailable
                ? "A server key is available."
                : "No server key is available."}
          </small>
          <label className="subtitle-cloud-consent">
            <input
              type="checkbox"
              checked={generation.cloudConsent}
              onChange={(event) => generation.acknowledgeCloudUpload(event.target.checked)}
              disabled={!trackFile || !canEditOptions}
            />
            <span>I agree to send this track&apos;s audio to Google for transcription.</span>
          </label>
        </div>
      )}

      <fieldset className="subtitle-generation-presets" disabled={!canEditOptions}>
        <legend>Processing</legend>
        {(["auto", "fast", "quality"] as const).map((option) => (
          <label key={option}>
            <input
              type="radio"
              name="subtitle-generation-preset"
              value={option}
              checked={generation.preset === option}
              onChange={() => generation.setPreset(option)}
            />
            <span>{option === "auto" ? "Auto" : option === "fast" ? "Fast" : "Quality"}</span>
          </label>
        ))}
      </fieldset>
      <p className="subtitle-generation-note">
        {generation.method === "local"
          ? generation.preset === "quality"
            ? "Quality uses vocal isolation and a larger local model. It can take substantially longer on devices without WebGPU and needs more memory."
            : generation.preset === "fast"
              ? "Fast transcribes the original mix without vocal isolation."
              : "Auto chooses a local processing path based on this device."
          : generation.preset === "quality"
            ? "Quality may recheck uncertain lines with up to three extra requests, which can add API cost."
            : generation.preset === "fast"
              ? "Fast uses one transcription pass for each audio chunk."
              : "Auto prepares bounded audio chunks and uses one pass per chunk."}
      </p>

      {generation.validationError && (
        <p className="subtitle-generation-error" role="status">
          {generation.validationError}
        </p>
      )}
      {disabled && !busy && (
        <p className="subtitle-generation-note" role="status">
          Generation is unavailable while video export is running.
        </p>
      )}

      <div className="subtitle-generation-actions">
        {busy ? (
          <button
            type="button"
            className="button button-soft"
            onClick={generation.cancel}
            disabled={generation.cancelRequested}
          >
            {generation.cancelRequested ? (
              <LoaderCircle size={15} className="subtitle-spinner" />
            ) : (
              <X size={15} />
            )}
            {generation.cancelRequested ? "Canceling…" : "Cancel generation"}
          </button>
        ) : (
          <button
            type="button"
            className="button button-soft"
            onClick={() => void generation.generate()}
            disabled={!canStart}
          >
            Generate subtitles
          </button>
        )}
        {canRetry && !busy && (
          <button
            type="button"
            className="button button-soft"
            onClick={() => void generation.retry()}
            disabled={disabled}
          >
            Retry
          </button>
        )}
        {canRecover && generation.method === "local" && generation.preset !== "fast" && !busy && (
          <button
            type="button"
            className="button button-soft"
            onClick={() => void generation.useFast()}
            disabled={disabled}
          >
            Use Fast
          </button>
        )}
        {canRecover && generation.method === "gemini" && !busy && (
          <button
            type="button"
            className="button button-soft"
            onClick={() => generation.setMethod("local")}
            disabled={disabled}
          >
            Use On-device
          </button>
        )}
      </div>

      {generation.progress && (busy || generation.phase === "complete") && (
        <div
          className="subtitle-generation-progress"
          role="status"
          aria-live="polite"
          aria-busy={busy}
        >
          <div>
            <strong>{stageLabels[generation.progress.stage]}</strong>
            <span>
              {elapsedLabel(busy ? elapsedMs : (generation.progress.elapsedMs ?? elapsedMs))}
            </span>
          </div>
          <p>
            {generation.cancelRequested
              ? "Canceling… Waiting for processing to stop."
              : generation.progress.message}
          </p>
          {generation.method === "local" &&
            generation.progress.completed !== undefined &&
            generation.progress.total !== undefined &&
            generation.progress.total > 0 && (
              <div
                className="subtitle-generation-work"
                aria-label={`${generation.progress.completed} of ${generation.progress.total} processing units complete`}
              >
                <span>
                  {generation.progress.completed} of {generation.progress.total}
                </span>
                <progress value={generation.progress.completed} max={generation.progress.total} />
              </div>
            )}
        </div>
      )}
      {generation.error && (
        <p className="subtitle-generation-error" role="alert">
          {generation.error}
        </p>
      )}
      {generation.notice && (
        <p className="subtitle-generation-result-note" role="status">
          {generation.notice}
        </p>
      )}

      {result && (
        <section className="subtitle-generated-result" aria-label="Generated subtitles">
          <div className="subtitle-generated-result-heading">
            <div>
              <strong>
                {result.cues.length
                  ? `${result.cues.length} generated ${result.cues.length === 1 ? "line" : "lines"}`
                  : "No lyrics detected"}
              </strong>
              <span>
                {result.method === "local" ? "On-device" : "Gemini-generated; timing is estimated"}{" "}
                · {elapsedLabel(elapsedMs)}
              </span>
            </div>
            <Download size={16} aria-hidden="true" />
          </div>
          {generation.applicationError && (
            <p className="subtitle-generation-error" role="status">
              {generation.applicationError}
            </p>
          )}
          {generation.needsReplacement && (
            <div
              className="subtitle-replacement-prompt"
              role="group"
              aria-label="Replace existing subtitles?"
            >
              <strong>Replace existing subtitles?</strong>
              <span>The current cues remain until you choose to replace them.</span>
              <div>
                <button
                  type="button"
                  className="button button-soft"
                  onClick={generation.applyGenerated}
                  disabled={busy || disabled}
                >
                  Replace existing subtitles
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={generation.keepExisting}
                  disabled={busy || disabled}
                >
                  Keep existing
                </button>
              </div>
            </div>
          )}
          {result.cues.length > 0 && (
            <div
              className="subtitle-generated-downloads"
              aria-label="Download generated subtitle files"
            >
              {(["srt", "vtt", "lrc", "json"] as const).map((format) => (
                <button
                  type="button"
                  className="button button-soft"
                  key={format}
                  onClick={() => downloadResult(generation, baseName, format)}
                  disabled={busy || disabled}
                >
                  <Download size={13} /> {format.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          {result.notices.map((message, index) => (
            <p className="subtitle-generation-note" key={`${index}-${message}`}>
              {message}
            </p>
          ))}
          {(diagnostics.length > 0 || timings.length > 0) && (
            <details className="subtitle-generation-diagnostics">
              <summary>Processing details</summary>
              <dl>
                {diagnostics.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
                {timings.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value.toFixed(0)} ms</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </section>
      )}
      <p className="subtitle-generated-attribution">
        Machine-generated lyrics; wording and timing may be inaccurate.
      </p>
      {generation.apiKey && generation.method === "gemini" && (
        <p className="subtitle-key-memory-hint">
          Your key stays in this browser session. Disconnect or reload to clear it.
        </p>
      )}
    </section>
  );
}

/** Compact root-level status can remain visible while the modal is closed. */
export function SubtitleGenerationStatus({
  generation,
  onOpen,
}: {
  generation: SubtitleGenerationController;
  onOpen: () => void;
}) {
  const elapsedMs = useVisibleElapsedTime(generation);
  if (!generation.running) return null;
  const message = generation.progress?.message || "Preparing subtitle generation…";
  return (
    <button
      type="button"
      className="subtitle-generation-status"
      onClick={onOpen}
      aria-label={`Subtitle generation in progress. ${message} Open subtitles.`}
    >
      <LoaderCircle size={15} className="subtitle-spinner" />
      <span>Subtitles · {stageLabels[generation.progress?.stage ?? "prepare"]}</span>
      <time>{elapsedLabel(elapsedMs)}</time>
    </button>
  );
}
