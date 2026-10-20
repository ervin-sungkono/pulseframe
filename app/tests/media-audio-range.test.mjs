import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();

class TestAudioBuffer {
  constructor({ length, sampleRate, numberOfChannels }) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.numberOfChannels = numberOfChannels;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel) {
    return this.channels[channel];
  }

  copyToChannel(samples, channel, offset = 0) {
    this.channels[channel].set(samples.subarray(0, this.length - offset), offset);
  }
}

test("nonzero-start range decode matches the corresponding full-track PCM", async () => {
  globalThis.AudioBuffer = TestAudioBuffer;
  try {
    const { decodeMediaAudio } = modules["media-audio"];
    const file = modules["demo-file"].makeDemoFile();
    const full = await decodeMediaAudio(file);
    const start = 1.013;
    const end = 1.527;
    const section = await decodeMediaAudio(file, undefined, start, end);
    const sourceOffset = Math.round(start * full.sampleRate);

    assert.ok(full);
    assert.ok(section);
    assert.equal(section.length, Math.ceil((end - start) * full.sampleRate));
    for (let channel = 0; channel < full.numberOfChannels; channel += 1) {
      assert.deepEqual(
        section.getChannelData(channel),
        full.getChannelData(channel).subarray(sourceOffset, sourceOffset + section.length),
      );
    }
  } finally {
    delete globalThis.AudioBuffer;
  }
});
