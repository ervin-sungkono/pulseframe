import { File } from "node:buffer";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const { invalidateExportPreflight, preflightExport } = (
  await loadSources({
    modules: [
      "audio-analysis-config",
      "audio-normalize",
      "export-settings",
      "export-timeline",
      "project-model",
      "playlist-timeline",
      "export-preflight",
    ],
  })
)["export-preflight"];

const originalVideoEncoder = Object.getOwnPropertyDescriptor(globalThis, "VideoEncoder");
const originalAudioEncoder = Object.getOwnPropertyDescriptor(globalThis, "AudioEncoder");

after(() => {
  restoreGlobal("VideoEncoder", originalVideoEncoder);
  restoreGlobal("AudioEncoder", originalAudioEncoder);
  invalidateExportPreflight();
});

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

function makeWavFile(frameCount, sampleRate) {
  const dataBytes = frameCount * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);
  return new File([bytes], "short-audio.wav", { type: "audio/wav" });
}

test("preflight records the source audio duration and format", async () => {
  class FakeVideoEncoder {
    static async isConfigSupported(config) {
      return { config, supported: true };
    }
  }
  class FakeAudioEncoder {
    static async isConfigSupported(config) {
      return { config, supported: true };
    }
  }

  Object.defineProperty(globalThis, "VideoEncoder", {
    configurable: true,
    writable: true,
    value: FakeVideoEncoder,
  });
  Object.defineProperty(globalThis, "AudioEncoder", {
    configurable: true,
    writable: true,
    value: FakeAudioEncoder,
  });
  invalidateExportPreflight();

  const sourceDuration = 0.5;
  const preflight = await preflightExport({
    file: makeWavFile(22_050, 44_100),
    width: 640,
    height: 360,
    frameRate: 30,
  });

  assert.equal(preflight.audioIncluded, true);
  assert.equal(preflight.segments.length, 1);
  assert.equal(preflight.segments[0].hasAudio, true);
  assert.equal(preflight.segments[0].audioDuration, sourceDuration);
  assert.equal(preflight.segments[0].sourceChannels, 1);
  assert.equal(preflight.segments[0].sourceSampleRate, 44_100);
});
