import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources({ dspAssets: true });
const loader = modules["dsp/loader"];
const { WasmTemporalBackend, createWasmTemporalBackend } = modules["dsp/wasm-backend"];
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

const sampleRate = 48_000;

function feed(backend, samples, afterEach) {
  const events = [];
  for (let end = 512; end <= samples.length; end += 512) {
    const input = backend.inputView();
    const first = end - input.length;
    for (let index = 0; index < input.length; index += 1) {
      const sourceIndex = first + index;
      input[index] = sourceIndex >= 0 ? samples[sourceIndex] : 0;
    }
    const metrics = backend.observe(end);
    afterEach?.(metrics, end);
    if (metrics[1] >= 0) events.push({ time: metrics[1], strength: metrics[2] });
  }
  return events;
}

test("optional temporal binding activates, detects causal events, and stays silent", () => {
  const backend = createWasmTemporalBackend(sampleRate);
  assert.ok(backend);
  const silence = new Float32Array(sampleRate * 5);
  try {
    const silentEvents = feed(backend, silence);
    assert.deepEqual(silentEvents, []);
    assert.deepEqual([...backend.snapshot()].slice(1, 6), [-1, 0, 0, 0, 0]);

    backend.reset();
    const clicks = new Float32Array(sampleRate * 10);
    const period = Math.round(sampleRate * 0.5);
    for (let index = sampleRate; index < clicks.length; index += 1) {
      const phase = (index - sampleRate) % period;
      if (phase >= 0 && phase < 128)
        clicks[index] = 0.8 * Math.exp(-phase / 20) * (phase % 2 ? -1 : 1);
    }
    const events = feed(backend, clicks);
    assert.equal(events.length, 18);
    for (let index = 0; index < events.length; index += 1)
      assert.ok(Math.abs(events[index].time - (1 + index * 0.5)) < 0.035);
  } finally {
    backend.dispose();
  }
});

test("temporal adapter refreshes grown memory and frees its handle exactly once", () => {
  const bindings = loader.getInitializedDspModule();
  const temporal = new WasmTemporalBackend(sampleRate, bindings);
  const first = temporal.observe(512);
  const inputBeforeGrowth = temporal.inputView();
  bindings.memory.grow(1);
  const inputAfterGrowth = temporal.inputView();
  assert.notEqual(inputAfterGrowth.buffer, inputBeforeGrowth.buffer);
  inputAfterGrowth.fill(0);
  const second = temporal.observe(1024);
  assert.equal(first.length, 7);
  assert.equal(second.length, 7);
  assert.ok([...first].every(Number.isFinite));
  assert.ok([...second].every(Number.isFinite));

  const Constructor = bindings.TemporalDsp;
  const originalFree = Constructor.prototype.free;
  let frees = 0;
  Constructor.prototype.free = function () {
    frees += 1;
    return originalFree.call(this);
  };
  const owned = new WasmTemporalBackend(sampleRate, bindings);
  try {
    owned.dispose();
    owned.dispose();
    assert.equal(frees, 1);
  } finally {
    owned.dispose();
    temporal.dispose();
    Constructor.prototype.free = originalFree;
  }
});

test("JavaScript prepared scans keep energy metrics and mark temporal data unavailable", async () => {
  const { prepareSound } = modules["audio-features"];
  const previousWorker = globalThis.Worker;
  const previousLocation = globalThis.location;
  globalThis.Worker = undefined;
  globalThis.location = { href: "https://pulseframe.test/?dsp=js" };
  class TestAudioBuffer {
    constructor() {
      this.sampleRate = sampleRate;
      this.numberOfChannels = 1;
      this.length = sampleRate;
      this.duration = 1;
      this.channel = Float32Array.from(
        { length: sampleRate },
        (_, index) => 0.25 * Math.sin((2 * Math.PI * 80 * index) / sampleRate),
      );
    }
    getChannelData() {
      return this.channel;
    }
  }

  try {
    const prepared = await prepareSound(new TestAudioBuffer());
    assert.equal(prepared.envelopes.length, 30);
    assert.ok(prepared.envelopes.some((frame) => frame.rms > 0));
    assert.deepEqual(prepared.temporal, { available: false, frames: [], events: [] });
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test("temporalAt reads only prepared source-time data and returns onset envelope/confidence", async () => {
  const { temporalAt } = modules["audio-features"];
  const frame = (time, confidence) => ({
    time,
    flux: 0.1,
    onsetTime: null,
    onsetStrength: 0,
    bpm: 120,
    phase: 0.5,
    confidence,
    latency: 0.05,
  });
  const prepared = {
    temporal: {
      available: true,
      frames: [frame(0, 0.2), frame(1 / 30, 0.6)],
      events: [{ time: 0.02, strength: 0.8 }],
    },
  };
  const sample = temporalAt(prepared, 0.05);
  assert.equal(sample.time, 1 / 30);
  assert.equal(sample.confidence, 0.6);
  assert.ok(Math.abs(sample.onsetEnvelope - 0.8 * Math.exp(-0.03 / 0.23)) < 1e-12);
  assert.equal(
    temporalAt({ temporal: { available: false, frames: [], events: [] } }, 0.05),
    undefined,
  );
});
