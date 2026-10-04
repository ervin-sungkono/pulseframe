import {
  ALL_FORMATS, AudioBufferSource, BlobSource, BufferTarget,
  CanvasSink, CanvasSource, Input, Mp4OutputFormat, Output, Quality,
  WebMOutputFormat, canEncodeAudio, canEncodeVideo,
} from "mediabunny";
import { drawVisualization, warmSoundResponse, makeParticles, type LogoLayer, type VisualSettings } from "./visualizer";
import type { SubtitleCue } from "./subtitles";
import { PcmFeatures, dropEnvelope, prepareSound, type PreparedSound } from "./audio-features";
import { decodeMediaAudio, audioSections } from "./media-audio";

export type ExportProgress = { phase: "Preparing media" | "Rendering frames" | "Finishing file"; percent: number };
export type ExportOptions = {
  file: File;
  start: number;
  end: number;
  width: number;
  height: number;
  settings: VisualSettings;
  subtitles: SubtitleCue[];
  duration: number;
  profile: "standard" | "smaller";
  logo?: LogoLayer | null;
  background?: LogoLayer | null;
  prepared?: PreparedSound;
  reducedMotion?: boolean;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
};

const FPS = 30;

function checkCanceled(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Export canceled", "AbortError");
}

export async function exportVisualVideo({
  file, start, end, width, height, settings, subtitles, duration, profile, logo, background, prepared, reducedMotion, signal, onProgress,
}: ExportOptions): Promise<{ blob: Blob; extension: "mp4" | "webm" }> {
  if (!(end > start + .05)) throw new Error("Select at least 0.1 seconds to export.");
  if (typeof VideoEncoder === "undefined") throw new Error("Fast video export needs WebCodecs. Try an up-to-date browser.");
  checkCanceled(signal);
  onProgress({ phase: "Preparing media", percent: 2 });
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let output: Output<Mp4OutputFormat | WebMOutputFormat, BufferTarget> | null = null;
  try {
    const analysisStart = prepared ? 0 : Math.max(0, start - 10);
    const sound = prepared ?? await prepareSound(await decodeMediaAudio(file, signal, analysisStart, end), signal);
    // A bounded fallback supports long-file range exports. Omit automatic drop
    // accents when full-track musical history is unavailable.
    const events = prepared ? sound.events : [];
    const audio = sound.audio && start - analysisStart < sound.audio.duration ? sound.audio : null;
    checkCanceled(signal);
    onProgress({ phase: "Preparing media", percent: 10 });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (videoTrack && !await videoTrack.canDecode()) throw new Error("The video track cannot be decoded for export on this device.");
    const videoSink = videoTrack ? new CanvasSink(videoTrack, { width: Math.min(width, 1280) }) : null;
    const quality = new Quality(profile === "smaller" ? "medium" : "high");
    const audioChannels = audio?.numberOfChannels ?? 0;
    const sampleRate = audio?.sampleRate ?? 48000;
    const avc = await canEncodeVideo("avc", { width, height, frameRate: FPS, quality });
    const aac = !audio || await canEncodeAudio("aac", { numberOfChannels: audioChannels, sampleRate, quality });
    const mp4 = avc && aac;
    let webmVideo: "vp9" | "vp8" | null = null;
    if (!mp4) {
      webmVideo = await canEncodeVideo("vp9", { width, height, frameRate: FPS, quality }) ? "vp9"
        : await canEncodeVideo("vp8", { width, height, frameRate: FPS, quality }) ? "vp8" : null;
      if (!webmVideo || (audio && !await canEncodeAudio("opus", { numberOfChannels: audioChannels, sampleRate: 48000, quality }))) {
        throw new Error("This device has no compatible fast video and audio encoder for MP4 or WebM.");
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas rendering is unavailable.");
    const target = new BufferTarget();
    output = new Output({ format: mp4 ? new Mp4OutputFormat() : new WebMOutputFormat(), target });
    const videoSource = new CanvasSource(canvas, { codec: mp4 ? "avc" : webmVideo!, quality });
    output.addVideoTrack(videoSource, { frameRate: FPS });
    const audioSource = audio ? new AudioBufferSource({
      codec: mp4 ? "aac" : "opus", quality,
      ...(!mp4 ? { transform: { sampleRate: 48000 } } : {}),
    }) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    if (audioSource && audio) for (const section of audioSections(audio, start - analysisStart, end - analysisStart)) {
      checkCanceled(signal); await audioSource.add(section);
    }

    const sourceAudio = sound.audio;
    const features = sourceAudio ? new PcmFeatures(Array.from({ length: sourceAudio.numberOfChannels }, (_, i) => sourceAudio.getChannelData(i)), sourceAudio.sampleRate) : null;
    const history = warmSoundResponse(sound.envelopes, settings, start - analysisStart), audioState = history.state;
    let lastAnalysisTime = history.lastTime;
    const particles = makeParticles(300);
    const length = end - start;
    const frames = Math.ceil(length * FPS);
    const timestamps = function* () {
      for (let frame = 0; frame < frames; frame++) yield start + frame / FPS;
    };
    const videoIterator = videoSink?.canvasesAtTimestamps(timestamps());
    let lastVideoFrame: HTMLCanvasElement | OffscreenCanvas | null = null;
    for (let frame = 0; frame < frames; frame++) {
      checkCanceled(signal);
      const localTime = frame / FPS;
      const absoluteTime = start + localTime;
      const analysisTime = absoluteTime - analysisStart;
      const frameData = features?.at(analysisTime);
      if (videoIterator) {
        const next = await videoIterator.next();
        lastVideoFrame = next.value?.canvas ?? lastVideoFrame;
      }
      drawVisualization(context, settings, frameData?.frequency ?? new Uint8Array(2048), frameData?.wave ?? new Uint8Array(4096).fill(128), particles,
        start + localTime, Math.max(0, analysisTime - lastAnalysisTime) * 1000, lastVideoFrame, logo, audioState, sourceAudio?.sampleRate ?? 48000,
        duration, subtitles, { sound: frameData, background, reducedMotion, drop: dropEnvelope(events, absoluteTime) });
      lastAnalysisTime = analysisTime;
      await videoSource.add(localTime, Math.min(1 / FPS, length - localTime), { keyFrame: frame % (FPS * 2) === 0 });
      if (frame % 10 === 0 || frame === frames - 1) {
        onProgress({ phase: "Rendering frames", percent: 12 + Math.round((frame + 1) / frames * 83) });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    checkCanceled(signal);
    onProgress({ phase: "Finishing file", percent: 96 });
    await output.finalize();
    if (!target.buffer) throw new Error("The output file was empty.");
    onProgress({ phase: "Finishing file", percent: 100 });
    return { blob: new Blob([target.buffer], { type: mp4 ? "video/mp4" : "video/webm" }), extension: mp4 ? "mp4" : "webm" };
  } catch (error) {
    if (output && output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => {});
    throw error;
  } finally {
    input.dispose();
  }
}
