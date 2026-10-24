// Reproducible five-minute benchmark of the actual analysis worker. The baseline
// omits the optional TemporalDsp constructor in a temporary loader copy; the
// prepared variant stages the same worker and adapters with TemporalDsp enabled.
// PCM generation, worker startup, chunk-copy allocations, and worker batch CPU
// time are reported separately. No decoder, renderer, or encoder is involved.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import ts from "../app/node_modules/typescript/lib/typescript.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DURATION_SECONDS = Number(process.argv[3] ?? 300);
const SAMPLE_RATE = 48_000;
const FPS = 30;
const CHUNK_SECONDS = 3;
const CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_SECONDS;
const CANCEL_BATCH_YIELD_DELAY_MS = 10;
const HISTORY_SAMPLES = 4096;
const BATCH_FRAMES = 15;
const FEATURES_PER_FRAME = 7;
const BANDS_PER_CHANNEL = 96;
const TEMPORAL_FIELDS_PER_FRAME = 7;
const PAIRS = Number(process.argv[4] ?? 3);
const DEFAULT_OUTPUT = "/tmp/pulseframe-creator-analysis-benchmark.json";

if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error(`Run this benchmark with Node 24 or newer; found ${process.version}.`);
if (!Number.isFinite(DURATION_SECONDS) || DURATION_SECONDS < 30 || DURATION_SECONDS > 1800)
  throw new Error("Duration must be 30..1800 seconds; default is 300 seconds.");
if (!Number.isInteger(PAIRS) || PAIRS < 1 || PAIRS > 3)
  throw new Error("Paired runs must be 1..3; default is 3.");

const sourceModules = [
  ["app/lib/audio/audio-analysis-config.ts", "audio/audio-analysis-config.mjs"],
  ["app/lib/audio/audio-dsp.mjs", "audio/audio-dsp.mjs"],
  ["app/lib/audio/art-reactivity.mjs", "audio/art-reactivity.mjs"],
  ["app/lib/audio/drop-detector.mjs", "audio/drop-detector.mjs"],
  ["app/lib/audio/pcm-features.ts", "audio/pcm-features.mjs"],
  ["app/lib/dsp/contracts.ts", "dsp/contracts.mjs"],
  ["app/lib/dsp/loader.ts", "dsp/loader.mjs"],
  ["app/lib/dsp/wasm-backend.ts", "dsp/wasm-backend.mjs"],
  ["app/lib/dsp/analysis-worker.ts", "dsp/analysis-worker.mjs"],
];

function instrumentWorker(source) {
  const countAnchor =
    "      const count = Math.min(DSP_SCAN_BATCH_FRAMES, message.frameEnd - batchStart);";
  assert.ok(source.includes(countAnchor), "worker batch timing anchor changed");
  source = source.replace(
    countAnchor,
    `${countAnchor}\n      const benchmarkBatchStartedAt = performance.now();`,
  );
  const postAnchor = "      post(job, result, transfers);";
  assert.ok(source.includes(postAnchor), "worker batch post anchor changed");
  source = source.replace(
    postAnchor,
    `      Object.assign(result, { benchmarkElapsedMs: performance.now() - benchmarkBatchStartedAt });\n${postAnchor}`,
  );
  const yieldAnchor = "      await yieldBetweenBatches();";
  assert.ok(source.includes(yieldAnchor), "worker batch yield anchor changed");
  source = source.replace(
    yieldAnchor,
    `${yieldAnchor}\n      const benchmarkDelay = (globalThis as typeof globalThis & { __benchmarkYieldDelayMs?: number }).__benchmarkYieldDelayMs ?? 0;\n      if (benchmarkDelay > 0) await new Promise((resolve) => setTimeout(resolve, benchmarkDelay));`,
  );
  const cleanupAnchor = "    analyzer?.dispose();\n    job.busy = false;";
  assert.ok(source.includes(cleanupAnchor), "worker analyzer cleanup anchor changed");
  source = source.replace(
    cleanupAnchor,
    `${cleanupAnchor}\n    if (message.frameEnd >= job.totalFrames || (job.canceled && activeJob !== job))\n      post(job, { type: "benchmark-cleanup" });`,
  );
  const canceledAnchor = '  post(job, { type: "canceled" });';
  assert.ok(source.includes(canceledAnchor), "worker cancel response anchor changed");
  source = source.replace(
    canceledAnchor,
    '  post(job, Object.assign({ type: "canceled" }, { benchmarkCanceledWhileBusy: job.busy }));',
  );
  return source;
}

function instrumentWasmCleanup(source) {
  const disposeAnchor =
    "  dispose() {\n    if (this.disposed) return;\n    this.disposed = true;\n    try {\n      this.handle.free();";
  assert.ok(source.includes(disposeAnchor), "frame WASM cleanup anchor changed");
  const frameDispose = disposeAnchor.replace(
    "      this.handle.free();",
    '      globalThis.__benchmarkWasmFree?.("frame");\n      this.handle.free();',
  );
  source = source.replace(disposeAnchor, frameDispose);
  const temporalIndex = source.indexOf(
    disposeAnchor,
    source.indexOf(frameDispose) + frameDispose.length,
  );
  if (temporalIndex >= 0) {
    const temporalDispose = disposeAnchor.replace(
      "      this.handle.free();",
      '      globalThis.__benchmarkWasmFree?.("temporal");\n      this.handle.free();',
    );
    source = `${source.slice(0, temporalIndex)}${temporalDispose}${source.slice(temporalIndex + disposeAnchor.length)}`;
  }
  return source;
}

function rewriteRelativeImports(code) {
  return code.replace(
    /(from\s+|import\()(["'])(\.{1,2}\/[^"']+)\2/g,
    (match, prefix, quote, specifier) => {
      const hasExtension = /\.[a-z0-9]+$/i.test(specifier);
      return `${prefix}${quote}${hasExtension ? specifier : `${specifier}.mjs`}${quote}`;
    },
  );
}

function stageVariant(stageRoot, name, omitTemporalBinding) {
  const stage = join(stageRoot, name);
  const stagedDsp = join(stage, "dsp");
  mkdirSync(stagedDsp, { recursive: true });
  const stagedModule = join(stagedDsp, "pulseframe_dsp.mjs");
  const stagedWasm = join(stagedDsp, "pulseframe_dsp_bg.wasm");
  cpSync(join(ROOT, "app/public/dsp/pulseframe_dsp.js"), stagedModule);
  cpSync(join(ROOT, "app/public/dsp/pulseframe_dsp_bg.wasm"), stagedWasm);

  for (const [repoPath, outputPath] of sourceModules) {
    let source = readFileSync(join(ROOT, repoPath), "utf8");
    if (repoPath === "app/lib/dsp/loader.ts") {
      source = source
        .replace('"/dsp/pulseframe_dsp.js"', JSON.stringify(pathToFileURL(stagedModule).href))
        .replace('"/dsp/pulseframe_dsp_bg.wasm"', JSON.stringify(pathToFileURL(stagedWasm).href));
      if (omitTemporalBinding) {
        const moduleAnchor =
          "  const dspModule: DspModule = { ...imported, memory: initialized.memory };";
        assert.ok(source.includes(moduleAnchor), "optional TemporalDsp loader seam changed");
        source = source.replace(moduleAnchor, `${moduleAnchor}\n  delete dspModule.TemporalDsp;`);
      }
    }
    if (repoPath === "app/lib/dsp/wasm-backend.ts") source = instrumentWasmCleanup(source);
    if (repoPath === "app/lib/dsp/analysis-worker.ts") source = instrumentWorker(source);
    const output = repoPath.endsWith(".ts")
      ? ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText
      : source;
    const target = join(stage, outputPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rewriteRelativeImports(output));
  }

  const bootstrapPath = join(stage, "analysis-bootstrap.mjs");
  writeFileSync(
    bootstrapPath,
    `
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const benchmarkFreeCalls = { frame: 0, temporal: 0 };
globalThis.__benchmarkWasmFree = kind => { benchmarkFreeCalls[kind] += 1; };
globalThis.location = { href: 'https://pulseframe.test/' };
globalThis.postMessage = () => {};
Object.defineProperty(globalThis, 'constructor', { configurable: true, value: { name: 'TemporalWorkerGlobalScope' } });
globalThis.fetch = async input => {
  const url = input instanceof URL ? input : new URL(String(input));
  url.search = '';
  return new Response(readFileSync(fileURLToPath(url)), {
    headers: { 'Content-Type': 'application/wasm' },
  });
};
globalThis.self = {
  addEventListener(type, listener) {
    if (type === 'message') parentPort.on('message', data => {
      if (data?.type === 'start' && Number.isFinite(data.benchmarkYieldDelayMs))
        globalThis.__benchmarkYieldDelayMs = data.benchmarkYieldDelayMs;
      listener({ data });
    });
  },
  postMessage(message, transfer = []) {
    parentPort.postMessage({ ...message, benchmarkWasmFreeCalls: { ...benchmarkFreeCalls } }, transfer);
  },
};
await import('./dsp/analysis-worker.mjs');
`,
  );
  return { name, bootstrapPath, baseline: omitTemporalBinding };
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index];
}

function summarize(values) {
  if (!values.length) return { p50: null, p95: null };
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function makePcm(channelCount, silence) {
  const sampleCount = SAMPLE_RATE * DURATION_SECONDS;
  const generatedAt = performance.now();
  const channels = Array.from({ length: channelCount }, () => new Float32Array(sampleCount));
  if (!silence) {
    const table = new Float32Array(600);
    for (let index = 0; index < table.length; index += 1)
      table[index] = Math.sin((2 * Math.PI * index) / table.length);
    const pulsePeriod = SAMPLE_RATE / 2;
    for (let index = 0; index < sampleCount; index += 1) {
      const phase = index % table.length;
      const pulsePhase = index >= SAMPLE_RATE ? (index - SAMPLE_RATE) % pulsePeriod : -1;
      const pulse =
        pulsePhase >= 0 && pulsePhase < 128
          ? 0.58 * Math.exp(-pulsePhase / 22) * (pulsePhase % 2 ? -1 : 1)
          : 0;
      for (let channel = 0; channel < channelCount; channel += 1) {
        const shift = channel === 1 ? 13 : 0;
        const tone =
          0.24 * table[(phase + shift) % table.length] +
          0.1 * table[(phase * 5 + shift) % table.length] +
          0.045 * table[(phase * 15 + shift) % table.length];
        channels[channel][index] = tone + pulse * (channel === 1 ? 0.82 : 1);
      }
    }
  }
  return {
    channels,
    preparationMs: performance.now() - generatedAt,
    sourcePcmBytes: channels.reduce((sum, channel) => sum + channel.byteLength, 0),
  };
}

function makeChunkPlan(totalSamples, totalFrames) {
  const chunks = [];
  let sampleCursor = 0;
  let nextFrame = 0;
  while (nextFrame < totalFrames) {
    const chunkStart = sampleCursor;
    const sampleEnd = Math.min(totalSamples, chunkStart + CHUNK_SAMPLES);
    let frameEnd = nextFrame;
    while (frameEnd < totalFrames && Math.round((frameEnd / FPS) * SAMPLE_RATE) < sampleEnd)
      frameEnd += 1;
    if (sampleEnd === totalSamples) frameEnd = totalFrames;
    assert.ok(frameEnd > nextFrame, "PCM chunk plan must advance frame coverage");
    const sourceOffsetSamples = Math.max(0, chunkStart - HISTORY_SAMPLES);
    chunks.push({ sourceOffsetSamples, sampleEnd, frameStart: nextFrame, frameEnd });
    sampleCursor = sampleEnd;
    nextFrame = frameEnd;
  }
  return chunks;
}

function makeMessageReader(worker) {
  const queued = [];
  const waiters = [];
  let workerError = null;
  worker.on("message", (message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queued.push(message);
  });
  worker.on("error", (error) => {
    workerError = error;
    while (waiters.length) waiters.shift()({ type: "benchmark-worker-error", error });
  });
  return (context = "worker response") => {
    if (workerError) return Promise.reject(workerError);
    if (queued.length) return Promise.resolve(queued.shift());
    return new Promise((resolveMessage, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`analysis worker benchmark response timed out while waiting for ${context}`),
          ),
        180_000,
      );
      waiters.push((message) => {
        clearTimeout(timer);
        if (message.type === "benchmark-worker-error") reject(message.error);
        else resolveMessage(message);
      });
    });
  };
}

function addPayload(payload, message) {
  if (message.metrics instanceof ArrayBuffer)
    payload.legacyMetricBytes += message.metrics.byteLength;
  if (message.bands instanceof ArrayBuffer) payload.legacyBandBytes += message.bands.byteLength;
  if (message.temporal instanceof ArrayBuffer)
    payload.temporalFrameBytes += message.temporal.byteLength;
  if (message.temporalEvents instanceof ArrayBuffer) {
    payload.temporalEventBytes += message.temporalEvents.byteLength;
    payload.temporalEventCount +=
      message.temporalEvents.byteLength / Float64Array.BYTES_PER_ELEMENT / 2;
  }
  payload.dropEventCount += message.eventFrames?.length ?? 0;
  if (Number.isFinite(message.benchmarkElapsedMs)) payload.batchMs.push(message.benchmarkElapsedMs);
  if (message.benchmarkWasmFreeCalls) payload.lastFreeCalls = message.benchmarkWasmFreeCalls;
}

function newPayload() {
  return {
    legacyMetricBytes: 0,
    legacyBandBytes: 0,
    temporalFrameBytes: 0,
    temporalEventBytes: 0,
    temporalEventCount: 0,
    dropEventCount: 0,
    batchMs: [],
    lastFreeCalls: { frame: 0, temporal: 0 },
    chunkPcmCopyBytes: 0,
    chunkPcmCopyMs: 0,
  };
}

async function startWorker(variant, channelCount = 1, benchmarkOptions = {}) {
  const createdAt = performance.now();
  const worker = new Worker(variant.bootstrapPath, { type: "module" });
  const nextMessage = makeMessageReader(worker);
  const baseline = variant.baseline;
  const totalSamples = SAMPLE_RATE * DURATION_SECONDS;
  const totalFrames = Math.ceil(DURATION_SECONDS * FPS);
  worker.postMessage({
    type: "start",
    generation: 1,
    jobId: 1,
    protocolVersion: 2,
    featureSchemaVersion: 1,
    sampleRate: SAMPLE_RATE,
    channelCount,
    totalSamples,
    totalFrames,
    retain: true,
    ...benchmarkOptions,
  });
  const ready = await nextMessage(`${variant.name} ready`);
  assert.equal(ready.type, "ready", ready.message);
  assert.equal(ready.backend, "wasm", "benchmark must activate the real FrameDsp WASM backend");
  if (!baseline) assert.equal(ready.temporalAvailable, true, "TemporalDsp must activate in WASM");
  return { worker, nextMessage, readyMs: performance.now() - createdAt };
}

async function runScan(variant, channels, workloadName = "unknown") {
  const channelCount = channels.length;
  const totalSamples = channels[0].length;
  const totalFrames = Math.ceil((totalSamples / SAMPLE_RATE) * FPS);
  const chunkPlan = makeChunkPlan(totalSamples, totalFrames);
  const { worker, nextMessage, readyMs } = await startWorker(variant, channelCount);
  console.log(`scan started: ${workloadName} ${variant.name}`);
  const payload = newPayload();
  const scanStartedAt = performance.now();
  let scanFinishedAt = null;
  let chunkDoneCount = 0;
  try {
    for (const [chunkIndex, chunk] of chunkPlan.entries()) {
      const copyStartedAt = performance.now();
      const pcm = channels.map((channel) =>
        channel.slice(chunk.sourceOffsetSamples, chunk.sampleEnd),
      );
      payload.chunkPcmCopyMs += performance.now() - copyStartedAt;
      payload.chunkPcmCopyBytes += pcm.reduce((sum, part) => sum + part.byteLength, 0);
      const buffers = pcm.map((part) => part.buffer);
      worker.postMessage(
        {
          type: "chunk",
          generation: 1,
          jobId: 1,
          ...chunk,
          samples: buffers,
        },
        buffers,
      );
      while (true) {
        const message = await nextMessage(
          `${workloadName} ${variant.name} chunk ${chunkIndex + 1}/${chunkPlan.length}`,
        );
        assert.notEqual(message.type, "error", message.message);
        if (message.type === "batch") {
          addPayload(payload, message);
          continue;
        }
        if (message.type === "chunk-done") {
          addPayload(payload, message);
          assert.equal(message.nextFrame, chunk.frameEnd);
          chunkDoneCount += 1;
          if (chunkIndex === chunkPlan.length - 1) scanFinishedAt = performance.now();
          break;
        }
        assert.equal(
          message.type,
          "benchmark-worker-error",
          `Unexpected worker message ${message.type}`,
        );
      }
    }
    const cleanup = await nextMessage(`${workloadName} ${variant.name} final cleanup`);
    const cleanupVerificationMs = performance.now() - scanFinishedAt;
    assert.equal(cleanup.type, "benchmark-cleanup", cleanup.message);
    addPayload(payload, cleanup);
    payload.cleanupVerificationMs = cleanupVerificationMs;
  } finally {
    await worker.terminate();
  }
  const expectedFrameFrees = chunkPlan.length + 1; // One probe plus one analyzer per bounded PCM chunk.
  assert.equal(
    chunkDoneCount,
    chunkPlan.length,
    "worker chunk-done count must match the production protocol plan",
  );
  assert.equal(
    payload.lastFreeCalls.frame,
    expectedFrameFrees,
    "FrameDsp adapters must free once per handle",
  );
  assert.equal(
    payload.lastFreeCalls.temporal,
    variant.baseline ? 0 : 1,
    "TemporalDsp must free once at scan end",
  );
  assert.equal(
    payload.legacyMetricBytes,
    totalFrames * FEATURES_PER_FRAME * Float64Array.BYTES_PER_ELEMENT,
  );
  assert.equal(
    payload.legacyBandBytes,
    totalFrames * channelCount * BANDS_PER_CHANNEL * Float32Array.BYTES_PER_ELEMENT,
  );
  if (!variant.baseline) {
    assert.equal(
      payload.temporalFrameBytes,
      totalFrames * TEMPORAL_FIELDS_PER_FRAME * Float64Array.BYTES_PER_ELEMENT,
    );
    assert.equal(
      payload.temporalEventBytes,
      payload.temporalEventCount * 2 * Float64Array.BYTES_PER_ELEMENT,
    );
  } else {
    assert.equal(payload.temporalFrameBytes, 0);
    assert.equal(payload.temporalEventBytes, 0);
  }
  console.log(
    `scan finished: ${workloadName} ${variant.name} ${Math.round(scanFinishedAt - scanStartedAt)} ms`,
  );
  return {
    workerReadyMs: readyMs,
    fullScanMs: scanFinishedAt - scanStartedAt,
    ...payload,
    batchSummary: summarize(payload.batchMs),
    chunkCount: chunkPlan.length,
    chunkDoneCount,
    cleanupVerificationMs: payload.cleanupVerificationMs,
  };
}

async function runCancellation(variant) {
  const { worker, nextMessage, readyMs } = await startWorker(variant, 1, {
    benchmarkYieldDelayMs: CANCEL_BATCH_YIELD_DELAY_MS,
  });
  console.log(`cancellation worker ready: ${variant.name}`);
  const samples = new Float32Array(CHUNK_SAMPLES);
  for (let index = SAMPLE_RATE; index < samples.length; index += 1) {
    const phase = (index - SAMPLE_RATE) % (SAMPLE_RATE / 2);
    if (phase < 128) samples[index] = 0.58 * Math.exp(-phase / 22) * (phase % 2 ? -1 : 1);
  }
  const startedAt = performance.now();
  try {
    let cancelPostedAt = null;
    const firstBatch = nextMessage(`${variant.name} cancellation first batch`);
    const cancelOnFirstBatch = (message) => {
      if (message.type !== "batch" || cancelPostedAt !== null) return;
      cancelPostedAt = performance.now();
      worker.postMessage({ type: "cancel", generation: 1, jobId: 1 });
    };
    worker.on("message", cancelOnFirstBatch);
    worker.postMessage(
      {
        type: "chunk",
        generation: 1,
        jobId: 1,
        sourceOffsetSamples: 0,
        frameStart: 0,
        frameEnd: CHUNK_SECONDS * FPS,
        samples: [samples.buffer],
      },
      [samples.buffer],
    );
    const first = await firstBatch;
    assert.equal(first.type, "batch", first.message);
    console.log(`cancellation first batch received: ${variant.name}`);
    worker.off("message", cancelOnFirstBatch);
    let canceled;
    do {
      canceled = await nextMessage(`${variant.name} cancellation acknowledgment`);
      if (canceled.type === "chunk-done")
        throw new Error(`${variant.name} cancellation arrived after the bounded chunk completed`);
    } while (canceled.type !== "canceled");
    assert.equal(
      canceled.benchmarkCanceledWhileBusy,
      true,
      "cancel must interrupt active worker chunk processing",
    );
    console.log(`cancellation acknowledged: ${variant.name}`);
    const cancelLatencyMs = performance.now() - cancelPostedAt;
    const cleanup = await nextMessage(`${variant.name} cancellation cleanup`);
    assert.equal(cleanup.type, "benchmark-cleanup");
    console.log(`cancellation cleanup received: ${variant.name}`);
    assert.equal(cleanup.benchmarkWasmFreeCalls.frame, 2);
    assert.equal(cleanup.benchmarkWasmFreeCalls.temporal, variant.baseline ? 0 : 1);
    return {
      workerReadyMs: readyMs,
      timeToFirstBatchMs: cancelPostedAt - startedAt,
      cancelToCanceledMs: cancelLatencyMs,
      frameHandlesFreed: cleanup.benchmarkWasmFreeCalls.frame,
      temporalHandlesFreed: cleanup.benchmarkWasmFreeCalls.temporal,
      cancellationAcknowledged: true,
    };
  } finally {
    await worker.terminate();
  }
}

function summarizeVariant(runs) {
  const batches = runs.flatMap((run) => run.batchMs);
  return {
    warmupsExcluded: 1,
    pairedRuns: runs.length,
    fullScanMs: summarize(runs.map((run) => run.fullScanMs)),
    totalFullScanMs: runs.reduce((sum, run) => sum + run.fullScanMs, 0),
    workerReadyMs: summarize(runs.map((run) => run.workerReadyMs)),
    batchCpuMs: summarize(batches),
    batchCountPerRun: runs.map((run) => run.batchMs.length),
    batchPcmCopyMs: summarize(runs.map((run) => run.chunkPcmCopyMs)),
    retainedPayloadBytesPerRun: {
      legacyMetrics: runs.map((run) => run.legacyMetricBytes),
      legacyBands: runs.map((run) => run.legacyBandBytes),
      temporalFrames: runs.map((run) => run.temporalFrameBytes),
      temporalEvents: runs.map((run) => run.temporalEventBytes),
    },
    temporalEventsPerRun: runs.map((run) => run.temporalEventCount),
    dropDetectorEventsPerRun: runs.map((run) => run.dropEventCount),
    pcmChunkCopyBytesPerRun: runs.map((run) => run.chunkPcmCopyBytes),
    wasmFreeCallsPerRun: runs.map((run) => run.lastFreeCalls),
    productionChunkDoneMessagesPerRun: runs.map((run) => run.chunkDoneCount),
    rawRuns: runs.map(({ batchMs, ...run }) => ({ ...run, batchMsSummary: summarize(batchMs) })),
  };
}

async function benchmarkWorkload(variants, channelCount, silence) {
  const label = `${channelCount === 1 ? "mono" : "stereo"}-${silence ? "silence" : "pulse-tone"}`;
  const prepared = makePcm(channelCount, silence);
  const byVariant = Object.fromEntries(variants.map((variant) => [variant.name, []]));
  const warmupOrder = variants;
  console.log(
    `workload prepared: ${label}; ${Math.round(prepared.preparationMs)} ms, ${prepared.sourcePcmBytes} PCM bytes`,
  );
  for (const variant of warmupOrder) await runScan(variant, prepared.channels, `${label} warmup`);

  for (let pair = 0; pair < PAIRS; pair += 1) {
    const order = pair % 2 === 0 ? variants : [...variants].reverse();
    for (const variant of order)
      byVariant[variant.name].push(
        await runScan(variant, prepared.channels, `${label} pair ${pair + 1}`),
      );
  }
  const chunkCount = makeChunkPlan(SAMPLE_RATE * DURATION_SECONDS, DURATION_SECONDS * FPS).length;
  return {
    name: label,
    durationSeconds: DURATION_SECONDS,
    sampleRate: SAMPLE_RATE,
    channelCount,
    sourcePcmBytes: prepared.sourcePcmBytes,
    pcmPreparationMs: prepared.preparationMs,
    chunkPlan: {
      chunkSeconds: CHUNK_SECONDS,
      chunks: chunkCount,
      maximumPcmChunkSamples: CHUNK_SAMPLES + HISTORY_SAMPLES,
      batchFrames: BATCH_FRAMES,
    },
    baseline: summarizeVariant(byVariant.baseline),
    prepared: summarizeVariant(byVariant.prepared),
  };
}

async function main() {
  const outputPath = resolve(process.argv[2] ?? DEFAULT_OUTPUT);
  const stageRoot = mkdtempSync(join(tmpdir(), "pulseframe-prepared-analysis-"));
  const startedAt = new Date().toISOString();
  try {
    const variants = [
      stageVariant(stageRoot, "baseline", true),
      stageVariant(stageRoot, "prepared", false),
    ];
    variants[0].name = "baseline";
    variants[1].name = "prepared";
    const workloads = [];
    for (const channelCount of [1, 2]) {
      for (const silence of [false, true]) {
        workloads.push(await benchmarkWorkload(variants, channelCount, silence));
      }
    }
    const cancellations = {};
    for (const variant of variants) {
      console.log(`cancellation started: ${variant.name}`);
      cancellations[variant.name] = await runCancellation(variant);
    }
    const result = {
      benchmark: "prepared-analysis-worker",
      startedAt,
      completedAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
        wasmAssets: "checked-in app/public/dsp assets",
        actualWorker: true,
      },
      method: {
        baselineSource:
          "working-tree worker and FrameDsp adapters with TemporalDsp omitted from the staged optional WASM binding",
        preparedSource:
          "working-tree app/lib/dsp and app/lib/audio/pcm-features.ts with the compiled TemporalDsp binding",
        pairedRuns: PAIRS,
        durationSeconds: DURATION_SECONDS,
        warmups: 1,
        order: "alternating paired order by workload",
        pcmChunkSeconds: CHUNK_SECONDS,
        batchFrames: BATCH_FRAMES,
        pcmDataPreparationIsSeparate: true,
        batchCpuTiming:
          "benchmark-only performance.now() instrumentation around worker batch computation and output allocation, before postMessage",
        retainedPayloadAccounting:
          "exact typed-array payload bytes transferred by the worker; excludes JS object/array overhead in the prepared result",
      },
      workloads,
      cancellation: {
        method: `cancel after the first 15-frame response from a bounded ${CHUNK_SECONDS}-second chunk of a ${DURATION_SECONDS}-second job; temporary Node scheduling window ${CANCEL_BATCH_YIELD_DELAY_MS} ms`,
        variants: cancellations,
      },
      limitations: [
        "Node 24 on this host only; results do not represent mobile devices or browsers.",
        "The benchmark covers source PCM already prepared for the worker; decoding, rendering, preview cadence, and export encoding are excluded.",
        "Worker output byte counts are typed payload sizes and exclude JavaScript retained-object overhead.",
        "No audio-response, renderer, preview, or export gains are inferred from these DSP timings.",
      ],
    };
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      JSON.stringify({
        outputPath,
        completedAt: result.completedAt,
        workloadCount: workloads.length,
      }),
    );
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

await main();
