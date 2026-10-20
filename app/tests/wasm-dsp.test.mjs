import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FrameDsp, initSync } from "../public/dsp/pulseframe_dsp.js";
import { FFTAnalyzer } from "../lib/audio-dsp.mjs";
import { bandPower, recentRms } from "../lib/art-reactivity.mjs";

const wasm = initSync({
  module: readFileSync(new URL("../public/dsp/pulseframe_dsp_bg.wasm", import.meta.url)),
});
const size = 4096;
const decibels = (n) => (n > 0 ? 20 * Math.log10(n) : -160);
const close = (actual, expected, tolerance, label) => {
  assert.ok(Number.isFinite(actual), `${label} must be finite`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
};
const levelClose = (actual, expected, label) => {
  if (expected < -120) assert.ok(actual < -120, `${label} noise floor: ${actual}`);
  else close(actual, expected, 0.0001, label);
};

for (const rate of [44100, 48000, 96000]) {
  for (const kind of ["silence", "dc", "tone", "impulse", "stereo"]) {
    test(`compiled WASM matches calibrated JavaScript: ${rate} Hz ${kind}`, () => {
      const samples = Array.from({ length: kind === "stereo" ? 2 : 1 }, (_, c) =>
        Float32Array.from({ length: rate / 2 }, (_, i) => {
          if (kind === "silence") return 0;
          if (kind === "dc") return 0.25;
          if (kind === "impulse") return i === 2100 ? 1 : 0;
          const value =
            0.4 * Math.sin((2 * Math.PI * 93.7 * i) / rate) +
            0.05 * Math.sin((2 * Math.PI * 3271 * i) / rate);
          return c ? -value : value;
        }),
      );
      const dsp = new FrameDsp(rate, samples.length);
      const fft = samples.map(() => new FFTAnalyzer(size, false));
      const impact = samples.map(() => new FFTAnalyzer(1024, false));
      try {
        // Covers start padding, ordinary probes, fractional timestamps, and EOF padding.
        for (const time of [0, 1 / rate, 0.0173, 0.09717, 0.501]) {
          const end = Math.round(time * rate);
          const input = new Float32Array(
            wasm.memory.buffer,
            dsp.input_ptr(),
            samples.length * size,
          );
          input.fill(0);
          for (let c = 0; c < samples.length; c++) {
            const first = Math.max(0, end - size),
              last = Math.min(samples[c].length, end);
            if (last > first)
              input.set(samples[c].subarray(first, last), c * size + first - (end - size));
          }
          dsp.analyze();
          const features = new Float64Array(wasm.memory.buffer, dsp.features_ptr(), 7);
          const amplitudes = new Float64Array(
            wasm.memory.buffer,
            dsp.amplitudes_ptr(),
            samples.length * (size / 2 + 1),
          );
          const bands = new Float32Array(wasm.memory.buffer, dsp.bands_ptr(), samples.length * 96);
          const channels = samples.map((s, c) => fft[c].analyze(s, end - size / 2, rate));
          const impactChannels = samples.map((s, c) => impact[c].analyze(s, end - 512, rate));
          const frame = { channels, sampleRate: rate, size };
          const rms = recentRms(samples, time, rate);
          const expected = [
            rms,
            decibels(rms),
            ...[[35, 180]].map(([l, h]) => decibels(Math.sqrt(bandPower(frame, l, h)))),
            decibels(
              Math.sqrt(
                bandPower({ channels: impactChannels, sampleRate: rate, size: 1024 }, 35, 180),
              ),
            ),
            ...[
              [35, 450],
              [180, 2500],
              [2500, 12000],
            ].map(([l, h]) => decibels(Math.sqrt(bandPower(frame, l, Math.min(h, rate / 2))))),
          ];
          close(features[0], expected[0], 1e-12, "RMS");
          expected.slice(1).forEach((n, i) => levelClose(features[i + 1], n, `feature ${i + 1}`));
          for (let c = 0; c < samples.length; c++) {
            for (let k = 0; k <= size / 2; k++)
              close(
                amplitudes[c * (size / 2 + 1) + k],
                channels[c].amplitudes[k],
                1e-10,
                `amplitude ${c}:${k}`,
              );
            const top = Math.min(16000, rate / 2);
            for (let i = 0; i < 96; i++) {
              const low = 35 * (top / 35) ** (i / 96),
                high = 35 * (top / 35) ** ((i + 1) / 96);
              let first = Math.max(1, Math.ceil((low * size) / rate)),
                last = Math.min(size / 2, Math.floor((high * size) / rate));
              if (last < first)
                first = last = Math.max(
                  1,
                  Math.min(size / 2, Math.round((Math.sqrt(low * high) * size) / rate)),
                );
              let peak = -160;
              for (let k = first; k <= last; k++) peak = Math.max(peak, channels[c].db[k]);
              close(
                bands[c * 96 + i],
                Math.max(0, Math.min(1, (peak + 75) / 63)),
                2e-7,
                `band ${c}:${i}`,
              );
            }
          }
        }
      } finally {
        dsp.free();
      }
    });
  }
}

test("compiled WASM validates dimensions and tolerates invalid PCM without poisoning later probes", () => {
  assert.throws(() => new FrameDsp(0, 1));
  assert.throws(() => new FrameDsp(48000, 3));
  const dsp = new FrameDsp(48000, 1);
  try {
    const input = new Float32Array(wasm.memory.buffer, dsp.input_ptr(), size);
    input.fill(0);
    input[30] = NaN;
    input[31] = Infinity;
    dsp.analyze();
    assert.ok(
      [...new Float64Array(wasm.memory.buffer, dsp.features_ptr(), 7)].every(Number.isFinite),
    );
    input.fill(0);
    dsp.analyze();
    assert.equal(new Float64Array(wasm.memory.buffer, dsp.features_ptr(), 7)[0], 0);
  } finally {
    dsp.free();
  }
});

test("repeated compiled handle disposal reuses bounded linear memory", () => {
  for (let i = 0; i < 3; i++) {
    const d = new FrameDsp(48000, 2);
    d.analyze();
    d.free();
  }
  const baseline = wasm.memory.buffer.byteLength;
  for (let i = 0; i < 20; i++) {
    const d = new FrameDsp(48000, 2);
    d.analyze();
    d.free();
  }
  assert.equal(wasm.memory.buffer.byteLength, baseline);
});
