import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";
const modules = await loadSources();
const { exportFrames, exportSoundAt } = modules["export-timeline"];
const { PcmFeatures } = modules["audio-features"];
const { ANALYSIS_FPS } = modules["audio-analysis-config"];

for (const fps of [24, 30, 60])
  test(`${fps} fps preserves exact duration, timestamps and two-second keyframes`, () => {
    for (const length of [0.1, 1, 2.013, 5.527]) {
      const frames = [...exportFrames(length, fps)];
      assert.equal(frames.length, Math.ceil(length * fps));
      assert.equal(frames[0].time, 0);
      assert.ok(Math.abs(frames.reduce((sum, f) => sum + f.duration, 0) - length) < 1e-12);
      assert.ok(Math.abs(frames.at(-1).time + frames.at(-1).duration - length) < 1e-12);
      for (const f of frames) {
        assert.equal(f.time, f.index / fps);
        assert.ok(f.duration > 0 && f.duration <= 1 / fps);
        assert.equal(f.keyFrame, f.index % (fps * 2) === 0);
      }
    }
  });
test("invalid frame rates and durations fail before rendering", () => {
  for (const [length, fps] of [
    [0, 30],
    [NaN, 30],
    [Infinity, 30],
    [1, 25],
  ])
    assert.throws(() => exportFrames(length, fps).next());
});
test("cached envelopes are reused only at exact PCM analysis times", () => {
  const cached = Array.from({ length: 61 }, (_, i) => ({ rms: i }));
  let fresh = 0;
  const analyze = (time) => {
    fresh++;
    return { time };
  };
  for (const fps of [24, 30, 60]) {
    fresh = 0;
    for (const frame of exportFrames(2, fps)) {
      const envelope = exportSoundAt(cached, frame.time, analyze);
      const position = frame.time * ANALYSIS_FPS,
        index = Math.round(position);
      const exact = Math.abs(position - index) < 1e-7;
      if (exact) assert.equal(envelope, cached[index]);
      if (!exact) assert.equal(envelope.time, frame.time);
    }
    const expectedFresh = [...exportFrames(2, fps)].filter((frame) => {
      const position = frame.time * ANALYSIS_FPS;
      return Math.abs(position - Math.round(position)) >= 1e-7;
    }).length;
    assert.equal(fresh, expectedFresh);
  }
  assert.deepEqual(exportSoundAt(cached, 1.013, analyze), { time: 1.013 });
  assert.deepEqual(exportSoundAt(cached, 3, analyze), { time: 3 });
});
test("off-grid bass impacts use original PCM rather than interpolated cache", () => {
  const rate = 48000,
    samples = new Float32Array(rate);
  for (let i = Math.round(0.201 * rate); i < Math.round(0.217 * rate); i++)
    samples[i] = 0.8 * Math.sin((2 * Math.PI * 70 * i) / rate);
  const analyzer = new PcmFeatures([samples], rate);
  const cache = Array.from({ length: ANALYSIS_FPS }, (_, i) =>
    analyzer.at(i / ANALYSIS_FPS, false),
  );
  const time = 0.216;
  const actual = exportSoundAt(cache, time, (t) => analyzer.at(t, false));
  const expected = analyzer.at(time);
  assert.equal(actual.bassHitDb, expected.bassHitDb);
  assert.deepEqual(actual.bands, expected.bands);
  assert.ok(actual.bassHitDb > -30);
});
