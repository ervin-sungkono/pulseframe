import type { ExportDestination } from "./export-file-target";
import type { PreparedSound } from "../audio/audio-features";
import type { ExportAspect, ExportFrameRate, ExportResolution } from "./export-settings";
import type { ExportProgress } from "./export-video";
import type { SubtitleCue } from "../subtitles/model";
import type { VisualSettings } from "../visual/visual-settings-model";
import type { LogoLayer } from "../visual/visualizer";
import type { ExportSourceKind, ExportTimingMeasurement } from "./export-time-estimate";

export type ExportSource = {
  file: File;
  /** Non-persisted media-session generation and source kind for profile scoping. */
  generation?: number;
  sourceKind: ExportSourceKind;
  duration: number;
  range: [number, number];
  format: ExportAspect;
  resolution: ExportResolution;
  frameRate: ExportFrameRate;
  videoCompression: boolean;
  settings: VisualSettings;
  subtitles: SubtitleCue[];
  destination?: ExportDestination;
  logo: LogoLayer | null;
  background: LogoLayer | null;
  prepared?: PreparedSound;
  reducedMotion: boolean;
};

export type ExportJobProgress = ExportProgress;
export type ExportJobOutput =
  | {
      kind?: "buffer";
      blob: Blob;
      extension: "mp4" | "webm";
      timing?: ExportTimingMeasurement;
    }
  | { kind: "file"; extension: "mp4" | "webm"; timing?: ExportTimingMeasurement };

type ExportJobOptions = {
  lockedRef: { current: boolean };
  pausePlayback: () => void;
  execute: (
    source: ExportSource,
    signal: AbortSignal,
    onProgress: (progress: ExportJobProgress) => void,
    startedAt: number,
  ) => Promise<ExportJobOutput>;
  download: (result: ExportJobOutput, source: ExportSource) => (() => void) | void;
  onStart?: () => void;
  onState: (exporting: boolean, progress: ExportJobProgress | null) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onComplete?: (result: ExportJobOutput, source: ExportSource) => void;
  scheduleRevoke?: (revoke: () => void, delayMs: number) => () => void;
  now?: () => number;
};

export type ExportJobController = {
  start: (source: ExportSource) => Promise<void> | null;
  cancel: () => void;
  dispose: () => void;
};

const ERROR_FALLBACK = "Could not export this file.";

/** Owns the export lock until encoding settles, including after cancellation. */
export function createExportJobController(options: ExportJobOptions): ExportJobController {
  let active: {
    controller: AbortController;
    source: ExportSource;
    startedAt: number;
    canCancel: boolean;
    timer: ReturnType<typeof setInterval> | null;
  } | null = null;
  let disposed = false;
  const retainedDownloads = new Set<() => void>();

  const notify = (callback: () => void) => {
    try {
      callback();
    } catch {
      /* User-facing callbacks must not strand the lock. */
    }
  };

  const retainDownload = (revoke: (() => void) | void) => {
    if (!revoke) return;
    let cancelTimer = () => {};
    let retained = true;
    const release = () => {
      if (!retained) return;
      retained = false;
      retainedDownloads.delete(release);
      cancelTimer();
      try {
        revoke();
      } catch {
        /* Revocation is best effort during teardown. */
      }
    };
    retainedDownloads.add(release);
    const schedule =
      options.scheduleRevoke ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
    try {
      cancelTimer = schedule(release, 60_000);
    } catch {
      /* dispose() still owns cleanup. */
    }
  };

  const start = (source: ExportSource): Promise<void> | null => {
    if (disposed || active || options.lockedRef.current) return null;
    const controller = new AbortController();
    const now = options.now ?? (() => performance.now());
    const startedAt = now();
    const job = {
      controller,
      source,
      startedAt,
      canCancel: true,
      timer: null as ReturnType<typeof setInterval> | null,
    };
    options.lockedRef.current = true;
    active = job;

    let lastProgress: ExportJobProgress = {
      phase: "Preparing media",
      percent: 0,
      elapsedMs: 0,
      phaseElapsedMs: 0,
    };
    let lastInputProgress = lastProgress;
    let lastPhase = lastProgress.phase;
    let phaseStartedAt = startedAt;
    let lastPublishedAt = startedAt;
    let estimateStartedAt = startedAt;
    const publish = (progress: ExportJobProgress) => {
      if (disposed || controller.signal.aborted || active !== job) return;
      if (progress.canCancel === false) job.canCancel = false;
      const at = now();
      if (progress.phase !== lastPhase) {
        lastPhase = progress.phase;
        phaseStartedAt = at;
      }
      lastInputProgress = { ...progress };
      estimateStartedAt = at;
      lastProgress = {
        ...lastInputProgress,
        elapsedMs: Math.max(0, at - startedAt),
        phaseElapsedMs: Math.max(0, at - phaseStartedAt),
      };
      lastPublishedAt = at;
      notify(() => options.onState(true, lastProgress));
    };
    notify(() => options.onState(true, lastProgress));
    notify(() => options.onStart?.());

    job.timer = setInterval(() => {
      if (disposed || controller.signal.aborted || active !== job) return;
      const at = now();
      if (at - lastPublishedAt < 750) return;
      const estimate = lastInputProgress.remainingEstimate;
      const estimateAge = Math.max(0, at - estimateStartedAt) / 1000;
      const remainingEstimate =
        estimate && estimateAge < estimate.range.maxSeconds
          ? {
              ...estimate,
              range: {
                minSeconds: Math.max(1, estimate.range.minSeconds - estimateAge),
                maxSeconds: Math.max(1, estimate.range.maxSeconds - estimateAge),
              },
            }
          : undefined;
      lastProgress = {
        ...lastInputProgress,
        elapsedMs: Math.max(0, at - startedAt),
        phaseElapsedMs: Math.max(0, at - phaseStartedAt),
        remainingEstimate,
      };
      lastPublishedAt = at;
      notify(() => options.onState(true, lastProgress));
    }, 750);

    const task = (async () => {
      try {
        options.pausePlayback();
        const output = await options.execute(source, controller.signal, publish, startedAt);
        if (disposed || controller.signal.aborted || active !== job) return;
        const revoke = output.kind === "file" ? undefined : options.download(output, source);
        retainDownload(revoke);
        notify(() => options.onComplete?.(output, source));
      } catch (caught) {
        if (!disposed && !controller.signal.aborted && active === job) {
          const message = caught instanceof Error ? caught.message : ERROR_FALLBACK;
          notify(() => options.onError(message || ERROR_FALLBACK));
        }
      } finally {
        if (job.timer) clearInterval(job.timer);
        job.timer = null;
        if (active === job) {
          active = null;
          options.lockedRef.current = false;
          if (!disposed) notify(() => options.onState(false, null));
        }
      }
    })();
    return task;
  };

  const cancel = () => {
    if (!active || !active.canCancel || active.controller.signal.aborted) return;
    active.controller.abort();
    if (!disposed) notify(() => options.onNotice("Export canceled."));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    active?.controller.abort();
    if (active?.timer) clearInterval(active.timer);
    options.lockedRef.current = false;
    for (const release of [...retainedDownloads]) release();
  };

  return { start, cancel, dispose };
}
