import type { AutomaticSpeechRecognitionOutput } from "@huggingface/transformers";
import type { GeneratedCue, LyricsProgress } from "./types";
import { isNearDigitalSilence } from "./audio";
import type { GeneratedCueInput } from "./cues";
import { normalizeGeneratedCues, normalizeWindowCues } from "./cues";
import {
  configureWhisperRuntimeAssets,
  type WhisperRuntimeEnvironment,
} from "./runtime-assets";

export const WHISPER_MODEL_REVISIONS = {
  "onnx-community/whisper-tiny": "ff4177021cc41f7db950912b73ea4fdf7d01d8e7",
  "onnx-community/whisper-base": "1846881b6b3a3024392c1eea3ad983695bc23925",
} as const;

const SAMPLE_RATE = 16_000;
const WINDOW_SAMPLES = 30 * SAMPLE_RATE;
const WINDOW_STRIDE_SAMPLES = 26 * SAMPLE_RATE;
const MODEL_INITIALIZATION_TIMEOUT_MS = 5 * 60 * 1000;

export type WhisperModelId = keyof typeof WHISPER_MODEL_REVISIONS;
export type WhisperBackend = "webgpu" | "wasm";
export type WhisperAudioSegment = {
  text: string;
  timestamp: [number | null, number | null];
};
type SessionMetadata = {
  config?: { device?: string };
  handler?: { config?: { device?: string } };
};
type LocalWhisperPipeline = ((
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<AutomaticSpeechRecognitionOutput>) & {
  model: { sessions: Record<string, SessionMetadata> };
  dispose: () => Promise<void> | void;
};

export type WhisperRunOptions = {
  model: WhisperModelId;
  preferredBackend: WhisperBackend;
  waveform: Float32Array;
  durationMs: number;
  onProgress: (progress: LyricsProgress) => void;
};

export type WhisperRunResult = {
  cues: GeneratedCue[];
  backend: WhisperBackend;
  chunks: number;
  attempts: number;
  notices: string[];
};

const loadedPipelines = new Map<string, Promise<LocalWhisperPipeline>>();
let transformersModule: typeof import("@huggingface/transformers") | null =
  null;
let webgpuFailedForWorker = false;
let transformersModulePromise: Promise<
  typeof import("@huggingface/transformers")
> | null = null;

class ModelInitializationTimeoutError extends Error {
  constructor() {
    super(
      "Whisper model download or initialization timed out after five minutes. Retry on a stable connection.",
    );
    this.name = "ModelInitializationTimeoutError";
  }
}

function withInitializationTimeout<T>(promise: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new ModelInitializationTimeoutError()),
      MODEL_INITIALIZATION_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout!));
}

function elapsed(startedAt: number) {
  return Math.round(performance.now() - startedAt);
}

function getWindowStarts(sampleCount: number) {
  const starts: number[] = [];
  for (let offset = 0; offset < sampleCount; offset += WINDOW_STRIDE_SAMPLES) {
    starts.push(offset);
    if (offset + WINDOW_SAMPLES >= sampleCount) break;
  }
  return starts;
}

function getActualBackend(
  transcriber: LocalWhisperPipeline,
  requested: WhisperBackend,
): WhisperBackend {
  const devices = Object.values(transcriber.model.sessions).flatMap(
    (session) => [session.config?.device, session.handler?.config?.device],
  );
  if (devices.includes("webgpu")) return "webgpu";
  if (devices.includes("wasm") || devices.includes("cpu")) return "wasm";
  return requested;
}

type ModelProgress = {
  status: "initiate" | "download" | "progress" | "done" | "ready";
  file?: string;
  loaded?: number;
  total?: number;
};

function reportDownload(
  progress: ModelProgress,
  onProgress: WhisperRunOptions["onProgress"],
) {
  if (progress.status === "ready") return;
  const details =
    progress.status === "progress"
      ? { completed: progress.loaded, total: progress.total }
      : {};
  onProgress({
    stage: "download",
    message:
      progress.status === "done"
        ? "Loaded local transcription model assets."
        : "Loading local transcription model assets.",
    ...details,
  });
}

async function loadTransformers() {
  if (!transformersModule) {
    transformersModulePromise ??= import("@huggingface/transformers");
    transformersModule = await withInitializationTimeout(
      transformersModulePromise,
    );
  }
  return transformersModule;
}

/** Configure the nested Transformers.js ONNX runtime, distinct from MDX ORT. */
export async function configureWhisperRuntime(
  requestedThreads: number,
  highPerformanceAdapter?: unknown | null,
) {
  const { env } = await withInitializationTimeout(loadTransformers());
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  const runtime = env.backends.onnx as unknown as WhisperRuntimeEnvironment & {
    webgpu?: {
      powerPreference?: "low-power" | "high-performance";
      adapter?: unknown;
    };
  };
  configureWhisperRuntimeAssets(runtime, requestedThreads);
  runtime.webgpu ??= {};
  runtime.webgpu.powerPreference = "high-performance";
  if (highPerformanceAdapter) runtime.webgpu.adapter = highPerformanceAdapter;
}

async function disposePipeline(pipeline: LocalWhisperPipeline | undefined) {
  if (!pipeline) return;
  try {
    await pipeline.dispose();
  } catch {
    // A failed GPU session can reject disposal after the worker has already
    // lost the context. The following CPU pipeline still gets a clean session.
  }
}

async function getPipeline(
  model: WhisperModelId,
  backend: WhisperBackend,
  onProgress: WhisperRunOptions["onProgress"],
) {
  const revision = WHISPER_MODEL_REVISIONS[model];
  const key = `${model}@${revision}:${backend}`;
  let promise = loadedPipelines.get(key);
  if (!promise) {
    promise = (async () => {
      const { pipeline } = await loadTransformers();
      const createPipeline = pipeline as unknown as (
        task: string,
        modelId: string,
        options: Record<string, unknown>,
      ) => Promise<unknown>;
      return (await createPipeline("automatic-speech-recognition", model, {
        revision,
        dtype: "q8",
        device: backend,
        progress_callback: (progress: ModelProgress) =>
          reportDownload(progress, onProgress),
      })) as LocalWhisperPipeline;
    })();
    loadedPipelines.set(key, promise);
    promise.catch(() => loadedPipelines.delete(key));
  }
  return withInitializationTimeout(promise);
}

function buildWindowSegments(output: AutomaticSpeechRecognitionOutput) {
  const supplied = output.chunks ?? [];
  if (supplied.length === 0) return [] as GeneratedCueInput[];
  return supplied.flatMap((segment) => {
    const start = segment.timestamp?.[0];
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0)
      return [];
    const candidateEnd = segment.timestamp?.[1];
    const text =
      typeof segment.text === "string"
        ? segment.text.replace(/\s+/gu, " ").trim()
        : "";
    if (!text) return [];
    const endMs =
      typeof candidateEnd === "number" && Number.isFinite(candidateEnd)
        ? candidateEnd * 1000
        : undefined;
    if (endMs !== undefined && endMs <= start * 1000) return [];
    return [
      {
        startMs: start * 1000,
        ...(endMs === undefined ? {} : { endMs }),
        text,
      },
    ];
  });
}

/**
 * Run multilingual Whisper over 30 second windows. The next window starts at
 * 26 seconds, and midpoint ownership keeps one copy of boundary phrases while
 * preserving repeated lyrics at later song times.
 */
export async function transcribeLocalWhisper(
  options: WhisperRunOptions,
): Promise<WhisperRunResult> {
  const { waveform, durationMs, model, onProgress } = options;
  if (waveform.length === 0)
    throw new Error("No audio samples are available for transcription.");
  const starts = getWindowStarts(waveform.length);
  const collected: GeneratedCue[] = [];
  const notices: string[] = [];
  let backend = options.preferredBackend;
  if (backend === "webgpu" && webgpuFailedForWorker) backend = "wasm";
  let transcriber: LocalWhisperPipeline | undefined;
  let attempts = 0;
  const startedAt = performance.now();

  try {
    onProgress({
      stage: "download",
      message: `Preparing the ${model} model runtime.`,
    });
    try {
      transcriber = await getPipeline(model, backend, onProgress);
    } catch (error) {
      if (
        backend !== "webgpu" ||
        error instanceof ModelInitializationTimeoutError
      )
        throw error;
      webgpuFailedForWorker = true;
      backend = "wasm";
      notices.push(
        "Whisper WebGPU could not start; the same model continued on the CPU.",
      );
      transcriber = await getPipeline(model, backend, onProgress);
    }

    for (let index = 0; index < starts.length; index++) {
      const startSample = starts[index]!;
      const endSample = Math.min(waveform.length, startSample + WINDOW_SAMPLES);
      const windowAudio = waveform.subarray(startSample, endSample);
      const startMs = (startSample / SAMPLE_RATE) * 1000;
      const endMs = Math.min(durationMs, (endSample / SAMPLE_RATE) * 1000);
      const previousStart = index > 0 ? starts[index - 1]! : 0;
      const nextStart = index + 1 < starts.length ? starts[index + 1]! : null;
      const previousEndMs = Math.min(
        durationMs,
        ((previousStart + WINDOW_SAMPLES) / SAMPLE_RATE) * 1000,
      );
      const ownsStartMs = index === 0 ? 0 : (previousEndMs + startMs) / 2;
      const ownsEndMs =
        nextStart === null
          ? durationMs
          : (endMs + (nextStart / SAMPLE_RATE) * 1000) / 2;
      let output: AutomaticSpeechRecognitionOutput;

      const run = async (activePipeline: LocalWhisperPipeline) => {
        attempts++;
        return (await activePipeline(windowAudio, {
          return_timestamps: true,
          task: "transcribe",
          do_sample: false,
        })) as AutomaticSpeechRecognitionOutput;
      };

      try {
        output = await run(transcriber);
      } catch (error) {
        if (backend !== "webgpu") throw error;
        const failedPipeline = transcriber;
        loadedPipelines.delete(
          `${model}@${WHISPER_MODEL_REVISIONS[model]}:webgpu`,
        );
        await disposePipeline(failedPipeline);
        webgpuFailedForWorker = true;
        backend = "wasm";
        notices.push(
          "Whisper WebGPU stopped during transcription; the same model continued on the CPU.",
        );
        transcriber = await getPipeline(model, backend, onProgress);
        output = await run(transcriber);
      }

      const ownedSegments = normalizeWindowCues(
        buildWindowSegments(output),
        { startMs, endMs, ownsStartMs, ownsEndMs },
        durationMs,
      );
      const voicedSegments = ownedSegments.filter((segment) => {
        const localStart = ((segment.startMs - startMs) / 1000) * SAMPLE_RATE;
        const localEnd = ((segment.endMs - startMs) / 1000) * SAMPLE_RATE;
        return !isNearDigitalSilence(windowAudio, localStart, localEnd);
      });
      collected.push(...voicedSegments);
      onProgress({
        stage: "transcribe",
        message: `Transcribed window ${index + 1} of ${starts.length}.`,
        completed: index + 1,
        total: starts.length,
        elapsedMs: elapsed(startedAt),
      });
    }
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error("Whisper transcription failed.");
  }

  return {
    cues: normalizeGeneratedCues(collected, durationMs),
    backend: getActualBackend(transcriber!, backend),
    chunks: starts.length,
    attempts,
    notices,
  };
}

export async function disposeWhisperPipelines() {
  const pending = [...loadedPipelines.entries()];
  loadedPipelines.clear();
  const pipelines = await Promise.all(
    pending.map(async ([, promise]) => {
      try {
        return await promise;
      } catch {
        return undefined;
      }
    }),
  );
  await Promise.all(pipelines.map((pipeline) => disposePipeline(pipeline)));
}
