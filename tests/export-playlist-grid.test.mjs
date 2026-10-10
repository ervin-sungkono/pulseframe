import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources({
  modules: [
    "export-video",
    "visualizer",
    "audio-analysis-config",
    "visual-settings-model",
    "subtitles",
    "glitch",
    "track-overlay",
    "beat-lighting",
    "composition",
    "audio-features",
    "dsp/scan-client",
    "dsp/loader",
    "dsp/contracts",
    "dsp/wasm-backend",
    "pcm-features",
    "media-audio",
    "audio-normalize",
    "local-image",
    "project-model",
    "playlist-timeline",
    "export-destination",
    "export-preflight",
    "export-settings",
    "export-timeline",
    "export-time-estimate",
  ],
});
const { audioSectionsWithSilence, playlistFrameWindow, playlistOutputSampleCount } =
  modules["export-video"];
const { EXPORT_AUDIO_SAMPLE_RATE } = modules["audio-normalize"];

const originalAudioBuffer = globalThis.AudioBuffer;
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
globalThis.AudioBuffer = FakeAudioBuffer;
after(() => {
  if (originalAudioBuffer === undefined) delete globalThis.AudioBuffer;
  else globalThis.AudioBuffer = originalAudioBuffer;
});

test("playlist audio boundaries use exact normalized sample counts", () => {
  const firstFrames = playlistOutputSampleCount(0.10002);
  const secondFrames = playlistOutputSampleCount(0.20002);
  assert.equal(firstFrames, 4_801);
  assert.equal(secondFrames, 9_601);
  assert.equal(firstFrames + secondFrames, 14_402);
  assert.equal((firstFrames + secondFrames) / EXPORT_AUDIO_SAMPLE_RATE, 14_402 / 48_000);
});

test("a hard cut uses the first global frame at or after the sample boundary", () => {
  const firstFrames = playlistOutputSampleCount(0.10002);
  const secondFrames = playlistOutputSampleCount(0.20002);
  const first = playlistFrameWindow(0, firstFrames, 30);
  const second = playlistFrameWindow(firstFrames, firstFrames + secondFrames, 30);

  assert.deepEqual(first, { firstFrame: 0, lastFrame: 4 });
  assert.deepEqual(second, { firstFrame: 4, lastFrame: 10 });
  assert.ok(3 / 30 < firstFrames / EXPORT_AUDIO_SAMPLE_RATE);
  assert.ok(4 / 30 >= firstFrames / EXPORT_AUDIO_SAMPLE_RATE);
});

test("non-grid-aligned boundaries preserve one global frame grid at 24, 30, and 60 fps", () => {
  const firstFrames = playlistOutputSampleCount(0.13701);
  const secondFrames = playlistOutputSampleCount(0.25103);
  const boundary = firstFrames / EXPORT_AUDIO_SAMPLE_RATE;
  for (const frameRate of [24, 30, 60]) {
    const previous = playlistFrameWindow(0, firstFrames, frameRate);
    const next = playlistFrameWindow(firstFrames, firstFrames + secondFrames, frameRate);
    const firstAtBoundary = Math.ceil(boundary * frameRate - 1e-9);
    assert.equal(previous.lastFrame, firstAtBoundary);
    assert.equal(next.firstFrame, firstAtBoundary);
    assert.ok((firstAtBoundary - 1) / frameRate < boundary);
    assert.ok(firstAtBoundary / frameRate >= boundary);
  }
});

test("single-track audio sections preserve source format and pad a short audio tail", () => {
  const input = new FakeAudioBuffer({ length: 44_100, numberOfChannels: 1, sampleRate: 44_100 });
  input.getChannelData(0).fill(0.5);
  const sections = [...audioSectionsWithSilence(input, 0, 3, 44_100, 1)];

  assert.deepEqual(
    sections.map((section) => [section.length, section.sampleRate, section.numberOfChannels]),
    [
      [44_100, 44_100, 1],
      [88_200, 44_100, 1],
    ],
  );
  assert.ok(sections[0].getChannelData(0).every((sample) => sample === 0.5));
  assert.ok(sections[1].getChannelData(0).every((sample) => sample === 0));
});

test("single-track selections after source PCM yield correctly formatted silence", () => {
  const input = new FakeAudioBuffer({ length: 44_100, numberOfChannels: 1, sampleRate: 44_100 });
  input.getChannelData(0).fill(0.5);
  const sections = [...audioSectionsWithSilence(input, 2, 3, 44_100, 1)];

  assert.equal(sections.length, 1);
  assert.equal(sections[0].length, 44_100);
  assert.equal(sections[0].sampleRate, 44_100);
  assert.equal(sections[0].numberOfChannels, 1);
  assert.ok(sections[0].getChannelData(0).every((sample) => sample === 0));
});
