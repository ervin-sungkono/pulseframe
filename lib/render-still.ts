import { ANALYSIS_SIZE } from "./audio-analysis-config";
import { dropEnvelope, type SoundFrame } from "./audio-features";
import type { MediaSessionSnapshot } from "./media-session";
import { exportDimensions, type ExportAspect } from "./export-settings";
import type { SubtitleCue } from "./subtitles";
import { drawVisualization, makeParticles, soundResponse, warmSoundResponse } from "./visualizer";
import type { VisualSettings } from "./visual-settings-model";

export type RenderStillFrameRequest = {
  snapshot: MediaSessionSnapshot;
  settings: VisualSettings;
  subtitles: SubtitleCue[];
  aspect: ExportAspect;
  time: number;
  width?: number;
  height?: number;
  signal?: AbortSignal;
};

const abortError = () => new DOMException("Still rendering canceled.", "AbortError");

function checkCanceled(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function waitForMediaEvent(
  media: HTMLMediaElement,
  eventName: "loadeddata" | "loadedmetadata" | "seeked",
  signal?: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const cleanup = () => {
      media.removeEventListener(eventName, onReady);
      media.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not decode the selected video frame."));
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    media.addEventListener(eventName, onReady, { once: true });
    media.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Decode a selected frame on an independent media element without seeking the preview. */
async function selectedVideoFrame(
  snapshot: MediaSessionSnapshot,
  time: number,
  signal?: AbortSignal,
) {
  if (!snapshot.video || !snapshot.file) return { frame: null, cleanup: () => {} };
  checkCanceled(signal);
  const video = document.createElement("video");
  const url = URL.createObjectURL(snapshot.file);
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    const metadata = waitForMediaEvent(video, "loadedmetadata", signal);
    video.src = url;
    await metadata;
    const target = Math.max(
      0,
      Math.min(Number.isFinite(video.duration) ? video.duration : time, time),
    );
    if (Math.abs(video.currentTime - target) > 0.01) {
      const seeked = waitForMediaEvent(video, "seeked", signal);
      video.currentTime = target;
      await seeked;
    }
    if (video.readyState < 2) await waitForMediaEvent(video, "loadeddata", signal);
    checkCanceled(signal);
    return {
      frame: video,
      cleanup: () => {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
      },
    };
  } catch (error) {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
    throw error;
  }
}

function copySoundFrame(frame: SoundFrame | null) {
  if (!frame) return null;
  return {
    ...frame,
    frequency: new Uint8Array(frame.frequency),
    wave: new Uint8Array(frame.wave),
    bands: frame.bands.map((channel) => new Float32Array(channel)),
    channels: frame.channels.map((channel) => ({
      amplitudes: new Float64Array(channel.amplitudes),
      db: new Float32Array(channel.db),
    })),
  } as SoundFrame;
}

function toBlob(canvas: HTMLCanvasElement, signal?: AbortSignal) {
  return new Promise<Blob>((resolve, reject) => {
    checkCanceled(signal);
    canvas.toBlob((blob) => {
      if (signal?.aborted) reject(abortError());
      else if (blob) resolve(blob);
      else reject(new Error("Could not create the thumbnail image."));
    }, "image/png");
  });
}

/** Render a still from immutable media/session inputs without changing preview state. */
export async function renderStillFrameCanvas(request: RenderStillFrameRequest) {
  const { snapshot, settings, subtitles, aspect, signal } = request;
  const dimensions =
    request.width && request.height
      ? { width: request.width, height: request.height }
      : exportDimensions(aspect, aspect === "square" ? 1080 : 720);
  const time = Math.max(
    0,
    Math.min(snapshot.duration, Number.isFinite(request.time) ? request.time : 0),
  );
  checkCanceled(signal);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Could not create the thumbnail canvas.");

  const frame = copySoundFrame(snapshot.features?.at(time, false) ?? null);
  const envelopes = snapshot.sound?.envelopes ?? [];
  const warmed = warmSoundResponse(envelopes, settings, time);
  const audioState = warmed.state;
  if (frame) soundResponse(frame, settings, audioState, Math.max(0, time - warmed.lastTime) * 1000);
  const frequency = frame?.frequency ?? new Uint8Array(ANALYSIS_SIZE / 2);
  const wave = frame?.wave ?? new Uint8Array(ANALYSIS_SIZE).fill(128);
  const video = await selectedVideoFrame(snapshot, time, signal);
  try {
    checkCanceled(signal);
    drawVisualization(
      context,
      settings,
      frequency,
      wave,
      makeParticles(300),
      time,
      0,
      video.frame,
      snapshot.logo?.image ?? null,
      audioState,
      frame?.sampleRate ?? snapshot.sound?.audio?.sampleRate ?? 48000,
      snapshot.duration,
      subtitles,
      {
        sound: frame,
        background: snapshot.background?.image ?? null,
        artwork: snapshot.artwork?.image ?? null,
        drop: dropEnvelope(snapshot.sound?.events ?? [], time),
        reducedMotion: false,
      },
    );
    checkCanceled(signal);
    return canvas;
  } finally {
    video.cleanup();
  }
}

export async function renderStillFrame(request: RenderStillFrameRequest): Promise<Blob> {
  const canvas = await renderStillFrameCanvas(request);
  return toBlob(canvas, request.signal);
}
