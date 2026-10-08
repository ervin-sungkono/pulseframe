import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSources } from "./load-source.mjs";
import { generateDemo } from "../lib/audio-dsp.mjs";
import { BassReturnDetector } from "../lib/drop-detector.mjs";

const modules = await loadSources({ dspAssets: true });
const { PcmFeatures } = modules["audio-features"];
const loader = modules["dsp/loader"];
const previousFetch = globalThis.fetch;
globalThis.window = {};
globalThis.document = {};
globalThis.location = { href: new URL("../", import.meta.url).href };
globalThis.fetch = async (url) =>
  new Response(readFileSync(new URL(String(url))), {
    headers: { "Content-Type": "application/wasm" },
  });
try {
  assert.equal(await loader.initializeDsp(), true, loader.getDspInitializationError()?.message);
} finally {
  globalThis.fetch = previousFetch;
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.location;
}

const rate = 48000;
const samples = [0, 1].map((c) =>
  Float32Array.from(
    { length: rate * 4 },
    (_, i) =>
      (c ? -0.7 : 1) *
      (0.4 * Math.sin((2 * Math.PI * 83.7 * i) / rate) +
        0.08 * Math.sin((2 * Math.PI * 930 * i) / rate)),
  ),
);
function compare(a, b) {
  for (const key of ["rms", "rmsDb", "bassDb", "bassHitDb", "ringBassDb", "middleDb", "highDb"]) {
    if (a[key] < -120 && b[key] < -120) continue;
    assert.ok(Math.abs(a[key] - b[key]) < 1e-4, `${key}: ${a[key]} vs ${b[key]}`);
  }
  a.bands.forEach((channel, c) =>
    channel.forEach((n, i) => assert.ok(Math.abs(n - b.bands[c][i]) < 2e-7, `band ${c}:${i}`)),
  );
  assert.deepEqual(a.wave, b.wave);
  assert.deepEqual(a.waveform, b.waveform);
  a.frequency.forEach((n, i) => assert.ok(Math.abs(n - b.frequency[i]) <= 1, `frequency ${i}`));
}

test("compiled adapter preserves preview and exact off-grid export probes after arbitrary seeks", () => {
  const js = new PcmFeatures(samples, rate, 0, "js");
  const rust = new PcmFeatures(samples, rate, 0, "wasm");
  try {
    for (const fps of [24, 30, 60]) {
      for (const time of [0, 1 / fps, 0.0416667, 3.739, 2.1, 1.01, 3.999, 4.031])
        compare(js.at(time), rust.at(time));
    }
  } finally {
    js.dispose();
    rust.dispose();
  }
});

test("compiled adapter refreshes grown memory and retained bands remain owned", () => {
  const analyzer = new PcmFeatures(samples, rate, 0, "wasm");
  try {
    const first = analyzer.at(0.2, false);
    const retained = first.bands.map((b) => b.slice());
    loader.getInitializedDspModule().memory.grow(1);
    const second = analyzer.at(1.3, false);
    assert.ok(Number.isFinite(second.rms));
    assert.deepEqual(first.bands, retained);
  } finally {
    analyzer.dispose();
    analyzer.dispose();
  }
  assert.throws(() => analyzer.at(0.2), /disposed/);
});

test("a trapped automatic backend is freed once and falls back without repeated WASM calls", () => {
  const bindings = loader.getInitializedDspModule();
  const originalAnalyze = bindings.FrameDsp.prototype.analyze;
  const originalFree = bindings.FrameDsp.prototype.free;
  let analyzed = 0,
    freed = 0;
  bindings.FrameDsp.prototype.analyze = function () {
    analyzed++;
    throw new WebAssembly.RuntimeError("injected trap");
  };
  bindings.FrameDsp.prototype.free = function () {
    freed++;
    return originalFree.call(this);
  };
  const auto = new PcmFeatures(samples, rate);
  const js = new PcmFeatures(samples, rate, 0, "js");
  try {
    compare(js.at(0.4), auto.at(0.4));
    compare(js.at(0.8), auto.at(0.8));
    assert.equal(analyzed, 1);
    assert.equal(freed, 1);
  } finally {
    auto.dispose();
    js.dispose();
    bindings.FrameDsp.prototype.analyze = originalAnalyze;
    bindings.FrameDsp.prototype.free = originalFree;
  }
  assert.equal(freed, 1);
});

test("internal URL rollback forces JavaScript frames even when WASM is already loaded", async () => {
  const priorLocation = globalThis.location;
  globalThis.location = { href: "https://pulseframe.test/?dsp=js" };
  const analyzer = new PcmFeatures(samples, rate);
  try {
    assert.equal(await loader.initializeDsp(), false);
    assert.equal(analyzer.backendMode, "js");
    assert.ok(Number.isFinite(analyzer.at(0.5, false).rms));
  } finally {
    analyzer.dispose();
    if (priorLocation === undefined) delete globalThis.location;
    else globalThis.location = priorLocation;
  }
});

test("compiled analysis preserves the complete legacy bass-return event timeline", () => {
  const pcm = generateDemo(48000, 18);
  const analyzers = ["js", "wasm"].map((mode) => new PcmFeatures(pcm, 48000, 0, mode));
  const detectors = [new BassReturnDetector(), new BassReturnDetector()];
  const events = [[], []];
  try {
    for (let frame = 0; frame < 18 * 30; frame++) {
      analyzers.forEach((analyzer, i) => {
        const sound = analyzer.at(frame / 30, false);
        if (
          detectors[i].observe({ time: sound.time, bassDb: sound.bassDb, levelDb: sound.rmsDb }) ===
          1
        )
          events[i].push(sound.time);
      });
    }
    assert.ok(
      events[0].some((time) => time >= 15 && time < 16),
      "annotated demo bass return must be detected",
    );
    assert.deepEqual(events[1], events[0]);
  } finally {
    analyzers.forEach((analyzer) => analyzer.dispose());
  }
});

test("disposing a retained frame model releases borrowed PCM references without altering its source", () => {
  const source = samples.slice();
  const analyzer = new PcmFeatures(source, rate, 0, "wasm");
  analyzer.dispose();
  assert.equal(analyzer.samples.length, 0);
  assert.equal(source.length, 2);
  assert.equal(source[0], samples[0]);
  assert.equal(source[0].buffer.byteLength, samples[0].buffer.byteLength);
});
