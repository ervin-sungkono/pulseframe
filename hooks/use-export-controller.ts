"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportDimensions } from "@/lib/export-settings";
import {
  createExportJobController,
  type ExportJobOutput,
  type ExportJobProgress,
  type ExportRunOptions,
  type ExportSource,
} from "@/lib/export-job";
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
} from "@/lib/export-time-estimate";
import { type ExportPreflightRequest, type ExportPreflightResult } from "@/lib/export-preflight";
import {
  createExportRequest,
  snapshotExportSource,
  snapshotExportRequests,
  validateUniqueExportFilenames,
  type ExportRequest,
  type ExportRunState,
} from "@/lib/export-request";
import type { ProjectTrack } from "@/lib/project-model";
import type { ExportDestination } from "@/lib/export-destination";
import { buildPlaylistTimeline, clipProjectRange } from "@/lib/playlist-timeline";

const EXPORT_TIMING_SAMPLE_RATE = 48_000;

function sourceTimingDetails(source: ExportSource, preflight?: ExportPreflightResult | null) {
  if (!source.tracks?.length)
    return {
      tracks: null as ProjectTrack[] | null,
      durationSeconds: source.range[1] - source.range[0],
      analysisSeconds: Math.max(0, source.range[1] - Math.max(0, source.range[0] - 10)),
    };

  const clips = clipProjectRange(buildPlaylistTimeline(source.tracks), source.range);
  const selectedIds = preflight?.segments
    .map((segment) => segment.trackId)
    .filter((id): id is string => !!id);
  const selectedTracks = selectedIds
    ? source.tracks.filter((track) => selectedIds.includes(track.id))
    : clips.map((clip) => clip.track);
  const durationSeconds = preflight?.segments.length
    ? preflight.segments.reduce(
        (samples, segment) =>
          samples +
          Math.max(
            1,
            Math.round((segment.sourceEnd - segment.sourceStart) * EXPORT_TIMING_SAMPLE_RATE),
          ),
        0,
      ) / EXPORT_TIMING_SAMPLE_RATE
    : clips.reduce((seconds, clip) => seconds + clip.projectRange[1] - clip.projectRange[0], 0);
  const analysisSeconds = preflight?.segments.length
    ? preflight.segments.reduce(
        (seconds, segment) => seconds + segment.sourceEnd - Math.max(0, segment.sourceStart - 10),
        0,
      )
    : clips.reduce(
        (seconds, clip) => seconds + clip.sourceRange[1] - Math.max(0, clip.sourceRange[0] - 10),
        0,
      );
  return { tracks: selectedTracks, durationSeconds, analysisSeconds };
}

export type PendingExportDownload = {
  requestId: string;
  label: string;
  filename: string;
  kind: ExportRequest["kind"];
  blob: Blob;
  extension: ExportJobOutput["extension"];
};

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
  runState: ExportRunState | null;
  pendingDownload: PendingExportDownload | null;
  estimateBeforeExport: TimeRange | null;
  exportVideo: () => Promise<void> | null;
  exportVideoToFile: (destination: ExportDestination) => Promise<void> | null;
  runRequests: (
    requests: readonly ExportRequest[],
    options?: ExportRunOptions,
  ) => Promise<void> | null;
  retryPending: (requests?: readonly ExportRequest[]) => Promise<void> | null;
  pauseExport: () => void;
  resumeExport: () => void;
  downloadPending: () => boolean;
  cancelExport: () => void;
  preflightRequests: (
    requests: readonly ExportRequest[],
  ) => Promise<Map<string, ExportPreflightResult | null>>;
  preflightSource: (source: ExportSource) => Promise<ExportPreflightResult>;
};

function sourceProfileBase(
  source: ExportSource,
  fileDestination = false,
  preflight?: ExportPreflightResult | null,
): ExportTimingProfileBase {
  const size = exportDimensions(source.format, source.resolution);
  const settings = source.settings;
  const timing = sourceTimingDetails(source, preflight);
  const isPlaylist = !!source.tracks?.length;
  const hasVideo = preflight?.segments.length
    ? preflight.segments.some((segment) => segment.hasVideo)
    : (timing.tracks?.some((track) => track.file.type.startsWith("video/")) ??
      source.sourceKind === "video");
  return makeExportTimingProfileBase({
    width: size.width,
    height: size.height,
    frameRate: source.frameRate,
    videoCompression: source.videoCompression,
    sourceKind: hasVideo ? "video" : "audio",
    preparedAudio: isPlaylist ? false : !!source.prepared,
    workload: makeExportWorkloadForExport({
      durationSeconds: timing.durationSeconds,
      analysisSeconds: timing.analysisSeconds,
      preparedAudio: isPlaylist ? false : !!source.prepared,
      settings,
      subtitles: isPlaylist
        ? !!timing.tracks?.some((track) => track.subtitles.length)
        : source.subtitles.length > 0,
      logo: !!source.logo || !!source.logoFile,
      background: !!source.background || !!source.backgroundFile,
      artwork:
        !!source.artwork ||
        !!source.artworkFile ||
        !!source.snapshot?.artwork ||
        !!timing.tracks?.some((track) => track.artwork),
      videoOverlay: hasVideo,
      reducedMotion: source.reducedMotion,
    }),
    destination: fileDestination ? "file" : "buffer",
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

function preflightRequestFor(source: ExportSource): ExportPreflightRequest {
  const size = exportDimensions(source.format, source.resolution);
  return {
    ...(source.tracks?.length ? { tracks: source.tracks } : { file: source.file }),
    range: [source.range[0], source.range[1]],
    width: size.width,
    height: size.height,
    frameRate: source.frameRate,
    videoCompression: source.videoCompression,
    generation: source.generation,
  };
}

function sourcePreflightKey(source: ExportSource) {
  return JSON.stringify({
    generation: source.generation ?? null,
    file: [source.file.name, source.file.size, source.file.lastModified, source.file.type],
    range: source.range,
    format: source.format,
    resolution: source.resolution,
    frameRate: source.frameRate,
    videoCompression: source.videoCompression,
    tracks:
      source.tracks?.map((track) => [
        track.id,
        track.file.name,
        track.file.size,
        track.file.lastModified,
        track.file.type,
        track.range,
      ]) ?? null,
  });
}

export async function renderStillRequest(
  request: ExportRequest,
  signal: AbortSignal,
): Promise<Blob> {
  const { renderStillFrame } = await import("@/lib/render-still");
  const source = request.source;
  const selectedTime = request.stillTime ?? source.range[0];
  let file = source.file;
  let time = selectedTime;
  let duration = source.duration;
  let track: ProjectTrack | null = null;
  if (source.tracks?.length) {
    const { buildPlaylistTimeline, resolveProjectTime } = await import("@/lib/playlist-timeline");
    const target = resolveProjectTime(buildPlaylistTimeline(source.tracks), selectedTime);
    if (!target) throw new Error("The thumbnail time is outside the project timeline.");
    track = target.segment.track;
    file = track.file;
    time = target.sourceTime;
    duration = track.duration;
  }

  let temporaryOwner: import("@/lib/media-session").MediaSessionOwner | null = null;
  let snapshot = source.snapshot?.file === file ? source.snapshot : null;
  if (!snapshot) {
    const { MediaSessionOwner } = await import("@/lib/media-session");
    temporaryOwner = new MediaSessionOwner({ getMediaHost: () => null, isBlocked: () => false });
    const cancelTemporaryOwner = () => temporaryOwner?.dispose();
    signal.addEventListener("abort", cancelTemporaryOwner, { once: true });
    try {
      const ready = await temporaryOwner.load(file, {
        range: [0, duration],
        projectAssets: {
          logo: source.logoFile ?? null,
          background: source.backgroundFile ?? null,
          artwork: track?.artwork ?? source.artworkFile ?? null,
        },
      });
      if (!ready || signal.aborted) throw new DOMException("Export canceled.", "AbortError");
      snapshot = temporaryOwner.snapshot;
      if (!snapshot) throw new Error("The thumbnail preview could not be prepared.");

      const size = exportDimensions(source.format, source.resolution);
      const settings = track
        ? (await import("@/lib/project-model")).resolveTrackMetadata(source.settings, track)
        : source.settings;
      const subtitles = track?.subtitles ?? source.subtitles;
      if (signal.aborted) throw new DOMException("Export canceled.", "AbortError");
      return await renderStillFrame({
        snapshot,
        settings,
        subtitles,
        aspect: source.format,
        time,
        width: size.width,
        height: size.height,
        signal,
      });
    } finally {
      signal.removeEventListener("abort", cancelTemporaryOwner);
      temporaryOwner.dispose();
    }
  }
  if (!snapshot) throw new Error("The thumbnail preview could not be prepared.");
  if (signal.aborted) throw new DOMException("Export canceled.", "AbortError");
  const size = exportDimensions(source.format, source.resolution);
  const settings = track
    ? (await import("@/lib/project-model")).resolveTrackMetadata(source.settings, track)
    : source.settings;
  const subtitles = track?.subtitles ?? source.subtitles;
  return renderStillFrame({
    snapshot,
    settings,
    subtitles,
    aspect: source.format,
    time,
    width: size.width,
    height: size.height,
    signal,
  });
}

export function useExportController(
  options: UseExportControllerOptions,
): UseExportControllerResult {
  const optionsRef = useRef(options);
  const controllerRef = useRef<ReturnType<typeof createExportJobController> | null>(null);
  const pendingDownloadRef = useRef<PendingExportDownload | null>(null);
  const directFileExportRef = useRef(false);
  const preflightCacheRef = useRef(new Map<string, ExportPreflightResult | null>());
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportJobProgress | null>(null);
  const [runState, setRunState] = useState<ExportRunState | null>(null);
  const [pendingDownload, setPendingDownload] = useState<PendingExportDownload | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [sourcePreflightResults, setSourcePreflightResults] = useState(
    () => new Map<string, ExportPreflightResult>(),
  );

  let estimateKey = "";
  try {
    const source = options.getSource();
    if (source && source.range[1] > source.range[0] && source.frameRate > 0) {
      const cachedPreflight = sourcePreflightResults.get(sourcePreflightKey(source));
      const base = sourceProfileBase(source, false, cachedPreflight);
      const frames = Math.ceil(
        sourceTimingDetails(source, cachedPreflight).durationSeconds * source.frameRate,
      );
      if (base.sourceKind !== "video") {
        estimateKey = JSON.stringify({
          generation: source.generation ?? null,
          base,
          frames,
          historyRevision,
        });
      }
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

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const downloadPending = useCallback(() => {
    const pending = pendingDownloadRef.current;
    if (!pending) return false;
    try {
      const revoke = downloadBlob(pending.blob, pending.filename);
      pendingDownloadRef.current = null;
      setPendingDownload(null);
      controllerRef.current?.continueOutput(revoke);
      return true;
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "The file could not be downloaded.";
      optionsRef.current.onError?.(message);
      return false;
    }
  }, []);

  useEffect(() => {
    const executeVideo = async (
      request: ExportRequest,
      source: ExportSource,
      signal: AbortSignal,
      onProgress: (progress: ExportJobProgress) => void,
      startedAt: number,
      runOptions: ExportRunOptions,
    ): Promise<ExportJobOutput> => {
      const { exportVisualVideo } = await import("@/lib/export-video");
      const { getCachedExportPreflight, preflightExport } = await import("@/lib/export-preflight");
      if (signal.aborted) throw new DOMException("Export canceled.", "AbortError");
      const size = exportDimensions(source.format, source.resolution);
      const preflightRequest = preflightRequestFor(source);
      const preflight =
        getCachedExportPreflight(preflightRequest) ?? (await preflightExport(preflightRequest));
      const baseProfile = sourceProfileBase(source, !!runOptions.destination, preflight);
      const preExportEstimate =
        baseProfile.sourceKind === "video"
          ? null
          : getPreExportEstimate(
              baseProfile,
              Math.ceil(sourceTimingDetails(source, preflight).durationSeconds * source.frameRate),
            );
      const frameEstimator = new LiveFrameEstimator();
      let exactHistory: ReturnType<typeof getHistoricalProfileEstimate> = null;
      let exactProfileKey = "";
      const temporaryImages: Array<{ url: string }> = [];
      let logo = source.logo;
      let background = source.background;
      let artwork = source.artwork;
      try {
        if (!runOptions.keepRuntime) {
          const { readLocalImage } = await import("@/lib/local-image");
          const imageInputs = [
            ...(source.logoFile ? [{ kind: "logo" as const, file: source.logoFile }] : []),
            ...(source.backgroundFile
              ? [{ kind: "background" as const, file: source.backgroundFile }]
              : []),
            ...(source.artworkFile ? [{ kind: "artwork" as const, file: source.artworkFile }] : []),
          ];
          const loaded = await Promise.allSettled(
            imageInputs.map(({ kind, file }) => readLocalImage(file, kind)),
          );
          const imagesByKind = new Map<string, HTMLImageElement>();
          let loadError: unknown = null;
          loaded.forEach((result, index) => {
            if (result.status === "fulfilled") {
              temporaryImages.push(result.value);
              imagesByKind.set(imageInputs[index].kind, result.value.image);
            } else if (loadError === null) {
              loadError = result.reason;
            }
          });
          if (loadError) throw loadError;
          if (signal.aborted) throw new DOMException("Export canceled.", "AbortError");
          logo = imagesByKind.get("logo") ?? null;
          background = imagesByKind.get("background") ?? null;
          artwork = imagesByKind.get("artwork") ?? null;
        }
        return await exportVisualVideo({
          file: source.file,
          tracks: source.tracks,
          destination: runOptions.destination,
          filename: `${request.filename}.${preflight.extension}`,
          start: source.range[0],
          end: source.range[1],
          width: size.width,
          height: size.height,
          duration: source.duration,
          videoCompression: source.videoCompression,
          frameRate: source.frameRate,
          settings: source.settings,
          subtitles: source.subtitles,
          logo,
          background,
          artwork,
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
      } finally {
        for (const image of temporaryImages) URL.revokeObjectURL(image.url);
      }
    };

    const jobs = createExportJobController({
      lockedRef: optionsRef.current.lockedRef,
      pausePlayback: () => optionsRef.current.pausePlayback(),
      execute: (source, signal, onProgress, startedAt) =>
        executeVideo(
          {
            id: "single-export",
            label: "Video export",
            filename: source.file.name.replace(/\.[^.]+$/, ""),
            kind: "video",
            source,
          },
          source,
          signal,
          onProgress,
          startedAt,
          { keepRuntime: true },
        ),
      executeRequest: async (request, signal, onProgress, startedAt, runOptions) => {
        if (request.kind === "still") {
          const blob = await renderStillRequest(request, signal);
          if (signal.aborted) throw new DOMException("Export canceled.", "AbortError");
          if (runOptions.destination) {
            const transaction = await runOptions.destination.createWriter(
              "png",
              `${request.filename}.png`,
            );
            try {
              const writer = transaction.stream.getWriter();
              await writer.write({
                type: "write",
                data: new Uint8Array(await blob.arrayBuffer()),
                position: 0,
              });
              await writer.close();
              if (signal.aborted) throw new DOMException("Export canceled.", "AbortError");
              await transaction.commit();
              return { saved: true, extension: "png" };
            } catch (error) {
              await transaction.abort(error).catch(() => {});
              throw error;
            }
          }
          return { blob, extension: "png" };
        }
        return executeVideo(request, request.source, signal, onProgress, startedAt, runOptions);
      },
      download: (result, source) => {
        if (!result.blob) return;
        const base = source.file.name.replace(/\.[^.]+$/, "");
        const filename = `${base}-pulseframe-${Math.floor(source.range[0])}-${Math.ceil(source.range[1])}.${result.extension}`;
        return downloadBlob(result.blob, filename);
      },
      onOutputReady: (result, request) => {
        if (!result.blob) return;
        const output = {
          requestId: request.id,
          label: request.label,
          filename: `${request.filename}.${result.extension}`,
          kind: request.kind,
          blob: result.blob,
          extension: result.extension,
        } satisfies PendingExportDownload;
        pendingDownloadRef.current = output;
        setPendingDownload(output);
      },
      onStart: () => {
        optionsRef.current.onError?.("");
        optionsRef.current.onNotice?.("");
      },
      onState: (nextExporting, nextProgress, nextRun) => {
        setExporting(nextExporting);
        setProgress(nextProgress);
        if (nextRun) setRunState(nextRun);
        if (!nextExporting) {
          pendingDownloadRef.current = null;
          setPendingDownload(null);
        }
      },
      onError: (message) => optionsRef.current.onError?.(message),
      onNotice: (message) => optionsRef.current.onNotice?.(message),
      onComplete: (result, source) => {
        const length = source.range[1] - source.range[0];
        const note = result.saved
          ? `Export complete: saved ${result.extension.toUpperCase()} video at ${source.resolution}p with ${timestamp(length)} of media.`
          : `Export complete: ${result.extension.toUpperCase()} video at ${source.resolution}p with ${timestamp(length)} of media.${source.videoCompression ? " Video compression enabled." : ""}`;
        optionsRef.current.onNotice?.(note);
        optionsRef.current.onComplete?.();
      },
      onRequestComplete: (result, request) => {
        if (result.timing && recordSuccessfulExport(result.timing))
          setHistoryRevision((revision) => revision + 1);
        if (directFileExportRef.current && result.saved) {
          const source = request.source;
          const length = source.range[1] - source.range[0];
          optionsRef.current.onNotice?.(
            `Export complete: saved ${result.extension.toUpperCase()} video at ${source.resolution}p with ${timestamp(length)} of media.`,
          );
          optionsRef.current.onComplete?.();
        }
      },
    });
    controllerRef.current = jobs;
    return () => {
      if (controllerRef.current === jobs) controllerRef.current = null;
      pendingDownloadRef.current = null;
      jobs.dispose();
    };
  }, []);

  const exportVideo = useCallback(() => {
    const currentOptions = optionsRef.current;
    if (currentOptions.lockedRef.current) return null;
    try {
      const currentSource = currentOptions.getSource();
      if (!currentSource || !currentSource.file || !(currentSource.duration > 0)) return null;
      return controllerRef.current?.start(snapshotExportSource(currentSource)) ?? null;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not export this file.";
      currentOptions.onError?.(message);
      return null;
    }
  }, []);

  const exportVideoToFile = useCallback((destination: ExportDestination) => {
    const currentOptions = optionsRef.current;
    if (currentOptions.lockedRef.current) return null;
    try {
      const currentSource = currentOptions.getSource();
      if (!currentSource || !currentSource.file || !(currentSource.duration > 0)) return null;
      const source = snapshotExportSource(currentSource);
      const request = createExportRequest(source, {
        id: `single-file-${Date.now().toString(36)}`,
        label: "Video export",
        filename: `${source.file.name.replace(/\.[^.]+$/, "")}-pulseframe-${Math.floor(source.range[0])}-${Math.ceil(source.range[1])}`,
        kind: "video",
      });
      const task =
        controllerRef.current?.runRequests([request], { destination, keepRuntime: true }) ?? null;
      if (!task) return null;
      directFileExportRef.current = true;
      return task.finally(() => {
        directFileExportRef.current = false;
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not export this file.";
      currentOptions.onError?.(message);
      return null;
    }
  }, []);

  const runRequests = useCallback(
    (requests: readonly ExportRequest[], runOptions: ExportRunOptions = {}) => {
      try {
        const extensions = new Map<string, "mp4" | "webm" | "png">();
        for (const request of requests) {
          const extension =
            request.kind === "still" ? "png" : preflightCacheRef.current.get(request.id)?.extension;
          if (extension) extensions.set(request.id, extension);
        }
        const allChecked = requests.every(
          (request) => request.kind === "still" || extensions.has(request.id),
        );
        if (runOptions.destination || allChecked)
          validateUniqueExportFilenames(requests, extensions);
        return controllerRef.current?.runRequests(requests, runOptions) ?? null;
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : "Could not start the export batch.";
        optionsRef.current.onError?.(message);
        return null;
      }
    },
    [],
  );

  const retryPending = useCallback(
    (requests?: readonly ExportRequest[]) => controllerRef.current?.retryPending(requests) ?? null,
    [],
  );
  const pauseExport = useCallback(() => controllerRef.current?.pause(), []);
  const resumeExport = useCallback(() => controllerRef.current?.resume(), []);
  const cancelExport = useCallback(() => controllerRef.current?.cancel(), []);

  const preflightRequests = useCallback(async (requests: readonly ExportRequest[]) => {
    const snapshot = snapshotExportRequests(requests);
    const { getCachedExportPreflight, preflightExport } = await import("@/lib/export-preflight");
    const entries = await Promise.all(
      snapshot.map(async (request): Promise<[string, ExportPreflightResult | null]> => {
        if (request.kind === "still") {
          preflightCacheRef.current.set(request.id, null);
          return [request.id, null];
        }
        const preflightRequest = preflightRequestFor(request.source);
        const result =
          getCachedExportPreflight(preflightRequest) ?? (await preflightExport(preflightRequest));
        preflightCacheRef.current.set(request.id, result);
        return [request.id, result];
      }),
    );
    const result = new Map(entries);
    setSourcePreflightResults((previous) => {
      const next = new Map(previous);
      for (const [id, profile] of entries) {
        if (!profile) continue;
        const request = snapshot.find((candidate) => candidate.id === id);
        if (request) next.set(sourcePreflightKey(request.source), profile);
      }
      while (next.size > 50) next.delete(next.keys().next().value!);
      return next;
    });
    validateUniqueExportFilenames(
      snapshot,
      new Map(
        entries.flatMap(([id, profile]) => (profile ? [[id, profile.extension] as const] : [])),
      ),
    );
    return result;
  }, []);

  const preflightSource = useCallback(async (source: ExportSource) => {
    const { getCachedExportPreflight, preflightExport } = await import("@/lib/export-preflight");
    const request = preflightRequestFor(source);
    const result = getCachedExportPreflight(request) ?? (await preflightExport(request));
    const key = sourcePreflightKey(source);
    setSourcePreflightResults((previous) => {
      const next = new Map(previous);
      next.set(key, result);
      while (next.size > 50) next.delete(next.keys().next().value!);
      return next;
    });
    return result;
  }, []);

  const estimateBeforeExportForSource = estimateBeforeExport;
  return {
    exporting,
    progress,
    runState,
    pendingDownload,
    estimateBeforeExport: estimateBeforeExportForSource,
    exportVideo,
    exportVideoToFile,
    runRequests,
    retryPending,
    pauseExport,
    resumeExport,
    downloadPending,
    cancelExport,
    preflightRequests,
    preflightSource,
  };
}
