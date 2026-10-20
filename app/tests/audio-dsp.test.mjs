import assert from "node:assert/strict";
import test from "node:test";

import {
  FFTAnalyzer,
  generateDemo,
  generateTestTone,
  waveformEnvelope,
} from "../lib/audio-dsp.mjs";

const SAMPLE_RATE = 48_000;
const FFT_SIZE = 8192;
const CENTER = 24_576;

function closeTo(actual, expected, tolerance, label = "value") {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

test("calibrates an interior bin-centered sine as peak dBFS", () => {
  const [left] = generateTestTone(SAMPLE_RATE, 1, 750, 0.5);
  const result = new FFTAnalyzer(FFT_SIZE).analyze(left, CENTER, SAMPLE_RATE);
  const expectedPeakDb = 20 * Math.log10(0.5);
  const expectedRmsDb = 20 * Math.log10(0.5 / Math.sqrt(2));
  const bin = (750 * FFT_SIZE) / SAMPLE_RATE;

  closeTo(result.amplitudes[bin], 0.5, 2e-6, "calibrated bin amplitude");
  closeTo(result.db[bin], expectedPeakDb, 3e-5, "calibrated bin dBFS peak");
  closeTo(result.peakDb, expectedPeakDb, 3e-5, "interpolated peak dBFS");
  closeTo(result.peakFrequency, 750, 1e-9, "peak frequency");
  closeTo(result.rmsDb, expectedRmsDb, 3e-5, "sample-domain RMS dBFS");
  closeTo(result.samplePeakDb, expectedPeakDb, 3e-5, "sample peak dBFS");
});

test("halving amplitude lowers the calibrated spectrum by 6.0206 dB", () => {
  const [full] = generateTestTone(SAMPLE_RATE, 1, 750, 1);
  const [half] = generateTestTone(SAMPLE_RATE, 1, 750, 0.5);
  const analyzer = new FFTAnalyzer(FFT_SIZE);
  const fullResult = analyzer.analyze(full, CENTER, SAMPLE_RATE);
  const halfResult = analyzer.analyze(half, CENTER, SAMPLE_RATE);

  closeTo(fullResult.peakDb - halfResult.peakDb, 20 * Math.log10(2), 3e-5);
  closeTo(fullResult.peakDb, 0, 3e-5, "full-scale sine peak dBFS");
  closeTo(fullResult.rmsDb, -3.0102999566, 3e-5, "full-scale sine RMS dBFS");
});

test("interpolates frequency and peak amplitude for an off-bin sine", () => {
  const [left] = generateTestTone(SAMPLE_RATE, 1, 1000, 0.5);
  const result = new FFTAnalyzer(FFT_SIZE).analyze(left, CENTER, SAMPLE_RATE);

  closeTo(result.peakFrequency, 1000, 0.15, "off-bin peak frequency");
  closeTo(result.peakDb, 20 * Math.log10(0.5), 0.12, "off-bin peak dBFS");
  assert.ok(result.db[result.db.length - 1] <= 0, "Nyquist stays within a 0 dBFS peak scale");
});

test("normalizes DC and Nyquist bins without one-sided doubling", () => {
  const constant = new Float32Array(FFT_SIZE).fill(0.25);
  const alternating = new Float32Array(FFT_SIZE);
  for (let index = 0; index < FFT_SIZE; index += 1) {
    alternating[index] = index % 2 === 0 ? 0.5 : -0.5;
  }
  const dc = new FFTAnalyzer(FFT_SIZE).analyze(constant, FFT_SIZE / 2, SAMPLE_RATE);
  const nyquist = new FFTAnalyzer(FFT_SIZE).analyze(alternating, FFT_SIZE / 2, SAMPLE_RATE);
  closeTo(dc.amplitudes[0], 0.25, 2e-6, "DC amplitude");
  closeTo(nyquist.amplitudes[FFT_SIZE / 2], 0.5, 2e-6, "Nyquist amplitude");
});

test("analyzes anti-phase stereo channels independently", () => {
  const [left, right] = generateTestTone(SAMPLE_RATE, 1, 750, 0.5, true);
  const monoSum = new Float32Array(left.length);
  for (let index = 0; index < left.length; index += 1) {
    monoSum[index] = left[index] + right[index];
  }

  const analyzer = new FFTAnalyzer(FFT_SIZE);
  const leftResult = analyzer.analyze(left, CENTER, SAMPLE_RATE);
  const rightResult = analyzer.analyze(right, CENTER, SAMPLE_RATE);
  const summedResult = analyzer.analyze(monoSum, CENTER, SAMPLE_RATE);
  closeTo(leftResult.peakDb, -6.020599913, 3e-5, "left channel");
  closeTo(rightResult.peakDb, -6.020599913, 3e-5, "right channel");
  assert.equal(summedResult.peakDb, -Infinity, "anti-phase mono sum cancels");
});

test("zero-pads frame edges while reporting sample peak from available samples", () => {
  const channel = new Float32Array([1, 0, 0, 0]);
  const result = new FFTAnalyzer(FFT_SIZE).analyze(channel, 0, SAMPLE_RATE);

  closeTo(result.samplePeakDb, 0, 0, "edge-frame sample peak");
  assert.ok(result.rmsDb < -30, "zero padding includes silence outside the file");
});

test("waveform envelope preserves positive and negative transients per pixel", () => {
  const channels = [
    new Float32Array([0, 0.9, -0.2, 0.1, -0.8, 0.2, 0, 0.7]),
    new Float32Array([0, -0.5, 0.3, -0.1, 0.6, -0.4, 0, -0.2]),
  ];
  const [left, right] = waveformEnvelope(channels, 0, 8, 4);

  assert.deepEqual([...left.min], [...new Float32Array([0, -0.2, -0.8, 0])]);
  assert.deepEqual([...left.max], [...new Float32Array([0.9, 0.1, 0.2, 0.7])]);
  assert.deepEqual([...right.min], [...new Float32Array([-0.5, -0.1, -0.4, -0.2])]);
  assert.deepEqual([...right.max], [...new Float32Array([0, 0.3, 0.6, 0])]);
});

test("empty waveform buckets are marked as missing data", () => {
  const [channel] = waveformEnvelope([new Float32Array([0.4, -0.2])], 0, 2, 4);

  assert.ok(Number.isNaN(channel.min[0]));
  closeTo(channel.min[1], 0.4, 1e-7);
  assert.ok(Number.isNaN(channel.min[2]));
  closeTo(channel.min[3], -0.2, 1e-7);
});

test("demo generation is deterministic, stereo, and within full-scale bounds", () => {
  const first = generateDemo(SAMPLE_RATE, 0.5);
  const second = generateDemo(SAMPLE_RATE, 0.5);
  assert.equal(first[0].length, 24_000);
  assert.equal(first[1].length, 24_000);
  assert.deepEqual(first, second);
  assert.ok(Math.max(...first[0].slice(0, 1000)) < 1);
  assert.ok(Math.min(...first[0].slice(0, 1000)) > -1);
  assert.notDeepEqual(first[0], first[1]);
});
