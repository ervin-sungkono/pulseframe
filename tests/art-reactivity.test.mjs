import assert from 'node:assert/strict';
import test from 'node:test';
import { FFTAnalyzer, generateTestTone } from '../lib/audio-dsp.mjs';
import { bandPower, recentRms, reactiveFeatures, smoothFeatures } from '../lib/art-reactivity.mjs';

function signal(frequency, inverted = false) {
  const data = generateTestTone(48000, 2, frequency, .25, inverted);
  const frame = { time: 1, sampleRate: 48000, size: 4096, channels: data.map(d => new FFTAnalyzer(4096).analyze(d, 48000 - 2048, 48000)), playing: true, revision: 0 };
  return { data, frame, features: reactiveFeatures(frame, data) };
}

test('low, middle and high reference tones excite their own visual bands', () => {
  const low = signal(70).features, middle = signal(1000).features, high = signal(6000).features;
  assert.ok(low.bass > .5 && low.middle < .01 && low.high < .01);
  assert.ok(middle.middle > .5 && middle.bass < .01 && middle.high < .01);
  assert.ok(high.high > .5 && high.bass < .01 && high.middle < .01);
});

test('Hann-corrected band power agrees with the RMS of a contained sine', () => {
  const { data, frame } = signal(1000);
  assert.ok(Math.abs(bandPower(frame, 180, 2500) - .25 ** 2 / 2) < 1e-7);
  assert.ok(Math.abs(recentRms(data, 1, 48000) - .25 / Math.SQRT2) < 1e-7);
});

test('opposite-phase stereo gives the same visual energy and independent texture', () => {
  const normal = signal(1000).features, inverted = signal(1000, true).features;
  assert.equal(inverted.energy, normal.energy);
  assert.equal(inverted.middle, normal.middle);
  assert.deepEqual(inverted.bands, normal.bands);
  assert.ok(inverted.energy > .5);
});

test('silence and DC offset produce no reactive motion or lights', () => {
  for (const value of [0, .4]) {
    const data = [new Float32Array(96000).fill(value)];
    const frame = { time: 1, sampleRate: 48000, size: 4096, channels: [new FFTAnalyzer(4096).analyze(data[0], 48000 - 2048, 48000)] };
    const f = reactiveFeatures(frame, data);
    assert.equal(f.energy, 0); assert.equal(f.bass, 0); assert.equal(f.high, 0);
    assert.ok(f.bands[0].every(v => v === 0));
  }
});

test('visual easing freezes with the audio clock and settles in silence', () => {
  const target = { energy: 1, bass: 1, middle: .5, high: .8, bands: [], rmsDb: -10 };
  const start = smoothFeatures(null, target, 0, 'balanced', true);
  const silent = { ...target, energy: 0, bass: 0, middle: 0, high: 0 };
  const paused = smoothFeatures(start, silent, 0);
  assert.equal(paused.energy, 1); assert.equal(paused.phase, start.phase);
  const settled = smoothFeatures(start, silent, 2);
  assert.ok(settled.energy < 1e-6 && settled.bass < 1e-6);
  const seek = smoothFeatures(start, silent, 0, 'balanced', true);
  assert.equal(seek.energy, 0); assert.equal(seek.phase, 0);
});
