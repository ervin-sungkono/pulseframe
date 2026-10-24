import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { PreparedFrequencyHistory, RollingFrequencyHistory } = modules["frequency-history"];
const { sampleTerrain, projectTerrain } = modules["spectral-terrain"];
const { exportAnalysisStart } = modules["export-timeline"];
const { DEFAULT_SETTINGS } = modules["customizer-config"];
const frame = (value, rms = 0.2) => ({
  rms,
  rmsDb: -12,
  bassDb: -15,
  middleDb: -18,
  highDb: -22,
  bands: [new Float32Array(96).fill(value)],
});
function closeSamples(actual, expected) {
  assert.equal(actual.columns, expected.columns);
  assert.equal(actual.rows, expected.rows);
  assert.deepEqual(actual.knownRows, expected.knownRows);
  assert.deepEqual(actual.times, expected.times);
  for (let i = 0; i < actual.levels.length; i++)
    assert.ok(Math.abs(actual.levels[i] - expected.levels[i]) < 1e-6);
}

test("prepared history is causal, smooth within analysis intervals and quiet-gated", () => {
  const measured = Array.from({ length: 120 }, (_, i) => frame(i >= 30 ? 1 : 0));
  const history = new PreparedFrequencyHistory(measured);
  const target = new Float32Array(64);
  history.read(0.9999, target, 0.006);
  assert.ok(target.every((value) => value === 0));
  history.read(1.01, target, 0.006);
  const first = target[0];
  assert.ok(first > 0 && first < 1);
  history.read(1.02, target, 0.006);
  assert.ok(target[0] > first);
  history.read(1.2, target, 0.006);
  assert.ok(target.every((value) => Math.abs(value - 1) < 1e-6));
  measured[60] = frame(1, 0);
  measured[61] = frame(1, 0);
  measured[62] = frame(1, 0);
  measured[63] = frame(1, 0);
  history.read(2.12, target, 0.006);
  assert.ok(target.every((value) => value === 0));
  assert.equal(history.read(-1, target, 0.006), false);
  assert.ok(target.every((value) => value === 0));
  assert.equal(history.read(Infinity, target, 0.006), false);
});

test("prepared history keeps bounded caches over five-minute tracks and reconstructs seeks", () => {
  const measured = Array.from({ length: 9000 }, (_, i) => frame((i % 41) / 40));
  const before = measured[40].bands[0].slice();
  const history = new PreparedFrequencyHistory(measured);
  const target = new Float32Array(96);
  history.read(1.25, target, 0.006);
  const expected = target.slice();
  for (let i = 0; i < 9000; i += 2) history.read(i / 30, target, 0.006);
  assert.ok(history.cachedFrames <= 384);
  history.read(1.25, target, 0.006);
  assert.deepEqual(target, expected);
  assert.deepEqual(measured[40].bands[0], before);
});

test("terrain seeks and clipped export offsets sample the same measured source window", () => {
  const measured = Array.from({ length: 3600 }, (_, i) => frame((Math.sin(i * 0.17) + 1) / 2));
  const full = new PreparedFrequencyHistory(measured);
  const clipped = new PreparedFrequencyHistory(measured.slice(1500), 50);
  const first = sampleTerrain(full, [], 60.25, 5, 48, 40, 0.006);
  const second = sampleTerrain(clipped, [], 60.25, 5, 48, 40, 0.006);
  closeSamples(second, first);
  sampleTerrain(full, [], 10, 5, 48, 40, 0.006, first);
  sampleTerrain(full, [], 60.25, 5, 48, 40, 0.006, first);
  closeSamples(first, second);
  const options = { ...DEFAULT_SETTINGS.terrainOptions, visualScale: 1, sensitivity: 1.3 };
  const atTime = (fps) => {
    const time = Math.round(fps * 60.5) / fps;
    const samples = sampleTerrain(full, [], time, 5, 48, 40, 0.006);
    return projectTerrain(samples.levels, 48, 40, 1280, 720, options);
  };
  assert.deepEqual(atTime(24), atTime(30));
  assert.deepEqual(atTime(60), atTime(30));
});

test("rolling fallback retains only measured history and clears seeks or discontinuities", () => {
  const history = new RollingFrequencyHistory();
  const target = new Float32Array(32);
  for (let index = 0; index < 900; index++) history.record(index / 30, frame(1));
  assert.ok(history.cachedFrames <= 304);
  assert.equal(history.read(2, target, 0.006), false);
  assert.equal(history.read(29, target, 0.006), true);
  assert.ok(target.some((value) => value > 0));
  history.record(5, frame(0.5));
  assert.equal(history.cachedFrames, 1);
  assert.equal(history.read(4.9, target, 0.006), false);
  history.record(12, frame(0.5));
  assert.equal(history.cachedFrames, 1);
  assert.equal(history.read(5, target, 0.006), false);
  history.clear();
  assert.equal(history.cachedFrames, 0);
});

test("mono/stereo energy and invalid band values remain finite without phase cancellation", () => {
  const invalid = frame(1);
  invalid.bands[0][5] = NaN;
  invalid.bands[0][20] = Infinity;
  const history = new PreparedFrequencyHistory(Array.from({ length: 20 }, () => invalid));
  const target = new Float32Array(64);
  assert.equal(history.read(0.5, target, 0), true);
  assert.ok(target.every(Number.isFinite));
  const stereo = {
    ...frame(1),
    bands: [new Float32Array(96).fill(1), new Float32Array(96).fill(1)],
  };
  const mono = new PreparedFrequencyHistory(Array.from({ length: 20 }, () => frame(1)));
  const both = new PreparedFrequencyHistory(Array.from({ length: 20 }, () => stereo));
  const left = new Float32Array(96),
    right = new Float32Array(96);
  mono.read(0.5, left, 0);
  both.read(0.5, right, 0);
  assert.deepEqual(left, right);
});

test("maximum terrain history has filter support at a clipped export boundary", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    mode: "terrain",
    terrainOptions: { ...DEFAULT_SETTINGS.terrainOptions, historySeconds: 10 },
  };
  const time = 60.271;
  const offset = exportAnalysisStart(time, settings);
  assert.ok(offset <= time - 10.25);
  assert.ok(Math.abs(offset * 30 - Math.round(offset * 30)) < 1e-8);
  const measured = Array.from({ length: 2400 }, (_, i) => frame((Math.sin(i * 0.17) + 1) / 2));
  const full = new PreparedFrequencyHistory(measured);
  const clipped = new PreparedFrequencyHistory(measured.slice(Math.round(offset * 30)), offset);
  closeSamples(
    sampleTerrain(clipped, [], time, 10, 64, 64, 0.006),
    sampleTerrain(full, [], time, 10, 64, 64, 0.006),
  );
  for (const mode of ["ring", "spectrum", "edges"])
    assert.equal(exportAnalysisStart(time, { ...settings, mode }), time - 10);
});
