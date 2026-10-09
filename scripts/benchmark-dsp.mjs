// Measures the actual synchronous compatibility adapter, including PCM copies,
// band ownership and JS response payload creation. No decoder/encoder is involved.
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { loadSources } from "../tests/load-source.mjs";

const sources = await loadSources({ dspAssets: true });
const { PcmFeatures } = sources["audio-features"];
const loader = sources["dsp/loader"];
const originalFetch = globalThis.fetch;
globalThis.window = {};
globalThis.document = {};
globalThis.location = { href: new URL("../", import.meta.url).href };
globalThis.fetch = async (url) =>
  new Response(readFileSync(new URL(String(url))), {
    headers: { "Content-Type": "application/wasm" },
  });
try {
  if (!(await loader.initializeDsp()))
    throw loader.getDspInitializationError() ?? new Error("DSP initialization failed");
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.location;
}

const duration = Number(process.argv[2] ?? 300);
if (!(duration > 0 && duration <= 1800))
  throw new Error("Benchmark duration must be 0..1800 seconds");
const rate = 48000;
const samples = [0, 1].map((c) =>
  Float32Array.from(
    { length: Math.ceil(rate * duration) },
    (_, i) =>
      (c ? -1 : 1) *
      (0.3 * Math.sin((2 * Math.PI * 91.3 * i) / rate) +
        0.03 * Math.sin((2 * Math.PI * 3400 * i) / rate)),
  ),
);
const count = Math.ceil(duration * 30);
const measurements = {},
  analyzers = {};
try {
  for (const backend of ["js", "wasm"]) {
    analyzers[backend] = new PcmFeatures(samples, rate, 0, backend);
    if (analyzers[backend].backendMode !== backend)
      throw new Error(`Requested ${backend}, received ${analyzers[backend].backendMode}`);
    measurements[backend] = { runs: [], probes: [] };
    for (let i = 0; i < 60; i++) analyzers[backend].at(i / 30, false);
  }
  // Alternate order to reduce bias from JIT warmup and concurrent device load.
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const backend of repeat % 2 ? ["wasm", "js"] : ["js", "wasm"]) {
      const began = performance.now();
      for (let i = 0; i < count; i++) {
        const started = performance.now();
        analyzers[backend].at(i / 30, false);
        if (repeat === 2) measurements[backend].probes.push(performance.now() - started);
      }
      measurements[backend].runs.push(performance.now() - began);
    }
  }
  for (const backend of ["js", "wasm"]) {
    const { runs, probes } = measurements[backend];
    runs.sort((a, b) => a - b);
    probes.sort((a, b) => a - b);
    measurements[backend] = {
      medianScanMs: runs[1],
      p95ProbeMs: probes[Math.floor(probes.length * 0.95)],
    };
  }
} finally {
  Object.values(analyzers).forEach((analyzer) => analyzer.dispose());
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      rate,
      channels: 2,
      duration,
      frames: count,
      ...measurements,
      wasmReductionPercent:
        100 * (1 - measurements.wasm.medianScanMs / measurements.js.medianScanMs),
      limitations:
        "Node CPU benchmark; worker transfers, browser scheduling, decoder and encoder excluded",
    },
    null,
    2,
  ),
);
