import type { PreparedSound } from "./audio-features";
import type { ExportAspect, ExportResolution } from "./export-settings";
import type { ExportProgress } from "./export-video";
import type { ExportFrameRate } from "./export-timeline";
import type { SubtitleCue } from "./subtitles";
import type { VisualSettings } from "./visual-settings-model";
import type { LogoLayer } from "./visualizer";

export type ExportSource = {
  file: File;
  duration: number;
  range: [number, number];
  format: ExportAspect;
  resolution: ExportResolution;
  frameRate: ExportFrameRate;
  videoCompression: boolean;
  settings: VisualSettings;
  subtitles: SubtitleCue[];
  logo: LogoLayer | null;
  background: LogoLayer | null;
  prepared?: PreparedSound;
  reducedMotion: boolean;
};

export type ExportJobProgress = ExportProgress;
export type ExportJobOutput = { blob: Blob; extension: "mp4" | "webm" };

type ExportJobOptions = {
  lockedRef: { current: boolean };
  pausePlayback: () => void;
  execute: (source: ExportSource, signal: AbortSignal, onProgress: (progress: ExportJobProgress) => void) => Promise<ExportJobOutput>;
  download: (result: ExportJobOutput, source: ExportSource) => (() => void) | void;
  onStart?: () => void;
  onState: (exporting: boolean, progress: ExportJobProgress | null) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onComplete?: (result: ExportJobOutput, source: ExportSource) => void;
  scheduleRevoke?: (revoke: () => void, delayMs: number) => () => void;
};

export type ExportJobController = {
  start: (source: ExportSource) => Promise<void> | null;
  cancel: () => void;
  dispose: () => void;
};

const ERROR_FALLBACK = "Could not export this file.";

/** Owns the export lock until encoding settles, including after cancellation. */
export function createExportJobController(options: ExportJobOptions): ExportJobController {
  let active: { controller: AbortController; source: ExportSource } | null = null;
  let disposed = false;
  const retainedDownloads = new Set<() => void>();

  const notify = (callback: () => void) => {
    try { callback(); } catch { /* User-facing callbacks must not strand the lock. */ }
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
      try { revoke(); } catch { /* Revocation is best effort during teardown. */ }
    };
    retainedDownloads.add(release);
    const schedule = options.scheduleRevoke ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
    try { cancelTimer = schedule(release, 60_000); } catch { /* dispose() still owns cleanup. */ }
  };

  const start = (source: ExportSource): Promise<void> | null => {
    if (disposed || active || options.lockedRef.current) return null;
    const controller = new AbortController();
    const job = { controller, source };
    options.lockedRef.current = true;
    active = job;

    notify(() => options.onState(true, { phase: "Preparing media", percent: 0 }));
    notify(() => options.onStart?.());

    const task = (async () => {
      try {
        options.pausePlayback();
        const output = await options.execute(source, controller.signal, progress => {
          if (disposed || controller.signal.aborted || active !== job) return;
          notify(() => options.onState(true, { phase: progress.phase, percent: progress.percent }));
        });
        if (disposed || controller.signal.aborted || active !== job) return;
        const revoke = options.download(output, source);
        retainDownload(revoke);
        notify(() => options.onComplete?.(output, source));
      } catch (caught) {
        if (!disposed && !controller.signal.aborted && active === job) {
          const message = caught instanceof Error ? caught.message : ERROR_FALLBACK;
          notify(() => options.onError(message || ERROR_FALLBACK));
        }
      } finally {
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
    if (!active || active.controller.signal.aborted) return;
    active.controller.abort();
    if (!disposed) notify(() => options.onNotice("Export canceled."));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    active?.controller.abort();
    options.lockedRef.current = false;
    for (const release of [...retainedDownloads]) release();
  };

  return { start, cancel, dispose };
}
