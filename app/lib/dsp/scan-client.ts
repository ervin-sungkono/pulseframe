import { getDspBackendPreference } from "./loader";
import analysisWorkerUrl from "./analysis-worker.ts?worker&url";
import { ANALYSIS_FPS } from "../audio-analysis-config";
import { BassReturnDetector } from "../drop-detector.mjs";
import { PcmFeatures, type SoundEnvelope } from "../pcm-features";
import {
  DSP_BAND_COUNT,
  DSP_FEATURE_COUNT,
  DSP_FEATURE_SCHEMA_VERSION,
  DSP_SCAN_BATCH_FRAMES,
  DSP_SCAN_HISTORY_SAMPLES,
  DSP_SCAN_PROTOCOL_VERSION,
  type DspScanWorkerRequest,
  type DspScanWorkerResponse,
} from "./contracts";

const MAX_CHUNK_SAMPLES = 768_000;
const WORKER_START_TIMEOUT_MS = 8_000;
const WORKER_PROGRESS_TIMEOUT_MS = 15_000;

export type PreparedAnalysis = { events: number[]; envelopes: SoundEnvelope[] };

let nextGeneration = 0;

function abortError() {
  return new DOMException("Canceled", "AbortError");
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function yieldToBrowser() {
  const scheduler = (
    globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function frameCount(samples: Float32Array[], sampleRate: number) {
  return Math.ceil(((samples[0]?.length ?? 0) / sampleRate) * ANALYSIS_FPS);
}

function createAnalysisWorker() {
  return new Worker(analysisWorkerUrl, { type: "module" });
}

function runWorkerScan(
  samples: Float32Array[],
  sampleRate: number,
  totalFrames: number,
  signal: AbortSignal | undefined,
  retain: boolean,
): Promise<PreparedAnalysis> {
  return new Promise((resolve, reject) => {
    const generation = ++nextGeneration;
    const jobId = generation;
    let worker: Worker;
    try {
      worker = createAnalysisWorker();
    } catch (error) {
      reject(error);
      return;
    }

    const events: number[] = [];
    const envelopes: SoundEnvelope[] = [];
    const totalSamples = samples[0]?.length ?? 0;
    const chunkSamples = Math.max(1, Math.min(Math.round(sampleRate * 3), MAX_CHUNK_SAMPLES));
    const historySamples = Math.max(DSP_SCAN_HISTORY_SAMPLES, Math.round(sampleRate * 0.02));
    let sampleCursor = 0;
    let nextFrame = 0;
    let expectedBatchFrame = 0;
    let expectedChunk: { sampleEnd: number; frameEnd: number } | null = null;
    let ready = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ events, envelopes });
    };
    const resetTimeout = (duration: number, phase: string) => {
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(new Error(`Audio analysis worker timed out during ${phase}.`)),
        duration,
      );
    };
    const onAbort = () => {
      try {
        worker.postMessage({ type: "cancel", generation, jobId } satisfies DspScanWorkerRequest);
      } catch {
        /* Termination below is authoritative. */
      }
      finish(abortError());
    };

    const sendNextChunk = () => {
      if (settled) return;
      if (nextFrame >= totalFrames) {
        finish();
        return;
      }
      const chunkStart = sampleCursor;
      const sampleEnd = Math.min(totalSamples, chunkStart + chunkSamples);
      let frameEnd = nextFrame;
      while (
        frameEnd < totalFrames &&
        Math.round((frameEnd / ANALYSIS_FPS) * sampleRate) < sampleEnd
      )
        frameEnd += 1;
      // The final timestamp can round onto the sample just beyond a very short buffer.
      if (sampleEnd === totalSamples) frameEnd = totalFrames;
      if (frameEnd === nextFrame) {
        finish(new Error("Audio analysis could not advance its sample chunk."));
        return;
      }

      const sourceOffsetSamples = Math.max(0, chunkStart - historySamples);
      const chunkData = samples.map((channel) => channel.slice(sourceOffsetSamples, sampleEnd));
      const buffers = chunkData.map((channel) => channel.buffer as ArrayBuffer);
      expectedBatchFrame = nextFrame;
      expectedChunk = { sampleEnd, frameEnd };
      const message: DspScanWorkerRequest = {
        type: "chunk",
        generation,
        jobId,
        sourceOffsetSamples,
        frameStart: nextFrame,
        frameEnd,
        samples: buffers,
      };
      try {
        worker.postMessage(message, buffers);
      } catch (error) {
        finish(error);
        return;
      }
      resetTimeout(WORKER_PROGRESS_TIMEOUT_MS, "a PCM chunk");
    };

    worker.onmessage = (event) => {
      if (settled) return;
      const message = event.data as DspScanWorkerResponse;
      if (!message || message.generation !== generation || message.jobId !== jobId) return;
      if (message.type === "ready") {
        if (ready) return;
        if (
          message.protocolVersion !== DSP_SCAN_PROTOCOL_VERSION ||
          message.featureSchemaVersion !== DSP_FEATURE_SCHEMA_VERSION ||
          (message.backend !== "js" && message.backend !== "wasm")
        ) {
          finish(new Error("Audio analysis worker protocol does not match this application."));
          return;
        }
        ready = true;
        sendNextChunk();
        return;
      }
      if (message.type === "error") {
        finish(new Error(message.message || "Audio analysis worker failed."));
        return;
      }
      if (message.type === "canceled") {
        finish(abortError());
        return;
      }
      if (!ready) return;
      if (message.type === "batch") {
        const start = message.frameStart;
        const count = message.frameCount;
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(count) ||
          start !== expectedBatchFrame ||
          count! < 1 ||
          count! > DSP_SCAN_BATCH_FRAMES
        ) {
          finish(new Error("Audio analysis worker returned an invalid frame batch."));
          return;
        }
        const batchEnd = start! + count!;
        if (!expectedChunk || batchEnd > expectedChunk.frameEnd) {
          finish(new Error("Audio analysis worker returned frames outside the active chunk."));
          return;
        }
        for (const frame of message.eventFrames ?? []) {
          if (!Number.isInteger(frame) || frame < start! || frame >= batchEnd) {
            finish(new Error("Audio analysis worker returned an invalid event timestamp."));
            return;
          }
          events.push(frame / ANALYSIS_FPS);
        }
        if (retain) {
          if (
            !(message.metrics instanceof ArrayBuffer) ||
            !(message.bands instanceof ArrayBuffer)
          ) {
            finish(new Error("Audio analysis worker omitted retained envelope data."));
            return;
          }
          const metricValues = new Float64Array(message.metrics);
          const bandValues = new Float32Array(message.bands);
          const channelCount = samples.length;
          if (
            metricValues.length !== count! * DSP_FEATURE_COUNT ||
            bandValues.length !== count! * channelCount * DSP_BAND_COUNT
          ) {
            finish(new Error("Audio analysis worker returned malformed envelope data."));
            return;
          }
          if (
            metricValues.some((value) => !Number.isFinite(value)) ||
            bandValues.some((value) => !Number.isFinite(value))
          ) {
            finish(new Error("Audio analysis worker returned non-finite envelope data."));
            return;
          }
          for (let localFrame = 0; localFrame < count!; localFrame += 1) {
            const metricOffset = localFrame * DSP_FEATURE_COUNT;
            const bandOffset = localFrame * channelCount * DSP_BAND_COUNT;
            const bands = Array.from(
              { length: channelCount },
              (_, channel) =>
                new Float32Array(
                  bandValues.buffer,
                  bandValues.byteOffset +
                    (bandOffset + channel * DSP_BAND_COUNT) * Float32Array.BYTES_PER_ELEMENT,
                  DSP_BAND_COUNT,
                ),
            );
            envelopes.push({
              rms: metricValues[metricOffset],
              rmsDb: metricValues[metricOffset + 1],
              bassDb: metricValues[metricOffset + 2],
              bassHitDb: metricValues[metricOffset + 3],
              ringBassDb: metricValues[metricOffset + 4],
              middleDb: metricValues[metricOffset + 5],
              highDb: metricValues[metricOffset + 6],
              bands,
            });
          }
        }
        expectedBatchFrame = batchEnd;
        resetTimeout(WORKER_PROGRESS_TIMEOUT_MS, "a PCM chunk");
        return;
      }
      if (message.type === "chunk-done") {
        if (
          !expectedChunk ||
          expectedBatchFrame !== expectedChunk.frameEnd ||
          message.nextFrame !== expectedChunk.frameEnd
        ) {
          finish(new Error("Audio analysis worker ended a chunk before all frames were returned."));
          return;
        }
        sampleCursor = expectedChunk.sampleEnd;
        nextFrame = expectedChunk.frameEnd;
        expectedChunk = null;
        if (nextFrame >= totalFrames) finish();
        else sendNextChunk();
      }
    };
    worker.onerror = (event) =>
      finish(new Error(event.message || "Audio analysis worker crashed."));
    worker.onmessageerror = () =>
      finish(new Error("Audio analysis worker returned an unreadable message."));

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    resetTimeout(WORKER_START_TIMEOUT_MS, "startup");
    try {
      worker.postMessage({
        type: "start",
        generation,
        jobId,
        protocolVersion: DSP_SCAN_PROTOCOL_VERSION,
        featureSchemaVersion: DSP_FEATURE_SCHEMA_VERSION,
        sampleRate,
        channelCount: samples.length,
        totalSamples,
        totalFrames,
        retain,
        backendPreference: getDspBackendPreference(),
      } satisfies DspScanWorkerRequest);
    } catch (error) {
      finish(error);
    }
  });
}

async function scanInline(
  samples: Float32Array[],
  sampleRate: number,
  signal: AbortSignal | undefined,
  retain: boolean,
): Promise<PreparedAnalysis> {
  if (signal?.aborted) throw abortError();
  const analyzer = new PcmFeatures(samples, sampleRate);
  const detector = new BassReturnDetector();
  const events: number[] = [];
  const envelopes: SoundEnvelope[] = [];
  const count = frameCount(samples, sampleRate);
  try {
    for (let index = 0; index < count; index += 1) {
      if (signal?.aborted) throw abortError();
      const frame = analyzer.at(index / ANALYSIS_FPS, false);
      if (detector.observe({ time: frame.time, bassDb: frame.bassDb, levelDb: frame.rmsDb }) === 1)
        events.push(frame.time);
      if (retain)
        envelopes.push({
          rms: frame.rms,
          rmsDb: frame.rmsDb,
          bassDb: frame.bassDb,
          bassHitDb: frame.bassHitDb,
          ringBassDb: frame.ringBassDb,
          middleDb: frame.middleDb,
          highDb: frame.highDb,
          bands: frame.bands.map((channel) => channel.slice()),
        });
      if (index % DSP_SCAN_BATCH_FRAMES === DSP_SCAN_BATCH_FRAMES - 1) await yieldToBrowser();
    }
    return { events, envelopes };
  } finally {
    analyzer.dispose();
  }
}

/** Analyze a track with a one-job worker and bounded, owned PCM transfers. */
export async function scanPreparedSound(
  samples: Float32Array[],
  sampleRate: number,
  signal?: AbortSignal,
  retain = false,
): Promise<PreparedAnalysis> {
  if (signal?.aborted) throw abortError();
  if (!samples.length) return { events: [], envelopes: [] };
  const totalFrames = frameCount(samples, sampleRate);
  if (totalFrames === 0) return { events: [], envelopes: [] };
  if (typeof Worker === "undefined") return scanInline(samples, sampleRate, signal, retain);
  try {
    return await runWorkerScan(samples, sampleRate, totalFrames, signal, retain);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw abortError();
    // Discard every partial worker result and restart the complete stateful scan.
    return scanInline(samples, sampleRate, signal, retain);
  }
}
