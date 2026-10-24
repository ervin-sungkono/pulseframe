import { COMPRESSED_VIDEO_QUALITY } from "./export-settings";
import type { ExportFrameRate } from "./export-settings";

export type ExportAudioConfiguration = {
  numberOfChannels: number;
  sampleRate: number;
};

export type ExportCapabilityRequest = {
  width: number;
  height: number;
  frameRate: ExportFrameRate;
  videoCompression: boolean;
  audio?: ExportAudioConfiguration;
};

export type ExportCodecCapabilities =
  | {
      supported: true;
      extension: "mp4" | "webm";
      videoCodec: "avc" | "vp9" | "vp8";
      audioCodec: "aac" | "opus" | null;
    }
  | { supported: false; message: string };

const settled = new Map<string, ExportCodecCapabilities>();
const inFlight = new Map<string, Promise<ExportCodecCapabilities>>();

function capabilityKey(request: ExportCapabilityRequest) {
  return JSON.stringify({
    width: request.width,
    height: request.height,
    frameRate: request.frameRate,
    videoCompression: request.videoCompression,
    audio: request.audio
      ? {
          numberOfChannels: request.audio.numberOfChannels,
          sampleRate: request.audio.sampleRate,
        }
      : null,
  });
}

async function findCapabilities(
  request: ExportCapabilityRequest,
): Promise<ExportCodecCapabilities> {
  const { Quality, canEncodeAudio, canEncodeVideo } = await import("mediabunny");
  const quality = new Quality(request.videoCompression ? COMPRESSED_VIDEO_QUALITY : "high");
  const audioQuality = new Quality("high");
  const { width, height, frameRate, audio } = request;
  const avc = await canEncodeVideo("avc", { width, height, frameRate, quality });
  const aac =
    !audio ||
    (await canEncodeAudio("aac", {
      numberOfChannels: audio.numberOfChannels,
      sampleRate: audio.sampleRate,
      quality: audioQuality,
    }));

  if (avc && aac)
    return {
      supported: true,
      extension: "mp4",
      videoCodec: "avc",
      audioCodec: audio ? "aac" : null,
    };

  const vp9 = await canEncodeVideo("vp9", { width, height, frameRate, quality });
  const vp8 = vp9 ? false : await canEncodeVideo("vp8", { width, height, frameRate, quality });
  const opus =
    !audio ||
    (await canEncodeAudio("opus", {
      numberOfChannels: audio.numberOfChannels,
      sampleRate: 48000,
      quality: audioQuality,
    }));
  const videoCodec = vp9 ? "vp9" : vp8 ? "vp8" : null;
  if (videoCodec && opus)
    return {
      supported: true,
      extension: "webm",
      videoCodec,
      audioCodec: audio ? "opus" : null,
    };

  return {
    supported: false,
    message:
      "This device has no compatible fast video and audio encoder for the selected resolution and frame rate.",
  };
}

/** Probe exact output settings once, for both the export and a save-picker preflight. */
export function probeExportCapabilities(
  request: ExportCapabilityRequest,
): Promise<ExportCodecCapabilities> {
  const key = capabilityKey(request);
  const result = settled.get(key);
  if (result) return Promise.resolve(result);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = findCapabilities(request)
    .catch((): ExportCodecCapabilities => ({
      supported: false,
      message:
        "The browser could not verify an encoder for these export settings. Try another resolution or frame rate.",
    }))
    .then((capabilities) => {
      settled.set(key, capabilities);
      while (settled.size > 64) settled.delete(settled.keys().next().value!);
      inFlight.delete(key);
      return capabilities;
    });
  inFlight.set(key, promise);
  return promise;
}

/** Read a completed preflight synchronously from a user-gesture handler. */
export function getCachedExportCapabilities(
  request: ExportCapabilityRequest,
): ExportCodecCapabilities | null {
  return settled.get(capabilityKey(request)) ?? null;
}

/** Clears cached probes; exported for tests and browser-context resets. */
export function clearExportCapabilityCache() {
  settled.clear();
  inFlight.clear();
}
