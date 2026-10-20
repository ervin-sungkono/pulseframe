import { ANALYSIS_FPS } from "../audio/audio-analysis-config";
import { BassReturnDetector } from "../audio/drop-detector.mjs";
import { PcmFeatures } from "../audio/pcm-features";
import { initializeDsp } from "./loader";
import {
  DSP_BAND_COUNT,
  DSP_FEATURE_COUNT,
  DSP_FEATURE_SCHEMA_VERSION,
  DSP_SCAN_BATCH_FRAMES,
  DSP_SCAN_PROTOCOL_VERSION,
  type DspScanStartMessage,
  type DspScanChunkMessage,
  type DspScanWorkerRequest,
  type DspScanWorkerResponse,
} from "./contracts";

type Job = DspScanStartMessage & {
  ready: boolean;
  busy: boolean;
  canceled: boolean;
  backend: "js" | "wasm";
  detector: BassReturnDetector;
};

const scope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<DspScanWorkerRequest>) => void,
  ): void;
  postMessage(message: DspScanWorkerResponse, transfer?: Transferable[]): void;
};

let activeJob: Job | null = null;
let yieldChannel: MessageChannel | null = null;
let pendingYield: (() => void) | null = null;

function post(
  job: Job,
  message: Omit<DspScanWorkerResponse, "generation" | "jobId">,
  transfer?: Transferable[],
) {
  scope.postMessage({ ...message, generation: job.generation, jobId: job.jobId }, transfer);
}

function matches(job: Job | null, message: { generation: number; jobId: number }) {
  return !!job && job.generation === message.generation && job.jobId === message.jobId;
}

function fail(job: Job, error: unknown) {
  if (activeJob !== job) return;
  post(job, {
    type: "error",
    message: error instanceof Error ? error.message : "Audio analysis worker failed.",
  });
  activeJob = null;
}

function finishCanceled(job: Job) {
  if (activeJob !== job) return;
  post(job, { type: "canceled" });
  activeJob = null;
}

async function beginScan(message: DspScanStartMessage) {
  if (activeJob) return;
  if (
    message.protocolVersion !== DSP_SCAN_PROTOCOL_VERSION ||
    message.featureSchemaVersion !== DSP_FEATURE_SCHEMA_VERSION ||
    !Number.isFinite(message.sampleRate) ||
    message.sampleRate <= 0 ||
    !Number.isInteger(message.channelCount) ||
    message.channelCount < 1 ||
    !Number.isInteger(message.totalSamples) ||
    message.totalSamples < 0 ||
    !Number.isInteger(message.totalFrames) ||
    message.totalFrames < 0
  ) {
    const invalidJob: Job = {
      ...message,
      ready: false,
      busy: false,
      canceled: false,
      backend: "js",
      detector: new BassReturnDetector(),
    };
    post(invalidJob, {
      type: "error",
      message: "Audio analysis worker received invalid scan settings.",
    });
    return;
  }
  const job: Job = {
    ...message,
    ready: false,
    busy: false,
    canceled: false,
    backend: "js",
    detector: new BassReturnDetector(),
  };
  activeJob = job;
  try {
    // A failed WASM load is a supported state: PcmFeatures then uses its JS backend.
    if (message.backendPreference !== "js") await initializeDsp();
    if (activeJob !== job) return;
    if (job.canceled) {
      finishCanceled(job);
      return;
    }
    const probe = new PcmFeatures(
      Array.from({ length: job.channelCount }, () => new Float32Array(0)),
      job.sampleRate,
      0,
      job.backendPreference ?? "auto",
    );
    job.backend = probe.backendMode;
    probe.dispose();
    job.ready = true;
    post(job, {
      type: "ready",
      protocolVersion: DSP_SCAN_PROTOCOL_VERSION,
      featureSchemaVersion: DSP_FEATURE_SCHEMA_VERSION,
      backend: job.backend,
    });
  } catch (error) {
    fail(job, error);
  }
}

async function yieldBetweenBatches() {
  const scheduler = (
    globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler;
  if (scheduler?.yield) {
    await scheduler.yield();
    return;
  }
  if (typeof MessageChannel !== "undefined") {
    yieldChannel ??= new MessageChannel();
    yieldChannel.port1.onmessage = () => {
      const resume = pendingYield;
      pendingYield = null;
      resume?.();
    };
    await new Promise<void>((resolve) => {
      pendingYield = resolve;
      yieldChannel!.port2.postMessage(0);
    });
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function processChunk(job: Job, message: DspScanChunkMessage) {
  if (job.busy || !job.ready || activeJob !== job) {
    fail(job, new Error("Audio analysis worker received overlapping PCM chunks."));
    return;
  }
  if (
    !Number.isInteger(message.sourceOffsetSamples) ||
    message.sourceOffsetSamples < 0 ||
    !Number.isInteger(message.frameStart) ||
    !Number.isInteger(message.frameEnd) ||
    message.frameStart < 0 ||
    message.frameEnd <= message.frameStart ||
    message.frameEnd > job.totalFrames ||
    !Array.isArray(message.samples) ||
    message.samples.length !== job.channelCount
  ) {
    fail(job, new Error("Audio analysis worker received an invalid PCM chunk."));
    return;
  }
  const samples = message.samples.map((buffer) => new Float32Array(buffer));
  const chunkLength = samples[0]?.length ?? 0;
  if (
    chunkLength < 1 ||
    samples.some((channel) => channel.length !== chunkLength) ||
    message.sourceOffsetSamples + chunkLength > job.totalSamples
  ) {
    fail(job, new Error("Audio analysis worker received malformed channel data."));
    return;
  }

  job.busy = true;
  let analyzer: PcmFeatures | null = null;
  try {
    analyzer = new PcmFeatures(
      samples,
      job.sampleRate,
      message.sourceOffsetSamples,
      job.backendPreference ?? "auto",
    );
    for (
      let batchStart = message.frameStart;
      batchStart < message.frameEnd;
      batchStart += DSP_SCAN_BATCH_FRAMES
    ) {
      if (job.canceled || activeJob !== job) {
        finishCanceled(job);
        return;
      }
      const count = Math.min(DSP_SCAN_BATCH_FRAMES, message.frameEnd - batchStart);
      const eventFrames: number[] = [];
      const metrics = job.retain ? new Float64Array(count * DSP_FEATURE_COUNT) : null;
      const bands = job.retain ? new Float32Array(count * job.channelCount * DSP_BAND_COUNT) : null;

      for (let local = 0; local < count; local += 1) {
        const index = batchStart + local;
        const frame = analyzer.at(index / ANALYSIS_FPS, false);
        if (
          job.detector.observe({ time: frame.time, bassDb: frame.bassDb, levelDb: frame.rmsDb }) ===
          1
        )
          eventFrames.push(index);
        if (metrics && bands) {
          const metricOffset = local * DSP_FEATURE_COUNT;
          metrics[metricOffset] = frame.rms;
          metrics[metricOffset + 1] = frame.rmsDb;
          metrics[metricOffset + 2] = frame.bassDb;
          metrics[metricOffset + 3] = frame.bassHitDb ?? -160;
          metrics[metricOffset + 4] = frame.ringBassDb ?? -160;
          metrics[metricOffset + 5] = frame.middleDb;
          metrics[metricOffset + 6] = frame.highDb;
          const bandOffset = local * job.channelCount * DSP_BAND_COUNT;
          for (let channel = 0; channel < job.channelCount; channel += 1) {
            const channelBands = frame.bands[channel];
            if (!channelBands || channelBands.length !== DSP_BAND_COUNT)
              throw new Error("Audio analysis worker returned an invalid band count.");
            bands.set(channelBands, bandOffset + channel * DSP_BAND_COUNT);
          }
        }
      }

      const result: Omit<DspScanWorkerResponse, "generation" | "jobId"> = {
        type: "batch",
        frameStart: batchStart,
        frameCount: count,
        eventFrames,
      };
      const transfers: Transferable[] = [];
      if (metrics && bands) {
        result.metrics = metrics.buffer;
        result.bands = bands.buffer;
        transfers.push(metrics.buffer, bands.buffer);
      }
      post(job, result, transfers);
      // Yield so cancel messages can be handled between bounded frame batches.
      await yieldBetweenBatches();
    }
    if (job.canceled || activeJob !== job) {
      finishCanceled(job);
      return;
    }
    post(job, { type: "chunk-done", nextFrame: message.frameEnd });
  } catch (error) {
    fail(job, error);
  } finally {
    analyzer?.dispose();
    job.busy = false;
  }
}

scope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "start") {
    void beginScan(message);
    return;
  }
  const job = activeJob;
  if (!matches(job, message)) return;
  if (message.type === "cancel") {
    job!.canceled = true;
    if (!job!.busy) finishCanceled(job!);
    return;
  }
  if (message.type === "chunk") void processChunk(job!, message);
});
