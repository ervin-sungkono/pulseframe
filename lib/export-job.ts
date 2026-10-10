import type { PreparedSound } from "./audio-features";
import type { ExportAspect, ExportResolution } from "./export-settings";
import type { ExportProgress } from "./export-video";
import type { ExportFrameRate } from "./export-timeline";
import type { SubtitleCue } from "./subtitles";
import type { VisualSettings } from "./visual-settings-model";
import type { LogoLayer } from "./visualizer";
import type { ExportSourceKind, ExportTimingMeasurement } from "./export-time-estimate";
import type { ProjectTrack } from "./project-model";
import type { MediaSessionSnapshot } from "./media-session";
import type { ExportDestination } from "./export-destination";
import {
  snapshotExportRequests,
  type ExportRequest,
  type ExportRunItem,
  type ExportRunState,
} from "./export-request";

export type ExportSource = {
  file: File;
  /** Non-persisted media-session generation and source kind for profile scoping. */
  generation?: number;
  sourceKind: ExportSourceKind;
  duration: number;
  /** Project-time range. For playlists, `tracks` maps these times to each source track. */
  range: [number, number];
  format: ExportAspect;
  resolution: ExportResolution;
  frameRate: ExportFrameRate;
  videoCompression: boolean;
  settings: VisualSettings;
  subtitles: SubtitleCue[];
  logo: LogoLayer | null;
  background: LogoLayer | null;
  artwork?: LogoLayer | null;
  /** Original image files let a queued request prepare its own image handles. */
  logoFile?: File | null;
  backgroundFile?: File | null;
  artworkFile?: File | null;
  prepared?: PreparedSound;
  /** Present only when these runtime resources are retained under the editor lock. */
  snapshot?: MediaSessionSnapshot;
  /** Playlist tracks are retained as File refs and lightweight per-track metadata. */
  tracks?: ProjectTrack[];
  reducedMotion: boolean;
};

export type ExportJobProgress = ExportProgress;
export type ExportJobOutput = {
  blob?: Blob;
  saved?: boolean;
  extension: "mp4" | "webm" | "png";
  timing?: ExportTimingMeasurement;
};

export type ExportRunOptions = { destination?: ExportDestination; keepRuntime?: boolean };

type ExportJobOptions = {
  lockedRef: { current: boolean };
  pausePlayback: () => void;
  execute: (
    source: ExportSource,
    signal: AbortSignal,
    onProgress: (progress: ExportJobProgress) => void,
    startedAt: number,
  ) => Promise<ExportJobOutput>;
  executeRequest?: (
    request: ExportRequest,
    signal: AbortSignal,
    onProgress: (progress: ExportJobProgress) => void,
    startedAt: number,
    runOptions: ExportRunOptions,
  ) => Promise<ExportJobOutput>;
  download?: (result: ExportJobOutput, source: ExportSource) => (() => void) | void;
  onOutputReady?: (result: ExportJobOutput, request: ExportRequest) => void;
  onStart?: () => void;
  onState: (
    exporting: boolean,
    progress: ExportJobProgress | null,
    run?: ExportRunState | null,
  ) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onComplete?: (result: ExportJobOutput, source: ExportSource) => void;
  onRequestComplete?: (result: ExportJobOutput, request: ExportRequest) => void;
  scheduleRevoke?: (revoke: () => void, delayMs: number) => () => void;
  now?: () => number;
};

export type ExportJobController = {
  /** Legacy one-file API. */
  start: (source: ExportSource) => Promise<void> | null;
  /** Run a snapshotted ordered queue under one shared lock. */
  runRequests: (
    requests: readonly ExportRequest[],
    options?: ExportRunOptions,
  ) => Promise<void> | null;
  retryPending: (requests?: readonly ExportRequest[]) => Promise<void> | null;
  pause: () => void;
  resume: () => void;
  continueOutput: (revoke?: () => void) => void;
  cancel: () => void;
  dispose: () => void;
};

const ERROR_FALLBACK = "Could not export this file.";
const ABORTED = () => new DOMException("Export canceled.", "AbortError");

type ActiveRun = {
  controller: AbortController;
  startedAt: number;
  timer: ReturnType<typeof setInterval> | null;
  items: ExportRunItem[];
  requestIds: string[];
  runOptions: ExportRunOptions;
  batch: boolean;
  pauseRequested: boolean;
  pauseWaiters: Set<() => void>;
  outputWaiter: { resolve: () => void; reject: (error: unknown) => void } | null;
};

/** Owns the editor lock until a whole ordered run has settled. */
export function createExportJobController(options: ExportJobOptions): ExportJobController {
  let active: ActiveRun | null = null;
  let disposed = false;
  let currentRun: ExportRunState | null = null;
  let lastRequests: ExportRequest[] = [];
  let lastRunOptions: ExportRunOptions = {};
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

  const publishState = (run: ActiveRun, progress: ExportJobProgress | null) => {
    currentRun = { items: run.items.map((item) => ({ ...item })), currentId: null, paused: false };
    currentRun.currentId =
      run.requestIds.find((id) => {
        const item = run.items.find((candidate) => candidate.id === id);
        return item?.status === "running" || item?.status === "awaiting-download";
      }) ?? null;
    currentRun.paused = run.pauseRequested;
    if (!disposed && active === run) notify(() => options.onState(true, progress, currentRun));
  };

  const updateItem = (
    run: ActiveRun,
    id: string,
    status: ExportRunItem["status"],
    error?: string,
  ) => {
    const item = run.items.find((candidate) => candidate.id === id);
    if (!item) return;
    item.status = status;
    if (error) item.error = error;
    else delete item.error;
    publishState(run, null);
  };

  const itemFor = (request: ExportRequest): ExportRunItem => ({
    id: request.id,
    label: request.label,
    filename: request.filename,
    kind: request.kind,
    status: "pending",
  });

  const settleOutputWait = (run: ActiveRun, error?: unknown) => {
    const waiter = run.outputWaiter;
    if (!waiter) return;
    run.outputWaiter = null;
    if (error) waiter.reject(error);
    else waiter.resolve();
  };

  const waitForOutput = (run: ActiveRun) => {
    if (run.controller.signal.aborted) return Promise.reject(ABORTED());
    return new Promise<void>((resolve, reject) => {
      const signal = run.controller.signal;
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const finish = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        run.outputWaiter = null;
        reject(ABORTED());
      };
      run.outputWaiter = {
        resolve: finish,
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const waitIfPaused = async (run: ActiveRun) => {
    if (!run.pauseRequested) return;
    publishState(run, null);
    await new Promise<void>((resolve, reject) => {
      const signal = run.controller.signal;
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const resume = () => {
        cleanup();
        run.pauseWaiters.delete(resume);
        resolve();
      };
      const onAbort = () => {
        cleanup();
        run.pauseWaiters.delete(resume);
        reject(ABORTED());
      };
      run.pauseWaiters.add(resume);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (run.controller.signal.aborted) throw ABORTED();
  };

  const finishRun = (run: ActiveRun) => {
    if (run.timer) clearInterval(run.timer);
    run.timer = null;
    if (active !== run) return;
    active = null;
    options.lockedRef.current = false;
    currentRun = {
      items: run.items.map((item) => ({ ...item })),
      currentId: null,
      paused: false,
    };
    if (!disposed) notify(() => options.onState(false, null, currentRun));
  };

  const startRun = (
    requests: readonly ExportRequest[],
    runOptions: ExportRunOptions,
    batch: boolean,
    retry = false,
  ): Promise<void> | null => {
    if (disposed || active || options.lockedRef.current || !requests.length) return null;
    const previousComplete = new Set(
      retry
        ? currentRun?.items.filter((item) => item.status === "complete").map((item) => item.id)
        : [],
    );
    const previousItems = new Map(currentRun?.items.map((item) => [item.id, item]) ?? []);
    const unique = new Set<string>();
    for (const request of requests) {
      if (!request.id || unique.has(request.id))
        throw new Error("Export request IDs must be unique.");
      unique.add(request.id);
    }

    const controller = new AbortController();
    const now = options.now ?? (() => performance.now());
    const startedAt = now();
    const items = requests.map((request) => {
      const prior = previousItems.get(request.id);
      if (retry && prior?.status === "complete") return { ...prior };
      return itemFor(request);
    });
    const run: ActiveRun = {
      controller,
      startedAt,
      timer: null,
      items,
      requestIds: requests.map((request) => request.id),
      runOptions,
      batch,
      pauseRequested: false,
      pauseWaiters: new Set(),
      outputWaiter: null,
    };
    options.lockedRef.current = true;
    active = run;
    if (!retry) {
      lastRequests = [...requests];
      lastRunOptions = runOptions;
    }

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
      if (disposed || controller.signal.aborted || active !== run) return;
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
      publishState(run, lastProgress);
    };
    publishState(run, lastProgress);
    notify(() => options.onStart?.());

    run.timer = setInterval(() => {
      if (disposed || controller.signal.aborted || active !== run) return;
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
      publishState(run, lastProgress);
    }, 750);

    const task = (async () => {
      try {
        options.pausePlayback();
        for (let index = 0; index < requests.length; index++) {
          const request = requests[index];
          if (previousComplete.has(request.id)) continue;
          if (controller.signal.aborted) break;
          if (run.pauseRequested) await waitIfPaused(run);
          if (controller.signal.aborted) break;
          updateItem(run, request.id, "running");
          try {
            const output =
              options.executeRequest && batch
                ? await options.executeRequest(
                    request,
                    controller.signal,
                    publish,
                    startedAt,
                    runOptions,
                  )
                : await options.execute(request.source, controller.signal, publish, startedAt);
            if (disposed || controller.signal.aborted || active !== run) break;
            if (!output.saved && !output.blob) throw new Error("The export did not create a file.");

            if (batch && output.blob && !output.saved) {
              updateItem(run, request.id, "awaiting-download");
              if (options.onOutputReady) {
                const wait = waitForOutput(run);
                options.onOutputReady(output, request);
                await wait;
              } else {
                const revoke = options.download?.(output, request.source);
                retainDownload(revoke);
              }
            } else if (!output.saved) {
              const revoke = options.download?.(output, request.source);
              retainDownload(revoke);
            }

            if (controller.signal.aborted || active !== run) break;
            updateItem(run, request.id, "complete");
            notify(() => options.onRequestComplete?.(output, request));
            if (!batch) notify(() => options.onComplete?.(output, request.source));
            if (run.pauseRequested) await waitIfPaused(run);
          } catch (caught) {
            if (controller.signal.aborted || disposed) break;
            const message = caught instanceof Error ? caught.message : ERROR_FALLBACK;
            updateItem(run, request.id, "failed", message || ERROR_FALLBACK);
            notify(() => options.onError(message || ERROR_FALLBACK));
            break;
          }
        }
      } catch (caught) {
        if (!controller.signal.aborted && !disposed) {
          const message = caught instanceof Error ? caught.message : ERROR_FALLBACK;
          notify(() => options.onError(message || ERROR_FALLBACK));
        }
      } finally {
        if (controller.signal.aborted) {
          for (const item of run.items) {
            if (
              item.status === "pending" ||
              item.status === "running" ||
              item.status === "awaiting-download"
            )
              item.status = "stopped";
          }
        }
        settleOutputWait(run, controller.signal.aborted ? ABORTED() : undefined);
        for (const resume of [...run.pauseWaiters]) resume();
        finishRun(run);
      }
    })();
    return task;
  };

  const start = (source: ExportSource): Promise<void> | null => {
    const request: ExportRequest = {
      id: `single-${Date.now().toString(36)}`,
      label: "Video export",
      filename: (source.file?.name ?? "export").replace(/\.[^.]+$/, ""),
      kind: "video",
      source,
    };
    return startRun([request], {}, false);
  };

  const retryPending = (requests?: readonly ExportRequest[]) => {
    if (!currentRun || active || (!requests && !lastRequests.length)) return null;
    if (requests && !requests.length) return null;
    const retryRequests = requests ? snapshotExportRequests(requests) : lastRequests;
    const completed = new Set(
      currentRun.items.filter((item) => item.status === "complete").map((item) => item.id),
    );
    if (retryRequests.every((request) => completed.has(request.id))) return null;
    lastRequests = [...retryRequests];
    return startRun(retryRequests, lastRunOptions, true, true);
  };

  const pause = () => {
    if (!active || active.controller.signal.aborted || active.pauseRequested) return;
    active.pauseRequested = true;
    publishState(active, null);
  };

  const resume = () => {
    if (!active || !active.pauseRequested) return;
    active.pauseRequested = false;
    for (const resumeWaiter of [...active.pauseWaiters]) resumeWaiter();
    publishState(active, null);
  };

  const continueOutput = (revoke?: () => void) => {
    if (!active || active.controller.signal.aborted) return;
    retainDownload(revoke);
    settleOutputWait(active);
  };

  const cancel = () => {
    if (!active || active.controller.signal.aborted) return;
    active.controller.abort();
    settleOutputWait(active, ABORTED());
    for (const resumeWaiter of [...active.pauseWaiters]) resumeWaiter();
    if (!disposed)
      notify(() => options.onNotice(active?.batch ? "Batch export stopped." : "Export canceled."));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    active?.controller.abort();
    if (active?.timer) {
      clearInterval(active.timer);
      active.timer = null;
    }
    if (active) {
      settleOutputWait(active, ABORTED());
      for (const resumeWaiter of [...active.pauseWaiters]) resumeWaiter();
    } else {
      options.lockedRef.current = false;
    }
    for (const release of [...retainedDownloads]) release();
  };

  return {
    start,
    runRequests: (requests, runOptions = {}) =>
      startRun(
        snapshotExportRequests(requests, { keepRuntime: runOptions.keepRuntime }),
        runOptions,
        true,
      ),
    retryPending,
    pause,
    resume,
    continueOutput,
    cancel,
    dispose,
  };
}
