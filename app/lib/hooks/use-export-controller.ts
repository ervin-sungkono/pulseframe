"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportDimensions } from "@/lib/export/export-settings";
import {
  createExportJobController,
  type ExportJobProgress,
  type ExportSource,
} from "@/lib/export/export-job";
import {
  getHistoricalProfileEstimate,
  getPreExportEstimate,
  LiveFrameEstimator,
  makeExportTimingProfileBase,
  makeExportWorkloadForExport,
  recordSuccessfulExport,
  type ExportTimingProfileBase,
  type RemainingEstimate,
  type TimeRange,
} from "@/lib/export/export-time-estimate";
import type { ExportDestination } from "@/lib/export/export-file-target";
import {
  getCachedExportCapabilities,
  probeExportCapabilities,
  type ExportCapabilityRequest,
  type ExportCodecCapabilities,
} from "@/lib/export/export-codec-capabilities";
import { exportAnalysisStart } from "@/lib/export/export-timeline";
import { formatTimestamp } from "@/lib/time";

export type UseExportControllerOptions = {
  /** Shared with the media/editor owner; this controller sets and releases it. */
  lockedRef: { current: boolean };
  /** Return null while a media load or replacement is in progress. */
  getSource: () => ExportSource | null;
  pausePlayback: () => void;
  onError?: (message: string) => void;
  onNotice?: (message: string) => void;
  onComplete?: () => void;
  /** Probe codecs only while the export dialog is open. */
  preflightEnabled?: boolean;
};

export type UseExportControllerResult = {
  exporting: boolean;
  progress: ExportJobProgress | null;
  estimateBeforeExport: TimeRange | null;
  capabilities: ExportCodecCapabilities | null;
  capabilityChecking: boolean;
  exportVideo: (destination?: ExportDestination) => Promise<void> | null;
  cancelExport: () => void;
};

type PickerRequest = {
  jobs: ReturnType<typeof createExportJobController>;
  lockedRef: { current: boolean };
  lockHeld: boolean;
};

type SavePicker = (options: {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<ExportDestination>;

function sourceProfileBase(source: ExportSource): ExportTimingProfileBase {
  const size = exportDimensions(source.format, source.resolution);
  const settings = source.settings;
  return makeExportTimingProfileBase({
    width: size.width,
    height: size.height,
    frameRate: source.frameRate,
    videoCompression: source.videoCompression,
    sourceKind: source.sourceKind,
    preparedAudio: !!source.prepared,
    workload: makeExportWorkloadForExport({
      durationSeconds: source.range[1] - source.range[0],
      analysisSeconds: Math.max(
        0,
        source.range[1] - exportAnalysisStart(source.range[0], settings),
      ),
      preparedAudio: !!source.prepared,
      settings,
      subtitles: source.subtitles.length > 0,
      logo: !!source.logo,
      background: !!source.background,
      videoOverlay: source.sourceKind === "video",
      reducedMotion: source.reducedMotion,
      instanceCount: source.instanceCount,
      compositionComplexity: source.compositionComplexity,
    }),
  });
}

function fileRemainingEstimate(
  range: TimeRange | null,
  elapsedMs: number | undefined,
): RemainingEstimate | undefined {
  if (!range || typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0)
    return undefined;
  const elapsed = elapsedMs / 1000;
  if (elapsed >= range.maxSeconds) return undefined;
  return {
    scope: "file",
    range: {
      minSeconds: Math.max(1, range.minSeconds - elapsed),
      maxSeconds: Math.max(1, range.maxSeconds - elapsed),
    },
  };
}

function snapshotSource(source: ExportSource): ExportSource {
  return {
    ...source,
    range: [source.range[0], source.range[1]],
    settings: structuredClone(source.settings),
    subtitles: structuredClone(source.subtitles),
    composition: source.composition ? structuredClone(source.composition) : undefined,
    images: source.images ? new Map(source.images) : undefined,
    // Prepared PCM and image objects are retained by reference for this job.
  };
}

function capabilityRequestFor(source: ExportSource): ExportCapabilityRequest | null {
  // Until preparation establishes the actual decoded audio shape, only the
  // buffered path can determine the exact audio encoder configuration.
  if (!source.prepared) return null;
  const size = exportDimensions(source.format, source.resolution);
  const audio = source.prepared.audio;
  return {
    width: size.width,
    height: size.height,
    frameRate: source.frameRate,
    videoCompression: source.videoCompression,
    ...(audio
      ? {
          audio: {
            numberOfChannels: audio.numberOfChannels,
            sampleRate: audio.sampleRate,
          },
        }
      : {}),
  };
}

function savePickerForWindow(): SavePicker | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker ?? null;
}

function suggestedFilename(source: ExportSource, extension: "mp4" | "webm") {
  const base = source.file.name.replace(/\.[^.]+$/, "");
  return `${base}-pulseframe-${Math.floor(source.range[0])}-${Math.ceil(source.range[1])}.${extension}`;
}

function pickerOptions(source: ExportSource, extension: "mp4" | "webm") {
  const mime = extension === "mp4" ? "video/mp4" : "video/webm";
  return {
    suggestedName: suggestedFilename(source, extension),
    types: [
      {
        description: `${extension.toUpperCase()} video`,
        accept: { [mime]: [`.${extension}`] },
      },
    ],
  };
}

function isPickerCancellation(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return () => URL.revokeObjectURL(url);
}

export function useExportController(
  options: UseExportControllerOptions,
): UseExportControllerResult {
  const optionsRef = useRef(options);
  const controllerRef = useRef<ReturnType<typeof createExportJobController> | null>(null);
  const pickerRequestRef = useRef<PickerRequest | null>(null);
  const mountedRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportJobProgress | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [capabilityResult, setCapabilityResult] = useState<{
    key: string;
    capabilities: ExportCodecCapabilities;
  } | null>(null);

  let estimateKey = "";
  try {
    const source = options.getSource();
    if (
      source &&
      source.sourceKind !== "video" &&
      source.range[1] > source.range[0] &&
      source.frameRate > 0
    ) {
      const base = sourceProfileBase(source);
      const frames = Math.ceil((source.range[1] - source.range[0]) * source.frameRate);
      estimateKey = JSON.stringify({
        generation: source.generation ?? null,
        base,
        frames,
        historyRevision,
      });
    }
  } catch {
    /* A transient media replacement has no estimate. */
  }
  const estimateBeforeExport = useMemo(() => {
    if (!estimateKey) return null;
    try {
      const { base, frames } = JSON.parse(estimateKey) as {
        base: ExportTimingProfileBase;
        frames: number;
      };
      return getPreExportEstimate(base, frames);
    } catch {
      return null;
    }
  }, [estimateKey]);

  let capabilityRequest: ExportCapabilityRequest | null = null;
  if (options.preflightEnabled) {
    try {
      const source = options.getSource();
      if (source) capabilityRequest = capabilityRequestFor(source);
    } catch {
      /* A transient media replacement has no exact source configuration. */
    }
  }
  const capabilityKey = capabilityRequest ? JSON.stringify(capabilityRequest) : "";
  const cachedCapabilities = capabilityRequest
    ? getCachedExportCapabilities(capabilityRequest)
    : null;
  const capabilities =
    cachedCapabilities ??
    (capabilityResult?.key === capabilityKey ? capabilityResult.capabilities : null);
  const capabilityChecking = Boolean(
    capabilityKey && !cachedCapabilities && capabilityResult?.key !== capabilityKey,
  );

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    if (!capabilityKey) return;
    const request = JSON.parse(capabilityKey) as ExportCapabilityRequest;
    let current = true;
    const cached = getCachedExportCapabilities(request);
    if (cached) return;
    void probeExportCapabilities(request).then((result) => {
      if (current) setCapabilityResult({ key: capabilityKey, capabilities: result });
    });
    return () => {
      current = false;
    };
  }, [capabilityKey]);

  useEffect(() => {
    mountedRef.current = true;
    const jobs = createExportJobController({
      lockedRef: optionsRef.current.lockedRef,
      pausePlayback: () => optionsRef.current.pausePlayback(),
      execute: async (source, signal, onProgress, startedAt) => {
        const { exportVisualVideo } = await import("@/lib/export/export-video");
        if (signal.aborted) throw new Error("Export canceled.");
        const size = exportDimensions(source.format, source.resolution);
        const baseProfile = sourceProfileBase(source);
        const preExportEstimate =
          source.sourceKind === "video"
            ? null
            : getPreExportEstimate(
                baseProfile,
                Math.ceil((source.range[1] - source.range[0]) * source.frameRate),
              );
        const frameEstimator = new LiveFrameEstimator();
        let exactHistory: ReturnType<typeof getHistoricalProfileEstimate> = null;
        let exactProfileKey = "";
        return exportVisualVideo({
          file: source.file,
          start: source.range[0],
          end: source.range[1],
          width: size.width,
          height: size.height,
          duration: source.duration,
          videoCompression: source.videoCompression,
          frameRate: source.frameRate,
          settings: source.settings,
          subtitles: source.subtitles,
          composition: source.composition,
          images: source.images,
          destination: source.destination,
          instanceCount: source.instanceCount,
          compositionComplexity: source.compositionComplexity,
          logo: source.logo,
          background: source.background,
          prepared: source.prepared,
          reducedMotion: source.reducedMotion,
          startedAt,
          signal,
          onProgress: (raw) => {
            let remainingEstimate: RemainingEstimate | undefined;
            if (raw.timingProfile) {
              const key = JSON.stringify(raw.timingProfile);
              if (key !== exactProfileKey) {
                exactProfileKey = key;
                exactHistory = getHistoricalProfileEstimate(
                  raw.timingProfile,
                  raw.totalFrames ?? 0,
                );
              }
            }
            if (raw.phase === "Preparing media") {
              remainingEstimate = fileRemainingEstimate(preExportEstimate, raw.elapsedMs);
            } else if (raw.phase === "Rendering frames") {
              if (raw.completedFrames !== undefined && raw.frameLoopElapsedMs !== undefined) {
                frameEstimator.observe(raw.completedFrames, raw.frameLoopElapsedMs);
                if (raw.totalFrames !== undefined) {
                  remainingEstimate =
                    frameEstimator.remaining(
                      raw.totalFrames,
                      raw.completedFrames,
                      exactHistory?.finalizationRange ?? null,
                    ) ?? undefined;
                }
              }
            } else if (raw.phase === "Finishing file") {
              remainingEstimate = fileRemainingEstimate(
                exactHistory?.finalizationRange ?? null,
                raw.phaseElapsedMs,
              );
            }
            onProgress({ ...raw, remainingEstimate });
          },
        });
      },
      download: (result, source) => {
        if (result.kind === "file") return;
        const base = source.file.name.replace(/\.[^.]+$/, "");
        const filename = `${base}-pulseframe-${Math.floor(source.range[0])}-${Math.ceil(source.range[1])}.${result.extension}`;
        return downloadBlob(result.blob, filename);
      },
      onStart: () => {
        optionsRef.current.onError?.("");
        optionsRef.current.onNotice?.("");
      },
      onState: (nextExporting, nextProgress) => {
        setExporting(nextExporting);
        setProgress(nextProgress);
      },
      onError: (message) => optionsRef.current.onError?.(message),
      onNotice: (message) => optionsRef.current.onNotice?.(message),
      onComplete: (result, source) => {
        if (result.timing && recordSuccessfulExport(result.timing))
          setHistoryRevision((revision) => revision + 1);
        const length = source.range[1] - source.range[0];
        const note = `Export complete: ${result.extension.toUpperCase()} video at ${source.resolution}p with ${formatTimestamp(length)} of media.${source.videoCompression ? " Video compression enabled." : ""}`;
        optionsRef.current.onNotice?.(note);
        optionsRef.current.onComplete?.();
      },
    });
    controllerRef.current = jobs;
    return () => {
      mountedRef.current = false;
      const pickerRequest = pickerRequestRef.current;
      if (pickerRequest?.jobs === jobs) {
        pickerRequestRef.current = null;
        if (pickerRequest.lockHeld) {
          pickerRequest.lockHeld = false;
          pickerRequest.lockedRef.current = false;
        }
      }
      if (controllerRef.current === jobs) controllerRef.current = null;
      jobs.dispose();
    };
  }, []);

  const exportVideo = useCallback((destination?: ExportDestination) => {
    const currentOptions = optionsRef.current;
    if (currentOptions.lockedRef.current) return null;
    try {
      const currentSource = currentOptions.getSource();
      if (!currentSource || !currentSource.file || !(currentSource.duration > 0)) return null;
      const source = snapshotSource(currentSource);
      const jobs = controllerRef.current;
      if (!jobs) return null;

      if (destination) return jobs.start({ ...source, destination });

      const request = capabilityRequestFor(source);
      const exactCapabilities = request ? getCachedExportCapabilities(request) : null;
      const picker = source.prepared ? savePickerForWindow() : null;
      if (!picker || !exactCapabilities?.supported) return jobs.start(source);

      const pickerRequest: PickerRequest = {
        jobs,
        lockedRef: currentOptions.lockedRef,
        lockHeld: true,
      };
      pickerRequestRef.current = pickerRequest;
      currentOptions.lockedRef.current = true;

      // Invoke the browser API in this click-handler stack so it retains the
      // user activation required by File System Access.
      let selection: Promise<ExportDestination>;
      try {
        selection = picker.call(
          typeof window === "undefined" ? undefined : window,
          pickerOptions(source, exactCapabilities.extension),
        );
      } catch (error) {
        pickerRequestRef.current = null;
        pickerRequest.lockHeld = false;
        pickerRequest.lockedRef.current = false;
        if (!isPickerCancellation(error))
          currentOptions.onError?.("Could not open the save dialog. Please try exporting again.");
        return null;
      }

      return selection.then(
        (selected) => {
          if (
            pickerRequestRef.current !== pickerRequest ||
            !mountedRef.current ||
            controllerRef.current !== jobs
          )
            return;

          let latestSource: ExportSource | null = null;
          try {
            latestSource = optionsRef.current.getSource();
          } catch {
            latestSource = null;
          }
          if (
            !latestSource ||
            (source.generation !== undefined && latestSource.generation !== source.generation)
          ) {
            pickerRequestRef.current = null;
            if (pickerRequest.lockHeld) {
              pickerRequest.lockHeld = false;
              pickerRequest.lockedRef.current = false;
            }
            return;
          }

          // The exact pre-picker snapshot owns this export. Release the picker
          // lock and start the job synchronously in the same continuation.
          pickerRequestRef.current = null;
          pickerRequest.lockHeld = false;
          pickerRequest.lockedRef.current = false;
          return jobs.start({ ...source, destination: selected }) ?? undefined;
        },
        (error: unknown) => {
          if (pickerRequestRef.current !== pickerRequest) return;
          pickerRequestRef.current = null;
          if (pickerRequest.lockHeld) {
            pickerRequest.lockHeld = false;
            pickerRequest.lockedRef.current = false;
          }
          if (!isPickerCancellation(error))
            optionsRef.current.onError?.(
              "Could not open the save dialog. Please try exporting again.",
            );
        },
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not export this file.";
      currentOptions.onError?.(message);
      return null;
    }
  }, []);

  const cancelExport = useCallback(() => controllerRef.current?.cancel(), []);
  return {
    exporting,
    progress,
    estimateBeforeExport,
    capabilities,
    capabilityChecking,
    exportVideo,
    cancelExport,
  };
}
