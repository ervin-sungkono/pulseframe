import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const {
  EXPORT_AUDIO_CHANNELS,
  EXPORT_AUDIO_SAMPLE_RATE,
  createSilentAudioBuffer,
  estimateAudioNormalizationBudget,
  estimateAudioNormalizationBudgetForRange,
  estimateDecodedAudioBudgetForRange,
  normalizeAudioBufferRange,
} = (await loadSources({ modules: ["audio-normalize", "audio-analysis-config"] }))[
  "audio-normalize"
];

const originalAudioBuffer = globalThis.AudioBuffer;
const originalOfflineAudioContext = globalThis.OfflineAudioContext;

class FakeAudioBuffer {
  constructor({ length, numberOfChannels, sampleRate }) {
    this.length = length;
    this.numberOfChannels = numberOfChannels;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(index) {
    return this.channels[index];
  }
}

class FakeOfflineAudioContext {
  constructor(numberOfChannels, length, sampleRate) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.destination = {};
    this.source = null;
  }
  createBufferSource() {
    const source = {
      buffer: null,
      offset: 0,
      duration: Infinity,
      connect() {},
      start(_when, offset = 0, duration = Infinity) {
        this.offset = offset;
        this.duration = duration;
      },
    };
    this.source = source;
    return source;
  }
  async startRendering() {
    const output = new FakeAudioBuffer({
      length: this.length,
      numberOfChannels: this.numberOfChannels,
      sampleRate: this.sampleRate,
    });
    const source = this.source;
    for (let frame = 0; frame < output.length; frame++) {
      const elapsed = frame / this.sampleRate;
      if (elapsed >= source.duration) continue;
      const sourcePosition = (source.offset + elapsed) * source.buffer.sampleRate;
      const left = Math.floor(sourcePosition);
      const fraction = sourcePosition - left;
      for (let channel = 0; channel < output.numberOfChannels; channel++) {
        const input = source.buffer.getChannelData(
          Math.min(channel, source.buffer.numberOfChannels - 1),
        );
        const first = input[left] ?? 0;
        const second = input[left + 1] ?? first;
        output.getChannelData(channel)[frame] = first + (second - first) * fraction;
      }
    }
    return output;
  }
}

globalThis.AudioBuffer = FakeAudioBuffer;
globalThis.OfflineAudioContext = FakeOfflineAudioContext;
after(() => {
  if (originalAudioBuffer === undefined) delete globalThis.AudioBuffer;
  else globalThis.AudioBuffer = originalAudioBuffer;
  if (originalOfflineAudioContext === undefined) delete globalThis.OfflineAudioContext;
  else globalThis.OfflineAudioContext = originalOfflineAudioContext;
});

function makeBuffer(rate, channels, seconds) {
  const buffer = new FakeAudioBuffer({
    length: Math.round(rate * seconds),
    numberOfChannels: channels,
    sampleRate: rate,
  });
  for (let channel = 0; channel < channels; channel++)
    for (let frame = 0; frame < buffer.length; frame++)
      buffer.getChannelData(channel)[frame] = (frame / rate) * (channel + 1);
  return buffer;
}

test("44.1 kHz mono input becomes exact 48 kHz stereo with selected-range timing", async () => {
  const input = makeBuffer(44_100, 1, 1);
  const output = await normalizeAudioBufferRange(input, 0.25, 0.75, 24_000);
  assert.equal(output.sampleRate, EXPORT_AUDIO_SAMPLE_RATE);
  assert.equal(output.numberOfChannels, EXPORT_AUDIO_CHANNELS);
  assert.equal(output.length, 24_000);
  assert.ok(Math.abs(output.getChannelData(0)[0] - 0.25) < 0.0001);
  assert.deepEqual(output.getChannelData(0), output.getChannelData(1));
  assert.ok(Math.abs(output.getChannelData(0).at(-1) - 0.75) < 0.0001);
});

test("44.1 kHz stereo input preserves distinct channels through conversion", async () => {
  const input = makeBuffer(44_100, 2, 0.2);
  const output = await normalizeAudioBufferRange(input, 0, input.duration, 9_600);
  assert.equal(output.sampleRate, 48_000);
  assert.equal(output.numberOfChannels, 2);
  assert.equal(output.length, 9_600);
  assert.ok(Math.abs(output.getChannelData(0)[2400] * 2 - output.getChannelData(1)[2400]) < 0.0001);
});

test("48 kHz mono is upmixed and 48 kHz stereo is reused when its exact sample count matches", async () => {
  const mono = makeBuffer(48_000, 1, 0.1);
  const convertedMono = await normalizeAudioBufferRange(mono, 0, mono.duration, 4_800);
  assert.equal(convertedMono.length, 4_800);
  assert.deepEqual(convertedMono.getChannelData(0), convertedMono.getChannelData(1));

  const stereo = makeBuffer(48_000, 2, 0.1);
  const unchanged = await normalizeAudioBufferRange(stereo, 0, stereo.duration, 4_800);
  assert.equal(unchanged, stereo);
});

test("silent playlist sections have uniform stereo 48 kHz format and zero samples", () => {
  const silent = createSilentAudioBuffer(7);
  assert.equal(silent.length, 7);
  assert.equal(silent.numberOfChannels, 2);
  assert.equal(silent.sampleRate, 48_000);
  assert.deepEqual([...silent.getChannelData(0)], Array(7).fill(0));
  assert.deepEqual([...silent.getChannelData(1)], Array(7).fill(0));
});

test("a range extending beyond decoded audio keeps its available samples and pads the tail", async () => {
  const input = makeBuffer(48_000, 1, 1);
  const output = await normalizeAudioBufferRange(input, 0.5, 2.5, 96_000);

  assert.equal(output.length, 96_000);
  assert.ok(output.getChannelData(0)[0] > 0.49);
  assert.ok(output.getChannelData(0)[23_999] > 0.99);
  assert.deepEqual([...output.getChannelData(0).slice(24_000)], Array(72_000).fill(0));
  assert.deepEqual(output.getChannelData(0), output.getChannelData(1));
});

test("a selection wholly after decoded audio is silent and observes cancellation", async () => {
  const input = makeBuffer(44_100, 1, 1);
  const output = await normalizeAudioBufferRange(input, 2, 3, 48_000);
  assert.deepEqual([...output.getChannelData(0)], Array(48_000).fill(0));
  assert.deepEqual([...output.getChannelData(1)], Array(48_000).fill(0));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(normalizeAudioBufferRange(input, 2, 3, 48_000, controller.signal), {
    name: "AbortError",
  });
});

test("silent buffers are rejected when their allocation exceeds the PCM budget", () => {
  assert.throws(() => createSilentAudioBuffer(40_000_001), /too much memory/i);
});

test("normalization budget includes source PCM, converted PCM, and analysis history", () => {
  const source = makeBuffer(44_100, 2, 10);
  const budget = estimateAudioNormalizationBudget(source, 480_000);
  assert.equal(budget.sourceBytes, source.length * 2 * 4);
  assert.equal(budget.convertedBytes, 480_000 * 2 * 4);
  assert.ok(budget.historyBytes > 0);
  assert.equal(budget.peakBytes, budget.sourceBytes + budget.convertedBytes + budget.historyBytes);
});

test("pre-decode budget estimates the selected source window before PCM allocation", () => {
  const budget = estimateAudioNormalizationBudgetForRange(60, 44_100, 1, 2_880_000);
  assert.equal(budget.sourceBytes, 60 * 44_100 * 4);
  assert.equal(budget.convertedBytes, 2_880_000 * 2 * 4);
  assert.ok(budget.historyBytes > 0);
  assert.equal(budget.peakBytes, budget.sourceBytes + budget.convertedBytes + budget.historyBytes);
});

test("a preroll-only decode budget excludes conversion PCM for selections after audio", () => {
  const budget = estimateDecodedAudioBudgetForRange(1, 44_100, 1);
  assert.equal(budget.sourceBytes, 44_100 * 4);
  assert.equal(budget.convertedBytes, 0);
  assert.ok(budget.historyBytes > 0);
  assert.equal(budget.peakBytes, budget.sourceBytes + budget.historyBytes);
});

test("an over-budget per-track conversion fails before allocating an offline context", async () => {
  let constructed = false;
  const savedContext = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class extends FakeOfflineAudioContext {
    constructor(...args) {
      constructed = true;
      super(...args);
    }
  };
  const longAudio = {
    duration: 500,
    length: 22_050_000,
    numberOfChannels: 2,
    sampleRate: 44_100,
  };
  try {
    await assert.rejects(
      normalizeAudioBufferRange(longAudio, 0, 500, 24_000_000),
      /too much memory/i,
    );
    assert.equal(constructed, false);
  } finally {
    globalThis.OfflineAudioContext = savedContext;
  }
});
