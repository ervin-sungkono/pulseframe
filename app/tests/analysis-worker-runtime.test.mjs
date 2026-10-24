import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { initSync, TemporalDsp } from "../public/dsp/pulseframe_dsp.js";

const root = new URL("../", import.meta.url);
const stage = mkdtempSync(join(tmpdir(), "pulseframe-analysis-worker-"));
process.on("exit", () => rmSync(stage, { recursive: true, force: true }));
const stagedDsp = join(stage, "dsp");
mkdirSync(stagedDsp, { recursive: true });
const stagedModule = join(stagedDsp, "pulseframe_dsp.mjs");
const stagedWasm = join(stagedDsp, "pulseframe_dsp_bg.wasm");
writeFileSync(
  stagedModule,
  readFileSync(new URL("../public/dsp/pulseframe_dsp.js", import.meta.url)),
);
writeFileSync(
  stagedWasm,
  readFileSync(new URL("../public/dsp/pulseframe_dsp_bg.wasm", import.meta.url)),
);
const wasm = initSync({ module: readFileSync(stagedWasm) });

const modules = [
  ["lib/audio/audio-analysis-config.ts", "audio/audio-analysis-config.mjs"],
  ["lib/audio/audio-dsp.mjs", "audio/audio-dsp.mjs"],
  ["lib/audio/art-reactivity.mjs", "audio/art-reactivity.mjs"],
  ["lib/audio/drop-detector.mjs", "audio/drop-detector.mjs"],
  ["lib/audio/pcm-features.ts", "audio/pcm-features.mjs"],
  ["lib/dsp/contracts.ts", "dsp/contracts.mjs"],
  ["lib/dsp/loader.ts", "dsp/loader.mjs"],
  ["lib/dsp/wasm-backend.ts", "dsp/wasm-backend.mjs"],
  ["lib/dsp/analysis-worker.ts", "dsp/analysis-worker.mjs"],
];

for (const [sourcePath, outputPath] of modules) {
  let source = readFileSync(new URL(sourcePath, root), "utf8");
  if (sourcePath === "lib/dsp/loader.ts") {
    source = source
      .replace('"/dsp/pulseframe_dsp.js"', JSON.stringify(pathToFileURL(stagedModule).href))
      .replace('"/dsp/pulseframe_dsp_bg.wasm"', JSON.stringify(pathToFileURL(stagedWasm).href));
  }
  const output = sourcePath.endsWith(".ts")
    ? ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText
    : source;
  const rewritten = output.replace(
    /(from\s+|import\()(["'])(\.{1,2}\/[^"']+)\2/g,
    (match, prefix, quote, specifier) => {
      const hasExtension = /\.[a-z0-9]+$/i.test(specifier);
      return `${prefix}${quote}${hasExtension ? specifier : `${specifier}.mjs`}${quote}`;
    },
  );
  const target = join(stage, outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rewritten);
}

const bootstrapPath = join(stage, "analysis-bootstrap.mjs");
writeFileSync(
  bootstrapPath,
  `
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
globalThis.location = { href: 'https://pulseframe.test/' };
globalThis.postMessage = () => {};
if (workerData?.pauseBetweenBatches) {
  let resume;
  globalThis.scheduler = { yield: () => new Promise(resolve => { resume = resolve; }) };
  parentPort.on('message', message => {
    if (message.type === 'resume-test-batch') resume?.();
  });
}
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
    if (type === 'message') parentPort.on('message', data => listener({ data }));
  },
  postMessage(message, transfer = []) { parentPort.postMessage(message, transfer); },
};
await import('./dsp/analysis-worker.mjs');
`,
);

test("analysis worker accepts a versioned scan and returns bounded finite feature batches", async () => {
  const worker = new Worker(bootstrapPath, { type: "module" });
  const queue = [];
  const waiters = [];
  worker.on("message", (message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const nextMessage = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("analysis worker response timed out")),
        8_000,
      );
      waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };

  try {
    const start = {
      type: "start",
      generation: 1,
      jobId: 1,
      protocolVersion: 2,
      featureSchemaVersion: 1,
      sampleRate: 48_000,
      channelCount: 2,
      totalSamples: 48_000,
      totalFrames: 30,
      retain: true,
      backendPreference: "js",
    };
    worker.postMessage(start);
    const ready = await nextMessage();
    assert.equal(ready.type, "ready");
    assert.equal(ready.protocolVersion, start.protocolVersion);
    assert.equal(ready.featureSchemaVersion, start.featureSchemaVersion);
    assert.equal(ready.backend, "js");
    assert.equal(ready.temporalAvailable, false);

    const left = new Float32Array(start.totalSamples);
    const right = new Float32Array(start.totalSamples);
    for (let index = 0; index < left.length; index += 1) {
      left[index] = 0.2 * Math.sin((2 * Math.PI * 80 * index) / start.sampleRate);
      right[index] = -left[index];
    }
    worker.postMessage(
      {
        type: "chunk",
        generation: 1,
        jobId: 1,
        sourceOffsetSamples: 0,
        frameStart: 0,
        frameEnd: 30,
        samples: [left.buffer, right.buffer],
      },
      [left.buffer, right.buffer],
    );

    const batches = [];
    while (true) {
      const message = await nextMessage();
      if (message.type === "chunk-done") {
        assert.equal(message.nextFrame, 30);
        break;
      }
      assert.equal(message.type, "batch", message.message);
      assert.ok(message.frameCount <= 15);
      assert.equal(
        message.metrics.byteLength,
        message.frameCount * 7 * Float64Array.BYTES_PER_ELEMENT,
      );
      assert.equal(
        message.bands.byteLength,
        message.frameCount * 2 * 96 * Float32Array.BYTES_PER_ELEMENT,
      );
      assert.ok([...new Float64Array(message.metrics)].every(Number.isFinite));
      assert.ok([...new Float32Array(message.bands)].every(Number.isFinite));
      batches.push(message);
    }
    assert.deepEqual(
      batches.map((batch) => batch.frameCount),
      [15, 15],
    );
    assert.deepEqual(
      batches.map((batch) => batch.frameStart),
      [0, 15],
    );

    worker.postMessage({ type: "cancel", generation: 1, jobId: 1 });
    assert.equal((await nextMessage()).type, "canceled");
  } finally {
    await worker.terminate();
  }
});

function readMessages(worker) {
  const queue = [];
  const waiters = [];
  worker.on("message", (message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  return () => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("analysis worker response timed out")),
        8_000,
      );
      waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };
}

function makeClickTrack(sampleRate, seconds) {
  const samples = new Float32Array(sampleRate * seconds);
  const period = Math.round(sampleRate * 0.5);
  for (let index = sampleRate; index < samples.length; index += 1) {
    const phase = (index - sampleRate) % period;
    if (phase >= 0 && phase < 128)
      samples[index] = 0.8 * Math.exp(-phase / 20) * (phase % 2 ? -1 : 1);
  }
  return samples;
}

function directTemporal(samples, sampleRate) {
  const detector = new TemporalDsp(sampleRate);
  const rows = [];
  const events = [];
  let state = [...new Float64Array(wasm.memory.buffer, detector.output_ptr(), 7)];
  let endSample = 512;
  const observeThrough = (targetEnd) => {
    while (endSample <= targetEnd && endSample <= samples.length) {
      const input = new Float32Array(wasm.memory.buffer, detector.input_ptr(), 2048);
      const first = endSample - input.length;
      for (let index = 0; index < input.length; index += 1) {
        const sourceIndex = first + index;
        input[index] = sourceIndex >= 0 ? samples[sourceIndex] : 0;
      }
      detector.observe(endSample);
      state = [...new Float64Array(wasm.memory.buffer, detector.output_ptr(), 7)];
      if (state[1] >= 0) events.push({ time: state[1], strength: state[2] });
      endSample += 512;
    }
  };
  try {
    const count = Math.ceil((samples.length / sampleRate) * 30);
    for (let frame = 0; frame < count; frame += 1) {
      observeThrough(Math.round((frame / 30) * sampleRate));
      rows.push(state.slice());
    }
    observeThrough(samples.length);
    return { rows, events };
  } finally {
    detector.free();
  }
}

test("real WASM temporal scan stays monotone across bounded PCM chunks and keeps 30 Hz rows", async () => {
  const worker = new Worker(bootstrapPath, { type: "module" });
  const nextMessage = readMessages(worker);
  const sampleRate = 48_000;
  const samples = makeClickTrack(sampleRate, 5);
  const totalFrames = Math.ceil((samples.length / sampleRate) * 30);
  const expected = directTemporal(samples, sampleRate);
  const retained = [];
  const onsets = [];

  const collect = (message) => {
    assert.equal(message.temporalAvailable, true);
    if (message.temporal instanceof ArrayBuffer) {
      const frames = new Float64Array(message.temporal);
      for (let offset = 0; offset < frames.length; offset += 7)
        retained.push([...frames.slice(offset, offset + 7)]);
    }
    if (message.temporalEvents) {
      const values = new Float64Array(message.temporalEvents);
      for (let offset = 0; offset < values.length; offset += 2)
        onsets.push({ time: values[offset], strength: values[offset + 1] });
    }
  };

  try {
    const start = {
      type: "start",
      generation: 2,
      jobId: 2,
      protocolVersion: 2,
      featureSchemaVersion: 1,
      sampleRate,
      channelCount: 1,
      totalSamples: samples.length,
      totalFrames,
      retain: true,
    };
    worker.postMessage(start);
    const ready = await nextMessage();
    assert.equal(ready.type, "ready");
    assert.equal(ready.backend, "wasm");
    assert.equal(ready.temporalAvailable, true);

    const chunkPlan = [
      { sourceOffsetSamples: 0, sampleEnd: sampleRate * 3, frameStart: 0, frameEnd: 90 },
      {
        sourceOffsetSamples: sampleRate * 3 - 4096,
        sampleEnd: samples.length,
        frameStart: 90,
        frameEnd: totalFrames,
      },
    ];
    for (const chunk of chunkPlan) {
      const pcm = samples.slice(chunk.sourceOffsetSamples, chunk.sampleEnd);
      worker.postMessage(
        {
          type: "chunk",
          generation: 2,
          jobId: 2,
          ...chunk,
          samples: [pcm.buffer],
        },
        [pcm.buffer],
      );
      while (true) {
        const message = await nextMessage();
        if (message.type === "batch") {
          collect(message);
          assert.ok(message.frameCount <= 15);
          assert.ok(message.metrics instanceof ArrayBuffer);
          assert.ok(message.bands instanceof ArrayBuffer);
          continue;
        }
        assert.equal(message.type, "chunk-done", message.message);
        assert.equal(message.temporalAvailable, true);
        collect(message);
        break;
      }
    }

    assert.equal(retained.length, totalFrames);
    assert.equal(onsets.length, expected.events.length);
    for (let index = 0; index < retained.length; index += 1) {
      assert.ok(Math.abs(retained[index][0] - expected.rows[index][0]) < 1e-12);
      assert.deepEqual(retained[index].slice(1), expected.rows[index].slice(1));
    }
    for (let index = 0; index < onsets.length; index += 1) {
      assert.ok(Math.abs(onsets[index].time - expected.events[index].time) < 1e-12);
      assert.equal(onsets[index].strength, expected.events[index].strength);
    }
    assert.ok(onsets.length >= 7);
    for (let index = 0; index < onsets.length; index += 1)
      assert.ok(Math.abs(onsets[index].time - (1 + index * 0.5)) < 0.035);
  } finally {
    await worker.terminate();
  }
});

test("real WASM temporal analysis honors cancellation between bounded batches", async () => {
  const worker = new Worker(bootstrapPath, {
    type: "module",
    workerData: { pauseBetweenBatches: true },
  });
  const nextMessage = readMessages(worker);
  const sampleRate = 48_000;
  const totalSamples = sampleRate * 10;
  try {
    worker.postMessage({
      type: "start",
      generation: 3,
      jobId: 3,
      protocolVersion: 2,
      featureSchemaVersion: 1,
      sampleRate,
      channelCount: 1,
      totalSamples,
      totalFrames: 300,
      retain: true,
    });
    const ready = await nextMessage();
    assert.equal(ready.temporalAvailable, true);
    const pcm = makeClickTrack(sampleRate, 3);
    worker.postMessage(
      {
        type: "chunk",
        generation: 3,
        jobId: 3,
        sourceOffsetSamples: 0,
        frameStart: 0,
        frameEnd: 90,
        samples: [pcm.buffer],
      },
      [pcm.buffer],
    );
    const firstBatch = await nextMessage();
    assert.equal(firstBatch.type, "batch");
    assert.equal(firstBatch.temporalAvailable, true);
    // Hold the next batch until the worker has received cancellation. Without
    // this barrier, a fast worker can complete the chunk before the parent runs.
    worker.postMessage({ type: "cancel", generation: 3, jobId: 3 });
    worker.postMessage({ type: "resume-test-batch" });
    assert.equal((await nextMessage()).type, "canceled");
  } finally {
    await worker.terminate();
  }
});
