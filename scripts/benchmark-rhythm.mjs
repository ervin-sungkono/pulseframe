// Experimental detector check against an annotated synthetic click track.
// This does not change Pulseframe effects or claim accuracy on real music.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { initSync, TemporalDsp } from "../src/public/dsp/pulseframe_dsp.js";

const { memory } = initSync({
  module: readFileSync(new URL("../src/public/dsp/pulseframe_dsp_bg.wasm", import.meta.url)),
});
const reports = [];
for (const rate of [44100, 48000]) {
  const duration = 20,
    period = Math.round(rate * 0.5),
    first = rate;
  const clicks = [];
  for (let n = first; n < rate * duration; n += period) clicks.push(n / rate);
  const samples = Float32Array.from({ length: rate * duration }, (_, i) => {
    const phase = (i - first) % period;
    return i >= first && phase >= 0 && phase < 128
      ? 0.8 * Math.exp(-phase / 20) * (phase % 2 ? -1 : 1)
      : 0;
  });
  const dsp = new TemporalDsp(rate),
    onsets = [],
    tempos = [];
  const started = performance.now();
  try {
    for (let end = 512; end <= samples.length; end += 512) {
      const input = new Float32Array(memory.buffer, dsp.input_ptr(), 2048);
      input.fill(0);
      const from = Math.max(0, end - 2048);
      input.set(samples.subarray(from, end), from - (end - 2048));
      dsp.observe(end);
      const output = new Float64Array(memory.buffer, dsp.output_ptr(), 7);
      if (output[1] >= 0) onsets.push(output[1]);
      if (output[3] > 0) tempos.push({ bpm: output[3], confidence: output[5] });
    }
    const errors = clicks.map((t) => Math.min(...onsets.map((n) => Math.abs(n - t))));
    reports.push({
      rate,
      duration,
      analysisMs: performance.now() - started,
      expectedOnsets: clicks.length,
      detectedOnsets: onsets.length,
      maxNearestOnsetErrorMs: Math.max(...errors) * 1000,
      lastTempo: tempos.at(-1) ?? null,
    });
  } finally {
    dsp.free();
  }
}
console.log(
  JSON.stringify(
    {
      reports,
      limitations:
        "Synthetic 120 BPM clicks only; real music, tempo changes and half/double ambiguity require further validation. Not used by current effects.",
    },
    null,
    2,
  ),
);
