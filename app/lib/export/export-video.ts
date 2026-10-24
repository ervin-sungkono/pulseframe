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
  StreamTarget,
  WebMOutputFormat,
} from "mediabunny";
import {
  drawVisualization,
  warmSoundResponse,
  makeParticles,
  type LogoLayer,
} from "../visual/visualizer";
import type { VisualSettings } from "../visual/visual-settings-model";
import type { SubtitleCue } from "../subtitles/model";
import type { Composition, CompositionImages } from "../composition/model";
import { temporalAt } from "../audio/audio-features";
import { dropEnvelope, prepareSound, type PreparedSound } from "../audio/audio-features";
import { initializeDsp } from "../dsp/loader";
import { PcmFeatures } from "../audio/pcm-features";
import { decodeMediaAudio, audioSections } from "../media/media-audio";
import {
  COMPRESSED_VIDEO_QUALITY,
  DEFAULT_EXPORT_FRAME_RATE,
  isSupportedExportDimensions,
  type ExportFrameRate,
} from "./export-settings";
import { probeExportCapabilities, type ExportCodecCapabilities } from "./export-codec-capabilities";
import { createExportFileTarget, type ExportDestination } from "./export-file-target";
import { bufferedExportLimitBytes, createEncodedPacketBudget } from "./export-memory-budget";
import { exportAnalysisStart, exportFrames, exportSoundAt } from "./export-timeline";
import { PreparedFrequencyHistory } from "../visual/styles/frequency-history";
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
  /** False once a file save is committing and can no longer be canceled. */
  canCancel?: boolean;
};
export type ExportOptions = {
  file: File;
  start: number;
  end: number;
  width: number;
  height: number;
  settings: VisualSettings;
  subtitles: SubtitleCue[];
  composition?: Composition;
  images?: CompositionImages;
  duration: number;
  videoCompression?: boolean;
  frameRate?: ExportFrameRate;
  logo?: LogoLayer | null;
  background?: LogoLayer | null;
  destination?: ExportDestination;
  /** Optional scene-workload details supplied by the composition owner. */
  instanceCount?: number;
  compositionComplexity?: string;
  prepared?: PreparedSound;
  reducedMotion?: boolean;
  startedAt: number;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
};

export type ExportResult =
  | {
      kind: "buffer";
      blob: Blob;
      extension: "mp4" | "webm";
      timing: ExportTimingMeasurement;
    }
  | { kind: "file"; extension: "mp4" | "webm"; timing: ExportTimingMeasurement };

export type { ExportDestination } from "./export-file-target";

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
  composition,
  images,
  duration,
  videoCompression = false,
  frameRate = DEFAULT_EXPORT_FRAME_RATE,
  logo,
  background,
  prepared,
  reducedMotion,
  destination,
  instanceCount,
  compositionComplexity,
  startedAt,
  signal,
  onProgress,
}: ExportOptions): Promise<ExportResult> {
  const runClock = new ExportRunClock(startedAt);
  const report = (progress: Omit<ExportProgress, "elapsedMs" | "phaseElapsedMs">) => {
    const timing = runClock.snapshot();
    try {
      onProgress({
        ...progress,
        elapsedMs: timing.elapsedMs,
        phaseElapsedMs: timing.phaseElapsedMs,
      });
    } catch {
      // UI progress listeners must not turn a completed file into a reported failure.
    }
  };
  if (!(end > start + 0.05)) throw new Error("Select at least 0.1 seconds to export.");
  if (!isSupportedExportDimensions(width, height))
    throw new Error("Choose one of the supported export sizes up to 4K.");
  if (typeof VideoEncoder === "undefined")
    throw new Error("Fast video export needs WebCodecs. Try an up-to-date browser.");
  // Validate the frame rate before decoder/encoder resources are allocated.
  exportFrames(end - start, frameRate).next();
  checkCanceled(signal);
  report({ phase: "Preparing media", percent: 2 });
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let output: Output<Mp4OutputFormat | WebMOutputFormat, BufferTarget | StreamTarget> | null = null;
  let fileTarget: Awaited<ReturnType<typeof createExportFileTarget>> | null = null;
  let features: PcmFeatures | null = null;
  try {
    const analysisStart = prepared ? 0 : exportAnalysisStart(start, settings);
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
    const videoSourceWidth = videoTrack?.displayWidth;
    const videoSink = videoTrack
      ? new CanvasSink(videoTrack, {
          width:
            typeof videoSourceWidth === "number" && videoSourceWidth > 0
              ? Math.min(width, videoSourceWidth)
              : width,
        })
      : null;
    const audioChannels = audio?.numberOfChannels ?? 0;
    const sampleRate = audio?.sampleRate ?? 48000;
    const capabilities: ExportCodecCapabilities = await probeExportCapabilities({
      width,
      height,
      frameRate,
      videoCompression,
      ...(audio ? { audio: { numberOfChannels: audioChannels, sampleRate } } : {}),
    });
    if (!capabilities.supported) throw new Error(capabilities.message);
    const mp4 = capabilities.extension === "mp4";
    const videoCodec = capabilities.videoCodec;
    const audioCodec = capabilities.audioCodec;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas rendering is unavailable.");
    const packetBudget = destination ? null : createEncodedPacketBudget(bufferedExportLimitBytes());
    fileTarget = destination ? await createExportFileTarget(destination) : null;
    const target = fileTarget?.target ?? new BufferTarget();
    const format = mp4
      ? new Mp4OutputFormat(destination ? { fastStart: false } : undefined)
      : new WebMOutputFormat();
    output = new Output({ format, target });
    const videoSource = new CanvasSource(canvas, {
      codec: videoCodec,
      quality: new Quality(videoCompression ? COMPRESSED_VIDEO_QUALITY : "high"),
      latencyMode: "quality",
      onEncodedPacket: packetBudget?.onPacket,
    });
    output.addVideoTrack(videoSource, { frameRate });
    const audioSource = audio
      ? new AudioBufferSource({
          codec: audioCodec!,
          quality: new Quality("high"),
          ...(!mp4 ? { transform: { sampleRate: 48000 } } : {}),
          onEncodedPacket: packetBudget?.onPacket,
        })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    const audioIterator =
      audioSource && audio
        ? audioSections(audio, start - analysisStart, end - analysisStart)[Symbol.iterator]()
        : null;
    let nextAudioSection = audioIterator?.next() ?? { done: true as const, value: undefined };
    let audioSecondsAdded = 0;
    const addAudioThrough = async (untilSeconds: number) => {
      while (
        audioSource &&
        audioIterator &&
        !nextAudioSection.done &&
        audioSecondsAdded + nextAudioSection.value.duration <= untilSeconds + 1e-9
      ) {
        checkCanceled(signal);
        await audioSource.add(nextAudioSection.value);
        audioSecondsAdded += nextAudioSection.value.duration;
        packetBudget?.throwIfExceeded();
        nextAudioSection = audioIterator.next();
      }
    };

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
      instanceCount,
      compositionComplexity,
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
      codec: videoCodec,
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
    const frequencyHistory = new PreparedFrequencyHistory(sound.envelopes, analysisStart);
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
        {
          composition,
          images,
          onset: prepared ? temporalAt(prepared, absoluteTime)?.onsetEnvelope : undefined,
          sound: frameData,
          background,
          reducedMotion,
          drop: dropEnvelope(events, absoluteTime),
          history: frequencyHistory,
        },
      );
      lastAnalysisTime = analysisTime;
      await videoSource.add(localTime, frameDuration, { keyFrame });
      packetBudget?.throwIfExceeded();
      await addAudioThrough(localTime + frameDuration);
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
    while (audioIterator && !nextAudioSection.done) {
      checkCanceled(signal);
      await audioSource!.add(nextAudioSection.value);
      audioSecondsAdded += nextAudioSection.value.duration;
      packetBudget?.throwIfExceeded();
      nextAudioSection = audioIterator.next();
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
    packetBudget?.throwIfExceeded();
    checkCanceled(signal);
    if (fileTarget) {
      await fileTarget.commit(() => {
        report({
          phase: "Finishing file",
          percent: 99,
          completedFrames: frames,
          totalFrames: frames,
          frameLoopElapsedMs: Math.max(0, performance.now() - renderStartedAt),
          timingProfile,
          canCancel: false,
        });
      });
    } else if (!(target instanceof BufferTarget) || !target.buffer) {
      throw new Error("The output file was empty.");
    }
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
    if (fileTarget) return { kind: "file", extension: capabilities.extension, timing };
    const blob = new Blob([(target as BufferTarget).buffer!], {
      type: mp4 ? "video/mp4" : "video/webm",
    });
    return { kind: "buffer", blob, extension: capabilities.extension, timing };
  } catch (error) {
    if (output && output.state !== "finalized" && output.state !== "canceled")
      await output.cancel().catch(() => {});
    await fileTarget?.abort(error).catch(() => {});
    throw error;
  } finally {
    features?.dispose();
    input.dispose();
  }
}
