import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import { drawVisualization, warmSoundResponse, makeParticles, type LogoLayer } from "./visualizer";
import type { VisualSettings } from "./visual-settings-model";
import type { SubtitleCue } from "./subtitles";
import { dropEnvelope, prepareSound, type PreparedSound } from "./audio-features";
import { initializeDsp } from "./dsp/loader";
import { PcmFeatures } from "./pcm-features";
import { decodeMediaAudio, audioSections } from "./media-audio";
import { COMPRESSED_VIDEO_QUALITY } from "./export-settings";
import { exportFrames, exportSoundAt, type ExportFrameRate } from "./export-timeline";
import {
  ExportRunClock,
  makeExportTimingProfileBase,
  makeExportWorkloadForExport,
  type ExportTimingMeasurement,
  type ExportTimingProfile,
  type RemainingEstimate,
} from "./export-time-estimate";

export type ExportProgress = {
  phase: "Preparing media" | "Rendering frames" | "Finishing file";
  percent: number;
  elapsedMs?: number;
  phaseElapsedMs?: number;
  completedFrames?: number;
  totalFrames?: number;
  frameLoopElapsedMs?: number;
  timingProfile?: ExportTimingProfile;
  remainingEstimate?: RemainingEstimate;
};
export type ExportOptions = {
  file: File;
  start: number;
  end: number;
  width: number;
  height: number;
  settings: VisualSettings;
  subtitles: SubtitleCue[];
  duration: number;
  videoCompression?: boolean;
  frameRate?: ExportFrameRate;
  logo?: LogoLayer | null;
  background?: LogoLayer | null;
  prepared?: PreparedSound;
  reducedMotion?: boolean;
  startedAt: number;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
};

function checkCanceled(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Export canceled", "AbortError");
}

export async function exportVisualVideo({
  file,
  start,
  end,
  width,
  height,
  settings,
  subtitles,
  duration,
  videoCompression = false,
  frameRate = 30,
  logo,
  background,
  prepared,
  reducedMotion,
  startedAt,
  signal,
  onProgress,
}: ExportOptions): Promise<{
  blob: Blob;
  extension: "mp4" | "webm";
  timing: ExportTimingMeasurement;
}> {
  const runClock = new ExportRunClock(startedAt);
  const report = (progress: Omit<ExportProgress, "elapsedMs" | "phaseElapsedMs">) => {
    const timing = runClock.snapshot();
    onProgress({ ...progress, elapsedMs: timing.elapsedMs, phaseElapsedMs: timing.phaseElapsedMs });
  };
  if (!(end > start + 0.05)) throw new Error("Select at least 0.1 seconds to export.");
  if (typeof VideoEncoder === "undefined")
    throw new Error("Fast video export needs WebCodecs. Try an up-to-date browser.");
  // Validate the frame rate before decoder/encoder resources are allocated.
  exportFrames(end - start, frameRate).next();
  checkCanceled(signal);
  report({ phase: "Preparing media", percent: 2 });
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let output: Output<Mp4OutputFormat | WebMOutputFormat, BufferTarget> | null = null;
  let features: PcmFeatures | null = null;
  try {
    const analysisStart = prepared ? 0 : Math.max(0, start - 10);
    const dspReady = initializeDsp();
    const sound =
      prepared ??
      (await prepareSound(await decodeMediaAudio(file, signal, analysisStart, end), signal));
    await dspReady;
    // A bounded fallback supports long-file range exports. Omit automatic drop
    // accents when full-track musical history is unavailable.
    const events = prepared ? sound.events : [];
    const audio = sound.audio && start - analysisStart < sound.audio.duration ? sound.audio : null;
    checkCanceled(signal);
    report({ phase: "Preparing media", percent: 10 });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (videoTrack && !(await videoTrack.canDecode()))
      throw new Error("The video track cannot be decoded for export on this device.");
    const videoSink = videoTrack
      ? new CanvasSink(videoTrack, { width: Math.min(width, 1280) })
      : null;
    const quality = new Quality(videoCompression ? COMPRESSED_VIDEO_QUALITY : "high");
    const audioQuality = new Quality("high");
    const audioChannels = audio?.numberOfChannels ?? 0;
    const sampleRate = audio?.sampleRate ?? 48000;
    const avc = await canEncodeVideo("avc", { width, height, frameRate, quality });
    const aac =
      !audio ||
      (await canEncodeAudio("aac", {
        numberOfChannels: audioChannels,
        sampleRate,
        quality: audioQuality,
      }));
    const mp4 = avc && aac;
    let webmVideo: "vp9" | "vp8" | null = null;
    if (!mp4) {
      webmVideo = (await canEncodeVideo("vp9", { width, height, frameRate, quality }))
        ? "vp9"
        : (await canEncodeVideo("vp8", { width, height, frameRate, quality }))
          ? "vp8"
          : null;
      if (
        !webmVideo ||
        (audio &&
          !(await canEncodeAudio("opus", {
            numberOfChannels: audioChannels,
            sampleRate: 48000,
            quality: audioQuality,
          })))
      ) {
        throw new Error(
          "This device has no compatible fast video and audio encoder for MP4 or WebM.",
        );
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas rendering is unavailable.");
    const target = new BufferTarget();
    output = new Output({ format: mp4 ? new Mp4OutputFormat() : new WebMOutputFormat(), target });
    const videoSource = new CanvasSource(canvas, {
      codec: mp4 ? "avc" : webmVideo!,
      quality,
      latencyMode: "quality",
    });
    output.addVideoTrack(videoSource, { frameRate });
    const audioSource = audio
      ? new AudioBufferSource({
          codec: mp4 ? "aac" : "opus",
          quality: audioQuality,
          ...(!mp4 ? { transform: { sampleRate: 48000 } } : {}),
        })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    if (audioSource && audio)
      for (const section of audioSections(audio, start - analysisStart, end - analysisStart)) {
        checkCanceled(signal);
        await audioSource.add(section);
      }

    const workload = makeExportWorkloadForExport({
      durationSeconds: end - start,
      analysisSeconds: Math.max(0, end - analysisStart),
      preparedAudio: !!prepared,
      settings,
      subtitles: subtitles.length > 0,
      logo: !!logo,
      background: !!background,
      videoOverlay: !!videoTrack,
      reducedMotion: !!reducedMotion,
    });
    const timingProfile: ExportTimingProfile = {
      ...makeExportTimingProfileBase({
        width,
        height,
        frameRate,
        videoCompression,
        sourceKind: videoTrack ? "video" : "audio",
        preparedAudio: !!prepared,
        workload,
      }),
      codec: mp4 ? "avc" : webmVideo!,
      audioIncluded: !!audioSource,
    };

    const sourceAudio = sound.audio;
    features = sourceAudio
      ? new PcmFeatures(
          Array.from({ length: sourceAudio.numberOfChannels }, (_, i) =>
            sourceAudio.getChannelData(i),
          ),
          sourceAudio.sampleRate,
        )
      : null;
    const frameFeatures = features;
    const history = warmSoundResponse(sound.envelopes, settings, start - analysisStart),
      audioState = history.state;
    let lastAnalysisTime = history.lastTime;
    const particles = makeParticles(300);
    const length = end - start;
    const frames = Math.ceil(length * frameRate);
    const silentFrequency = new Uint8Array(2048),
      silentWave = new Uint8Array(4096).fill(128);
    const timestamps = function* () {
      for (let frame = 0; frame < frames; frame++) yield start + frame / frameRate;
    };
    const videoIterator = videoSink?.canvasesAtTimestamps(timestamps());
    let lastVideoFrame: HTMLCanvasElement | OffscreenCanvas | null = null;
    runClock.setPhase("Rendering frames");
    const renderStartedAt = performance.now();
    let lastProgressAt = renderStartedAt;
    report({
      phase: "Rendering frames",
      percent: 12,
      completedFrames: 0,
      totalFrames: frames,
      frameLoopElapsedMs: 0,
      timingProfile,
    });
    for (const { index: frame, time: localTime, duration: frameDuration, keyFrame } of exportFrames(
      length,
      frameRate,
    )) {
      checkCanceled(signal);
      const absoluteTime = start + localTime;
      const analysisTime = absoluteTime - analysisStart;
      const frameData = frameFeatures
        ? exportSoundAt(sound.envelopes, analysisTime, (time) => frameFeatures.at(time, false))
        : null;
      if (videoIterator) {
        const next = await videoIterator.next();
        lastVideoFrame = next.value?.canvas ?? lastVideoFrame;
      }
      drawVisualization(
        context,
        settings,
        silentFrequency,
        silentWave,
        particles,
        start + localTime,
        Math.max(0, analysisTime - lastAnalysisTime) * 1000,
        lastVideoFrame,
        logo,
        audioState,
        sourceAudio?.sampleRate ?? 48000,
        duration,
        subtitles,
        { sound: frameData, background, reducedMotion, drop: dropEnvelope(events, absoluteTime) },
      );
      lastAnalysisTime = analysisTime;
      await videoSource.add(localTime, frameDuration, { keyFrame });
      const completedFrames = frame + 1;
      const now = performance.now();
      if (now - lastProgressAt >= 750 || completedFrames === frames) {
        report({
          phase: "Rendering frames",
          percent: 12 + Math.round((completedFrames / frames) * 83),
          completedFrames,
          totalFrames: frames,
          frameLoopElapsedMs: Math.max(0, now - renderStartedAt),
          timingProfile,
        });
        lastProgressAt = now;
      }
      if (completedFrames % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    checkCanceled(signal);
    runClock.setPhase("Finishing file");
    report({
      phase: "Finishing file",
      percent: 96,
      completedFrames: frames,
      totalFrames: frames,
      frameLoopElapsedMs: Math.max(0, performance.now() - renderStartedAt),
      timingProfile,
    });
    const finishPulse = setInterval(() => {
      if (!signal.aborted)
        report({
          phase: "Finishing file",
          percent: 96,
          completedFrames: frames,
          totalFrames: frames,
          frameLoopElapsedMs: Math.max(0, performance.now() - renderStartedAt),
          timingProfile,
        });
    }, 750);
    try {
      await output.finalize();
    } finally {
      clearInterval(finishPulse);
    }
    checkCanceled(signal);
    if (!target.buffer) throw new Error("The output file was empty.");
    const blob = new Blob([target.buffer], { type: mp4 ? "video/mp4" : "video/webm" });
    const elapsed = runClock.complete();
    const timing: ExportTimingMeasurement = {
      profile: timingProfile,
      frameCount: frames,
      ...elapsed,
    };
    report({
      phase: "Finishing file",
      percent: 100,
      completedFrames: frames,
      totalFrames: frames,
      frameLoopElapsedMs: Math.max(0, performance.now() - renderStartedAt),
      timingProfile,
    });
    return { blob, extension: mp4 ? "mp4" : "webm", timing };
  } catch (error) {
    if (output && output.state !== "finalized" && output.state !== "canceled")
      await output.cancel().catch(() => {});
    throw error;
  } finally {
    features?.dispose();
    input.dispose();
  }
}
