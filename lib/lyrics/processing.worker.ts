import { resampleMono16k, resampleStereo44100 } from "./audio";
import type { IsolationBackend } from "./isolation";
import { assessLyricsInput, getCpuThreadCount, resolveLocalLyricsPolicy } from "./policy";
import {
  configureWhisperRuntime,
  disposeWhisperPipelines,
  transcribeLocalWhisper,
  WHISPER_MODEL_REVISIONS,
  type WhisperModelId,
} from "./whisper";
import type { LyricsProgress, LyricsResult } from "./types";
import type {
  LyricsWorkerAudioSlice,
  LyricsWorkerRequest,
  LyricsWorkerResponse,
  LyricsWorkerStart,
} from "./worker-protocol";

type WorkerScope = {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<LyricsWorkerRequest>) => void,
  ) => void;
  postMessage: (message: LyricsWorkerResponse, transfer?: Transferable[]) => void;
};

type HighPerformanceAdapter = unknown;
type Plan = ReturnType<typeof resolveLocalLyricsPolicy>;
type Checkpoint = {
  sourceId: string;
  durationMs: number;
  sampleRate: number;
  sampleCount: number;
  channelCount: number;
  model: Plan["model"];
  isolation: Plan["isolation"];
  overlap: Plan["overlap"];
  source?: Float32Array[];
  mdxInput?: [Float32Array, Float32Array];
  vocals?: [Float32Array, Float32Array];
  waveform?: Float32Array;
  separationBackend?: IsolationBackend;
  separationTimings?: Record<string, number>;
  isolationFallback?: boolean;
  notices: string[];
};

type ActiveJob = {
  id: number;
  controller: AbortController;
  requestAudio?: (message: LyricsWorkerAudioSlice) => void;
};

const scope = self as unknown as WorkerScope;
const AUDIO_SLICE_SAMPLES = 65_536;
let activeJob: ActiveJob | null = null;
let checkpoint: Checkpoint | null = null;
let retainedWhisperModel: Plan["model"] | null = null;

function post(message: LyricsWorkerResponse, transfer?: Transferable[]) {
  scope.postMessage(message, transfer);
}

function progress(jobId: number, value: LyricsProgress) {
  post({ type: "progress", jobId, progress: value });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Local subtitle generation failed.";
}

function isFatalInitializationTimeout(error: unknown) {
  return (
    (error instanceof Error && error.name === "ModelInitializationTimeoutError") ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

function readDeviceMemoryGiB() {
  const nav = self.navigator as Navigator & { deviceMemory?: number };
  return nav.deviceMemory;
}

async function requestHighPerformanceAdapter(): Promise<HighPerformanceAdapter | null> {
  const nav = self.navigator as Navigator & {
    gpu?: {
      requestAdapter(options?: { powerPreference?: string }): Promise<unknown | null>;
    };
  };
  if (!nav.gpu || typeof nav.gpu.requestAdapter !== "function") return null;
  try {
    return await nav.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }
}

function getThreadCount() {
  let sharedWasmMemoryAvailable = false;
  if (typeof SharedArrayBuffer !== "undefined") {
    try {
      new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      sharedWasmMemoryAvailable = true;
    } catch {
      // Shared WebAssembly memory can be unavailable even with COOP/COEP.
    }
  }
  return getCpuThreadCount({
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedArrayBufferAvailable: typeof SharedArrayBuffer !== "undefined",
    sharedWasmMemoryAvailable,
    hardwareConcurrency: self.navigator.hardwareConcurrency || 1,
  });
}

function validateStart(request: LyricsWorkerStart) {
  if (
    !Number.isInteger(request.jobId) ||
    !Number.isSafeInteger(request.sampleCount) ||
    request.sampleCount < 1 ||
    !Number.isInteger(request.channelCount) ||
    request.channelCount < 1 ||
    request.channelCount > 2 ||
    !Number.isFinite(request.durationMs) ||
    request.durationMs <= 0 ||
    !Number.isInteger(request.sampleRate) ||
    request.sampleRate < 8_000 ||
    request.sampleRate > 384_000 ||
    !Number.isFinite(request.retainedBytes) ||
    request.retainedBytes < 0
  ) {
    throw new Error("The decoded audio metadata is invalid.");
  }
  const expectedSampleCount = Math.round((request.durationMs * request.sampleRate) / 1000);
  if (
    Math.abs(request.sampleCount - expectedSampleCount) >
      Math.max(2, Math.ceil(request.sampleRate / 2)) ||
    typeof request.sourceId !== "string" ||
    request.sourceId.length < 1 ||
    request.sourceId.length > 512
  ) {
    throw new Error("The decoded audio duration does not match its sample data.");
  }
}

function matchesCheckpoint(request: LyricsWorkerStart, plan: Plan) {
  return (
    checkpoint !== null &&
    checkpoint.sourceId === request.sourceId &&
    checkpoint.durationMs === request.durationMs &&
    checkpoint.sampleRate === request.sampleRate &&
    checkpoint.sampleCount === request.sampleCount &&
    checkpoint.channelCount === request.channelCount &&
    checkpoint.model === plan.model &&
    checkpoint.isolation === plan.isolation &&
    checkpoint.overlap === plan.overlap
  );
}

async function collectSource(request: LyricsWorkerStart, jobId: number): Promise<Float32Array[]> {
  const channels = Array.from(
    { length: request.channelCount },
    () => new Float32Array(request.sampleCount),
  );
  const total = Math.ceil(request.sampleCount / AUDIO_SLICE_SAMPLES);
  for (let index = 0; index < total; index += 1) {
    if (activeJob?.id !== jobId) throw new DOMException("Generation canceled.", "AbortError");
    const offset = index * AUDIO_SLICE_SAMPLES;
    const length = Math.min(AUDIO_SLICE_SAMPLES, request.sampleCount - offset);
    const slice = await new Promise<LyricsWorkerAudioSlice>((resolve, reject) => {
      const job = activeJob;
      if (!job || job.id !== jobId) {
        reject(new DOMException("Generation canceled.", "AbortError"));
        return;
      }
      job.requestAudio = resolve;
      post({
        type: "need-audio",
        jobId,
        offset,
        length,
        completed: index,
        total,
      });
    });
    if (
      slice.offset !== offset ||
      slice.channels.length !== request.channelCount ||
      slice.channels.some((channel) => channel.length !== length)
    ) {
      throw new Error("The received audio slice did not match the requested source range.");
    }
    for (let channel = 0; channel < channels.length; channel += 1)
      channels[channel].set(slice.channels[channel], offset);
    progress(jobId, {
      stage: "prepare",
      message: "Copying audio into the local worker.",
      completed: index + 1,
      total,
    });
  }
  return channels;
}

function createAdmission(request: LyricsWorkerStart, isolation: boolean, model: "tiny" | "base") {
  return assessLyricsInput({
    // The UI validates the selected file's byte size. The worker rechecks all
    // decoded-media limits and budgets its retained and worker-owned PCM.
    fileBytes: 1,
    durationMs: request.durationMs,
    sampleRate: request.sampleRate,
    channelCount: request.channelCount,
    retainedBytes: request.retainedBytes,
    deviceMemoryGiB: readDeviceMemoryGiB(),
    isolation,
    model,
    method: request.isolationOnly ? "gemini" : "local",
  });
}

function updateCheckpoint(plan: Plan, request: LyricsWorkerStart, values: Partial<Checkpoint>) {
  const previous = matchesCheckpoint(request, plan) ? checkpoint : null;
  checkpoint = {
    sourceId: request.sourceId,
    durationMs: request.durationMs,
    sampleRate: request.sampleRate,
    sampleCount: request.sampleCount,
    channelCount: request.channelCount,
    model: plan.model,
    isolation: plan.isolation,
    overlap: plan.overlap,
    ...previous,
    notices: values.notices ?? previous?.notices ?? [...plan.notices],
    ...values,
  };
}

async function runIsolationOnly(request: LyricsWorkerStart) {
  validateStart(request);
  if (request.preset !== "quality") throw new Error("Vocal isolation requires Quality mode.");
  const admission = createAdmission(request, true, "base");
  if (!admission.admitted)
    throw new Error(admission.reason ?? "This track exceeds the estimated memory budget.");
  const jobId = request.jobId;
  const signal = activeJob!.controller.signal;
  const source = await collectSource(request, jobId);
  progress(jobId, { stage: "prepare", message: "Preparing stereo audio for vocal isolation." });
  const stereo = await resampleStereo44100(source, request.sampleRate, signal);
  source.length = 0;
  const { isolateVocals } = await import("./isolation");
  const isolated = await isolateVocals(stereo, {
    overlap: 0.5,
    threads: getThreadCount(),
    signal,
    onProgress: (value) =>
      progress(jobId, {
        stage: "isolate",
        message: "Separating the vocal from the accompaniment.",
        completed: value.completed,
        total: value.total,
      }),
  });
  return isolated;
}

async function run(request: LyricsWorkerStart) {
  validateStart(request);
  const jobId = request.jobId;
  const startedAt = performance.now();
  const gpuAdapter = await requestHighPerformanceAdapter();
  const autoIsolationAdmission =
    request.preset === "auto" ? createAdmission(request, true, "tiny") : null;
  const plan = resolveLocalLyricsPolicy(request.preset, {
    webgpuAvailable: gpuAdapter !== null,
    memoryAdmitted: autoIsolationAdmission?.admitted ?? false,
  });
  const model = plan.model.endsWith("base") ? "base" : "tiny";
  let cached = matchesCheckpoint(request, plan) ? checkpoint : null;
  if (!cached && checkpoint) {
    checkpoint = null;
    await disposeWhisperPipelines();
    retainedWhisperModel = null;
  } else if (retainedWhisperModel && retainedWhisperModel !== plan.model) {
    await disposeWhisperPipelines();
    retainedWhisperModel = null;
  }
  const admission = createAdmission(request, plan.isolation !== "none", model);
  if (!admission.admitted)
    throw new Error(admission.reason ?? "This track exceeds the estimated memory budget.");

  const preparationStarted = performance.now();
  if (!cached) {
    updateCheckpoint(plan, request, {
      source: await collectSource(request, jobId),
    });
    cached = checkpoint;
  }
  if (!cached) throw new Error("The audio could not be prepared for local processing.");

  const threads = getThreadCount();
  const notices = cached.notices;
  progress(jobId, {
    stage: "prepare",
    message: "Preparing audio for transcription.",
  });

  let actualIsolation: Plan["isolation"] = cached.isolationFallback ? "none" : plan.isolation;
  let overlap = cached.isolationFallback ? 0 : plan.overlap;
  let isolationBackend: IsolationBackend | undefined = cached.separationBackend;
  let waveform = cached.waveform;

  if (plan.isolation !== "none" && !cached.vocals && !cached.isolationFallback && !waveform) {
    if (!cached.mdxInput) {
      const source = cached.source;
      if (!source)
        throw new Error(
          "The vocal-isolation retry checkpoint is unavailable. Reload the audio and retry.",
        );
      cached.mdxInput = await resampleStereo44100(
        source,
        request.sampleRate,
        activeJob?.controller.signal,
        (completed, total) => {
          progress(jobId, {
            stage: "prepare",
            message: "Preparing stereo audio for vocal isolation.",
            completed,
            total,
          });
        },
      );
      cached.source = undefined;
      updateCheckpoint(plan, request, { mdxInput: cached.mdxInput });
      cached = checkpoint!;
    }
    const mdxInput = cached.mdxInput;
    if (!mdxInput) throw new Error("The vocal-isolation retry checkpoint is unavailable.");
    let isolated: Awaited<ReturnType<(typeof import("./isolation"))["isolateVocals"]>> | null =
      null;
    try {
      const isolationModule = await import("./isolation");
      isolated = await isolationModule.isolateVocals(mdxInput, {
        overlap: plan.overlap as 0.25 | 0.5,
        threads,
        signal: activeJob!.controller.signal,
        onProgress: (value) =>
          progress(jobId, {
            stage: "isolate",
            message: "Separating the vocal from the accompaniment.",
            completed: value.completed,
            total: value.total,
          }),
      });
    } catch (error) {
      if (request.preset === "quality") {
        throw new Error(
          `Quality vocal separation failed. Retry the same source to resume the separated-audio step. ${errorMessage(error)}`,
        );
      }
      notices.push("Auto vocal isolation failed; transcription continued on the original mix.");
      notices.push(errorMessage(error));
      actualIsolation = "none";
      overlap = 0;
      isolationBackend = undefined;
      const mix =
        cached.mdxInput ??
        (cached.source
          ? await resampleStereo44100(
              cached.source,
              request.sampleRate,
              activeJob?.controller.signal,
            )
          : null);
      if (!mix) throw error;
      waveform = await resampleMono16k(mix, 44_100, activeJob?.controller.signal);
      updateCheckpoint(plan, request, {
        source: undefined,
        mdxInput: undefined,
        waveform,
        vocals: undefined,
        separationBackend: undefined,
        isolationFallback: true,
        notices,
      });
      cached = checkpoint!;
    }
    if (isolated) {
      const separatedVocals = isolated.channels;
      cached.vocals = separatedVocals;
      cached.mdxInput = undefined;
      cached.source = undefined;
      cached.separationBackend = isolated.backend;
      cached.separationTimings = isolated.timings;
      cached.notices.push(...isolated.notices);
      updateCheckpoint(plan, request, {
        vocals: separatedVocals,
        separationBackend: isolated.backend,
        separationTimings: isolated.timings,
        notices: cached.notices,
      });
      cached = checkpoint!;
      isolationBackend = isolated.backend;
      waveform = await resampleMono16k(
        separatedVocals,
        isolated.sampleRate,
        activeJob?.controller.signal,
        (completed, total) => {
          progress(jobId, {
            stage: "prepare",
            message: "Preparing the separated vocal for transcription.",
            completed,
            total,
          });
        },
      );
      cached.waveform = waveform;
      updateCheckpoint(plan, request, {
        waveform,
        vocals: separatedVocals,
        separationBackend: isolated.backend,
        notices: cached.notices,
      });
      cached = checkpoint!;
    }
  } else if (!waveform) {
    if (cached.vocals) {
      waveform = await resampleMono16k(cached.vocals, 44_100, activeJob?.controller.signal);
      updateCheckpoint(plan, request, {
        waveform,
        vocals: cached.vocals,
        separationBackend: cached.separationBackend,
      });
      cached = checkpoint!;
    } else if (cached.mdxInput) {
      waveform = await resampleMono16k(cached.mdxInput, 44_100, activeJob?.controller.signal);
      updateCheckpoint(plan, request, {
        waveform,
        mdxInput: cached.mdxInput,
        notices: cached.notices,
      });
      cached = checkpoint!;
    } else {
      const source = cached.source;
      if (!source)
        throw new Error(
          "The local audio retry checkpoint is unavailable. Reload the audio and retry.",
        );
      waveform = await resampleMono16k(
        source,
        request.sampleRate,
        activeJob?.controller.signal,
        (completed, total) => {
          progress(jobId, {
            stage: "prepare",
            message: "Resampling audio for transcription.",
            completed,
            total,
          });
        },
      );
      updateCheckpoint(plan, request, { source: undefined, waveform });
      cached = checkpoint!;
    }
  }

  if (!waveform) throw new Error("Audio preparation did not produce a transcription signal.");
  const preparationMs = Math.round(performance.now() - preparationStarted);
  const transcriptionStarted = performance.now();
  await configureWhisperRuntime(threads, gpuAdapter);
  retainedWhisperModel = plan.model;
  const whisper = await transcribeLocalWhisper({
    model: plan.model as WhisperModelId,
    preferredBackend: gpuAdapter ? "webgpu" : "wasm",
    waveform,
    durationMs: request.durationMs,
    onProgress: (value) => progress(jobId, value),
  });
  const transcriptionMs = Math.round(performance.now() - transcriptionStarted);
  const allNotices = [...new Set([...notices, ...whisper.notices])];
  const result: LyricsResult = {
    cues: whisper.cues,
    durationMs: request.durationMs,
    method: "local",
    preset: request.preset,
    diagnostics: {
      model: plan.model,
      revision: WHISPER_MODEL_REVISIONS[plan.model],
      isolation: actualIsolation,
      overlap,
      ...(isolationBackend ? { isolationBackend } : {}),
      whisperBackend: whisper.backend,
      graphCapture: false,
      requestedThreads: threads,
      chunks: whisper.chunks,
      attempts: whisper.attempts,
      rechecks: 0,
      timings: {
        ...cached.separationTimings,
        preparationMs,
        transcriptionMs,
        totalMs: Math.round(performance.now() - startedAt),
      },
    },
    notices: allNotices,
  };
  checkpoint = null;
  await disposeWhisperPipelines();
  retainedWhisperModel = null;
  progress(jobId, { stage: "format", message: "Finalizing subtitle timings." });
  return result;
}

scope.addEventListener("message", (event) => {
  const request = event.data;
  if (request.type === "audio-slice") {
    if (activeJob?.id !== request.jobId || !activeJob.requestAudio) return;
    const resolve = activeJob.requestAudio;
    activeJob.requestAudio = undefined;
    resolve(request);
    return;
  }
  if (activeJob) {
    post({
      type: "error",
      jobId: request.jobId,
      message: "Local subtitle generation is already running.",
    });
    return;
  }
  activeJob = { id: request.jobId, controller: new AbortController() };
  if (request.isolationOnly) {
    void runIsolationOnly(request).then(
      (isolated) => {
        if (activeJob?.id !== request.jobId) return;
        post(
          {
            type: "isolated",
            jobId: request.jobId,
            channels: isolated.channels,
            backend: isolated.backend,
            notices: isolated.notices,
          },
          isolated.channels.map((channel) => channel.buffer),
        );
        activeJob = null;
      },
      (error) => {
        if (activeJob?.id !== request.jobId) return;
        post({ type: "error", jobId: request.jobId, message: errorMessage(error) });
        activeJob = null;
      },
    );
    return;
  }
  void run(request).then(
    (result) => {
      if (activeJob?.id !== request.jobId) return;
      post({ type: "result", jobId: request.jobId, result });
      activeJob = null;
    },
    (error) => {
      if (activeJob?.id !== request.jobId) return;
      post({
        type: "error",
        jobId: request.jobId,
        message: errorMessage(error),
        ...(isFatalInitializationTimeout(error) ? { fatal: true } : {}),
      });
      activeJob = null;
    },
  );
});
