import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const stage = mkdtempSync(join(tmpdir(), "pulseframe-analysis-worker-"));
process.on("exit", () => rmSync(stage, { recursive: true, force: true }));

const modules = [
  ["lib/audio-analysis-config.ts", "audio-analysis-config.mjs"],
  ["lib/audio-dsp.mjs", "audio-dsp.mjs"],
  ["lib/art-reactivity.mjs", "art-reactivity.mjs"],
  ["lib/drop-detector.mjs", "drop-detector.mjs"],
  ["lib/pcm-features.ts", "pcm-features.mjs"],
  ["lib/dsp/contracts.ts", "dsp/contracts.mjs"],
  ["lib/dsp/loader.ts", "dsp/loader.mjs"],
  ["lib/dsp/wasm-backend.ts", "dsp/wasm-backend.mjs"],
  ["lib/dsp/analysis-worker.ts", "dsp/analysis-worker.mjs"],
];

for (const [sourcePath, outputPath] of modules) {
  const source = readFileSync(new URL(sourcePath, root), "utf8");
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
import { parentPort } from 'node:worker_threads';
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
      protocolVersion: 1,
      featureSchemaVersion: 1,
      sampleRate: 48_000,
      channelCount: 2,
      totalSamples: 48_000,
      totalFrames: 30,
      retain: true,
    };
    worker.postMessage(start);
    const ready = await nextMessage();
    assert.equal(ready.type, "ready");
    assert.equal(ready.protocolVersion, start.protocolVersion);
    assert.equal(ready.featureSchemaVersion, start.featureSchemaVersion);
    assert.equal(ready.backend, "js");

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
