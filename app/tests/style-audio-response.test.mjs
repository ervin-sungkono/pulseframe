import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { styleResponseHistory, STYLE_RESPONSE_LOOKBACK_SECONDS } = modules["audio-response"];
const { PreparedFrequencyHistory, RollingFrequencyHistory } = modules["frequency-history"];
const { sampleTerrain } = modules["spectral-terrain"];
const { exportAnalysisStart } = modules["export-timeline"];
const { DEFAULT_SETTINGS } = modules["customizer-config"];

const measured = (read, revision) => ({
  get revision() {
    return revision?.() ?? 0;
  },
  read(time, target, threshold) {
    target.fill(0);
    if (!Number.isFinite(time) || time < 0) return false;
    return read(time, target, threshold);
  },
});
const sound = (value) => ({ rms: 0.3, bands: [new Float32Array(96).fill(value)] });
function at(history, time, threshold = 0.006, size = 96) {
  const values = new Float32Array(size);
  assert.equal(history.read(time, values, threshold), true);
  return values;
}

test("a measured hit attacks immediately and bass releases longer than midrange and treble", () => {
  const history = styleResponseHistory(
    measured((time, target) => {
      target.fill(time >= 1 && time < 1 + 1 / 30 ? 0.8 : 0);
      return true;
    }),
  );
  assert.ok(at(history, 0.99).every((value) => value === 0));
  assert.ok(at(history, 1.01).every((value) => Math.abs(value - 0.8) < 1e-6));
  const tail = at(history, 1.15);
  assert.ok(tail[0] > tail[48] && tail[48] > tail[95]);
  assert.ok(tail.every((value) => value > 0 && value < 0.8));
  assert.ok(at(history, 1.3)[0] < tail[0]);
  assert.ok(at(history, 2.1).every((value) => value === 0));
});

test("response stays causal, leaves held signals unchanged and does not animate silence", () => {
  for (const level of [0, 0.05, 0.6, 1]) {
    const calls = [];
    const history = styleResponseHistory(
      measured((time, target) => {
        calls.push(time);
        target.fill(level);
        return true;
      }),
    );
    const output = at(history, 10.123);
    assert.ok(calls.every((time) => time <= 10.123));
    assert.ok(output.every((value) => Math.abs(value - level) < 1e-6));
    assert.deepEqual(at(history, 60.7), output);
  }
});

test("finite release reaches zero continuously when the last measured hit leaves its lookback", () => {
  const history = styleResponseHistory(
    measured((time, target) => {
      target.fill(Math.abs(time - 1) < 1e-10 ? 1 : 0);
      return true;
    }),
  );
  const end = 1 + STYLE_RESPONSE_LOOKBACK_SECONDS;
  const before = at(history, end - 1e-6);
  const after = at(history, end + 1e-6);
  assert.ok(before.every((value) => value >= 0 && value < 1e-5));
  assert.ok(after.every((value) => value === 0));
});

test("missing current and earlier measurements never invent energy", () => {
  let available = true;
  const history = styleResponseHistory(
    measured((time, target) => {
      if (!available || time < 5) return false;
      target.fill(0);
      return true;
    }),
  );
  assert.ok(at(history, 5.1).every((value) => value === 0));
  available = false;
  const target = new Float32Array(32).fill(1);
  assert.equal(history.read(5.1, target, 0), false);
  assert.ok(target.every((value) => value === 0));
});

test("quiet settings and mutable history revisions invalidate cached responses", () => {
  let revision = 0,
    level = 0.6;
  const history = styleResponseHistory(
    measured(
      (_time, target, threshold) => {
        target.fill(threshold < 0.05 ? level : 0);
        return true;
      },
      () => revision,
    ),
  );
  assert.ok(at(history, 5).every((value) => value > 0));
  assert.ok(at(history, 5, 0.1).every((value) => value === 0));
  level = 0;
  revision++;
  assert.ok(at(history, 5).every((value) => value === 0));
  const live = new RollingFrequencyHistory();
  live.record(0, sound(1));
  live.record(1 / 30, sound(1));
  const response = styleResponseHistory(live);
  assert.ok(at(response, 1 / 30).some((value) => value > 0));
  live.record(0, sound(0));
  live.record(1 / 30, sound(0));
  assert.ok(at(response, 1 / 30).every((value) => value === 0));
});

test("invalid input is finite, caller buffers are filled, and source bands remain immutable", () => {
  const original = Float32Array.from({ length: 96 }, (_, i) =>
    i % 3 === 0 ? NaN : i % 3 === 1 ? Infinity : 2,
  );
  const before = original.slice();
  const history = styleResponseHistory(
    measured((_time, target) => {
      target.set(original);
      return true;
    }),
  );
  for (const size of [1, 32, 96, 160]) {
    const values = at(history, 5, 0, size);
    assert.ok(values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
  }
  assert.deepEqual(original, before);
  for (const time of [NaN, Infinity, -1, Number.MAX_VALUE]) {
    const target = new Float32Array(32).fill(1);
    assert.equal(history.read(time, target, 0), false);
    assert.ok(target.every((value) => value === 0));
  }
});

test("caches remain bounded across five minutes and cold seeking reproduces a warm result", () => {
  const source = measured((time, target) => {
    target.fill((Math.sin(time * 9) + 1) * 0.4);
    return true;
  });
  const history = styleResponseHistory(source);
  const expected = at(history, 60.5);
  for (let index = 0; index < 9000; index += 4) at(history, index / 30);
  assert.ok(history.cachedFrames <= 768);
  assert.deepEqual(at(history, 60.5), expected);
  const cold = styleResponseHistory(measured(source.read.bind(source)));
  assert.deepEqual(at(cold, 60.5), expected);
  for (const fps of [24, 30, 60])
    assert.deepEqual(at(history, Math.round(60.5 * fps) / fps), expected);
});

test("maximum-depth clipped terrain has identical response history after extended preroll", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    mode: "terrain",
    terrainOptions: { ...DEFAULT_SETTINGS.terrainOptions, historySeconds: 10 },
  };
  const time = 60.271;
  const offset = exportAnalysisStart(time, settings);
  assert.ok(offset <= time - 10 - STYLE_RESPONSE_LOOKBACK_SECONDS - 0.25);
  const frames = Array.from({ length: 2400 }, (_, i) => sound((Math.sin(i * 0.17) + 1) / 2));
  const full = styleResponseHistory(new PreparedFrequencyHistory(frames));
  const clip = styleResponseHistory(
    new PreparedFrequencyHistory(frames.slice(Math.round(offset * 30)), offset),
  );
  const first = sampleTerrain(full, [], time, 10, 64, 64, 0.006);
  const second = sampleTerrain(clip, [], time, 10, 64, 64, 0.006);
  assert.deepEqual(first.times, second.times);
  first.levels.forEach((value, i) => assert.ok(Math.abs(value - second.levels[i]) < 1e-6));
});
