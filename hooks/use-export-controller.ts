"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportDimensions } from "@/lib/export-settings";
import { createExportJobController, type ExportJobProgress, type ExportSource } from "@/lib/export-job";
import {
  getHistoricalProfileEstimate, getPreExportEstimate, LiveFrameEstimator, makeExportTimingProfileBase,
  makeExportWorkloadForExport, recordSuccessfulExport, type ExportTimingProfileBase, type RemainingEstimate, type TimeRange,
} from "@/lib/export-time-estimate";

export type UseExportControllerOptions = {
  /** Shared with the media/editor owner; this controller sets and releases it. */
  lockedRef: { current: boolean };
  /** Return null while a media load or replacement is in progress. */
  getSource: () => ExportSource | null;
  pausePlayback: () => void;
  onError?: (message: string) => void;
  onNotice?: (message: string) => void;
  onComplete?: () => void;
};

export type UseExportControllerResult = {
  exporting: boolean;
  progress: ExportJobProgress | null;
  estimateBeforeExport: TimeRange | null;
  exportVideo: () => Promise<void> | null;
  cancelExport: () => void;
};

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
      analysisSeconds: Math.max(0, source.range[1] - Math.max(0, source.range[0] - 10)),
      preparedAudio: !!source.prepared,
      settings,
      subtitles: source.subtitles.length > 0,
      logo: !!source.logo,
      background: !!source.background,
      videoOverlay: source.sourceKind === "video",
      reducedMotion: source.reducedMotion,
    }),
  });
}

function fileRemainingEstimate(range: TimeRange | null, elapsedMs: number | undefined): RemainingEstimate | undefined {
  if (!range || typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
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
    subtitles: source.subtitles.map(cue => ({ id: cue.id, start: cue.start, end: cue.end, text: cue.text })),
    // Prepared PCM and image objects are retained by reference for this job.
  };
}

function timestamp(value: number) {
  const seconds = Math.max(0, Number.isFinite(value) ? value : 0);
  const minutes = Math.floor(seconds / 60);
  const rest = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${minutes}:${rest}`;
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

export function useExportController(options: UseExportControllerOptions): UseExportControllerResult {
  const optionsRef = useRef(options);
  const controllerRef = useRef<ReturnType<typeof createExportJobController> | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportJobProgress | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);

  let estimateKey = "";
  try {
    const source = options.getSource();
    if (source && source.sourceKind !== "video" && source.range[1] > source.range[0] && source.frameRate > 0) {
      const base = sourceProfileBase(source);
      const frames = Math.ceil((source.range[1] - source.range[0]) * source.frameRate);
      estimateKey = JSON.stringify({ generation: source.generation ?? null, base, frames, historyRevision });
    }
  } catch { /* A transient media replacement has no estimate. */ }
  const estimateBeforeExport = useMemo(() => {
    if (!estimateKey) return null;
    try {
      const { base, frames } = JSON.parse(estimateKey) as { base: ExportTimingProfileBase; frames: number };
      return getPreExportEstimate(base, frames);
    } catch { return null; }
  }, [estimateKey]);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const jobs = createExportJobController({
      lockedRef: optionsRef.current.lockedRef,
      pausePlayback: () => optionsRef.current.pausePlayback(),
      execute: async (source, signal, onProgress, startedAt) => {
        const { exportVisualVideo } = await import("@/lib/export-video");
        if (signal.aborted) throw new Error("Export canceled.");
        const size = exportDimensions(source.format, source.resolution);
        const baseProfile = sourceProfileBase(source);
        const preExportEstimate = source.sourceKind === "video" ? null
          : getPreExportEstimate(baseProfile, Math.ceil((source.range[1] - source.range[0]) * source.frameRate));
        const frameEstimator = new LiveFrameEstimator();
        let exactHistory: ReturnType<typeof getHistoricalProfileEstimate> = null;
        let exactProfileKey = "";
        return exportVisualVideo({
          file: source.file,
          start: source.range[0], end: source.range[1],
          width: size.width, height: size.height,
          duration: source.duration,
          videoCompression: source.videoCompression,
          frameRate: source.frameRate,
          settings: source.settings,
          subtitles: source.subtitles,
          logo: source.logo,
          background: source.background,
          prepared: source.prepared,
          reducedMotion: source.reducedMotion,
          startedAt,
          signal,
          onProgress: raw => {
            let remainingEstimate: RemainingEstimate | undefined;
            if (raw.timingProfile) {
              const key = JSON.stringify(raw.timingProfile);
              if (key !== exactProfileKey) {
                exactProfileKey = key;
                exactHistory = getHistoricalProfileEstimate(raw.timingProfile, raw.totalFrames ?? 0);
              }
            }
            if (raw.phase === "Preparing media") {
              remainingEstimate = fileRemainingEstimate(preExportEstimate, raw.elapsedMs);
            } else if (raw.phase === "Rendering frames") {
              if (raw.completedFrames !== undefined && raw.frameLoopElapsedMs !== undefined) {
                frameEstimator.observe(raw.completedFrames, raw.frameLoopElapsedMs);
                if (raw.totalFrames !== undefined) {
                  remainingEstimate = frameEstimator.remaining(
                    raw.totalFrames, raw.completedFrames, exactHistory?.finalizationRange ?? null,
                  ) ?? undefined;
                }
              }
            } else if (raw.phase === "Finishing file") {
              remainingEstimate = fileRemainingEstimate(exactHistory?.finalizationRange ?? null, raw.phaseElapsedMs);
            }
            onProgress({ ...raw, remainingEstimate });
          },
        });
      },
      download: (result, source) => {
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
      onError: message => optionsRef.current.onError?.(message),
      onNotice: message => optionsRef.current.onNotice?.(message),
      onComplete: (result, source) => {
        if (result.timing && recordSuccessfulExport(result.timing)) setHistoryRevision(revision => revision + 1);
        const length = source.range[1] - source.range[0];
        const note = `Export complete: ${result.extension.toUpperCase()} video at ${source.resolution}p with ${timestamp(length)} of media.${source.videoCompression ? " Video compression enabled." : ""}`;
        optionsRef.current.onNotice?.(note);
        optionsRef.current.onComplete?.();
      },
    });
    controllerRef.current = jobs;
    return () => {
      if (controllerRef.current === jobs) controllerRef.current = null;
      jobs.dispose();
    };
  }, []);

  const exportVideo = useCallback(() => {
    const currentOptions = optionsRef.current;
    if (currentOptions.lockedRef.current) return null;
    try {
      const currentSource = currentOptions.getSource();
      if (!currentSource || !currentSource.file || !(currentSource.duration > 0)) return null;
      const source = snapshotSource(currentSource);
      return controllerRef.current?.start(source) ?? null;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not export this file.";
      currentOptions.onError?.(message);
      return null;
    }
  }, []);

  const cancelExport = useCallback(() => controllerRef.current?.cancel(), []);
  return { exporting, progress, estimateBeforeExport, exportVideo, cancelExport };
}
