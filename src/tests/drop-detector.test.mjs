import assert from "node:assert/strict";
import test from "node:test";
import { BassReturnDetector } from "../lib/audio/drop-detector.mjs";
import { FFTAnalyzer } from "../lib/audio/audio-dsp.mjs";

const run = (detector, from, until, levels, extra = {}) => {
  const events = [];
  for (let tick = Math.round(from * 30); tick < Math.round(until * 30); tick++) {
    const time = tick / 30,
      [bassDb, levelDb] = levels(time);
    const effect = detector.observe({ time, bassDb, levelDb, playing: true, ...extra });
    if (effect === 1) events.push(time);
  }
  return events;
};
const dropLevels = (t) => (t < 2.5 ? [-18, -15] : t < 4.5 ? [-52, -42] : [-16, -13]);

test("a sustained bass return after quieter music produces one brief effect", () => {
  const d = new BassReturnDetector(),
    events = run(d, 0, 9, dropLevels);
  assert.equal(events.length, 1);
  assert.ok(events[0] >= 4.5 && events[0] < 4.8);
  assert.equal(d.observe({ time: 9, bassDb: -16, levelDb: -13, playing: true }), 0);
});

test("silence, constant tones, and an initial loud start never trigger", () => {
  for (const levels of [
    () => [-90, -90],
    () => [-18, -15],
    (t) => (t < 3 ? [-90, -90] : [-18, -15]),
  ]) {
    assert.deepEqual(run(new BassReturnDetector(), 0, 12, levels), []);
  }
});

test("ordinary repeated kicks do not count as a new drop each beat", () => {
  const levels = (t) => (t % 0.5 < 0.12 ? [-16, -13] : [-55, -42]);
  assert.deepEqual(run(new BassReturnDetector(), 0, 20, levels), []);
});

test("a treble-only return and a brief isolated spike do not trigger", () => {
  const highs = (t) => (t < 2.5 ? [-18, -15] : t < 4.5 ? [-52, -42] : [-52, -13]);
  const spike = (t) => (t < 2.5 ? [-18, -15] : t >= 4.5 && t < 4.55 ? [-16, -13] : [-52, -42]);
  assert.deepEqual(run(new BassReturnDetector(), 0, 8, highs), []);
  assert.deepEqual(run(new BassReturnDetector(), 0, 8, spike), []);
});

test("pause, seek, loop wrap and scheduling gaps clear armed history", () => {
  for (const boundary of ["pause", "seek", "wrap", "gap"]) {
    const d = new BassReturnDetector();
    run(d, 0, 4.5, dropLevels);
    if (boundary === "pause") d.observe({ time: 4.5, bassDb: -52, levelDb: -42, playing: false });
    const from = boundary === "wrap" ? 0 : boundary === "gap" ? 5 : 4.5;
    assert.deepEqual(
      run(d, from, from + 3, () => [-16, -13], boundary === "seek" ? { revision: 1 } : {}),
      [],
    );
  }
});

test("real causal PCM detects a return without antiphase stereo cancellation", () => {
  const sr = 12000,
    length = sr * 8;
  const signal = Float32Array.from({ length }, (_, i) => {
    const t = i / sr,
      a = t < 2.5 ? 0.24 : t < 4.5 ? 0.004 : 0.3;
    return a * Math.sin(2 * Math.PI * 70 * t) + a * 0.3 * Math.sin(2 * Math.PI * 1000 * t);
  });
  function analyze(data) {
    const detector = new BassReturnDetector(),
      analyzers = data.map(() => new FFTAnalyzer(1024)),
      events = [];
    for (let i = 0; i < 240; i++) {
      const time = i / 30;
      const frame = {
        time,
        playing: true,
        revision: 0,
        size: 1024,
        sampleRate: sr,
        channels: data.map((d, c) => analyzers[c].analyze(d, Math.round(time * sr) - 512, sr)),
      };
      if (detector.update(frame, data) === 1) events.push(time);
    }
    return events;
  }
  const mono = analyze([signal]),
    stereo = analyze([signal, Float32Array.from(signal, (x) => -x)]);
  assert.equal(mono.length, 1);
  assert.ok(mono[0] >= 4.5 && mono[0] < 4.85);
  assert.deepEqual(stereo, mono);
});

test("the full trailing 4096 FFT cannot stretch a 50 ms kick into a drop", () => {
  const sr = 48000,
    detector = new BassReturnDetector(),
    analyzer = new FFTAnalyzer(4096),
    events = [];
  const data = Float32Array.from({ length: sr * 7 }, (_, i) => {
    const t = i / sr,
      amplitude = t < 2.5 || (t >= 4.5 && t < 4.55) ? 0.3 : 0.003;
    return amplitude * Math.sin(2 * Math.PI * 70 * t);
  });
  for (let i = 0; i < 210; i++) {
    const time = i / 30;
    const frame = {
      time,
      revision: 0,
      playing: true,
      size: 4096,
      sampleRate: sr,
      channels: [analyzer.analyze(data, Math.round(time * sr) - 2048, sr)],
    };
    if (detector.update(frame, [data]) === 1) events.push(time);
  }
  assert.deepEqual(events, []);
});
