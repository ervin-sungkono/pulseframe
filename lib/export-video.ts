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
import { drawVisualization, warmSoundResponse, makeParticles, type LogoLayer } from "./visualizer";
import type { VisualSettings } from "./visual-settings-model";
import type { SubtitleCue } from "./subtitles";
import { dropEnvelope, prepareSound, type PreparedSound } from "./audio-features";
import { initializeDsp } from "./dsp/loader";
import { PcmFeatures } from "./pcm-features";
import { decodeMediaAudio, audioSections } from "./media-audio";
import {
  EXPORT_AUDIO_MEMORY_BUDGET_BYTES,
  EXPORT_AUDIO_SAMPLE_RATE,
  createSilentAudioBuffer,
  estimateDecodedAudioBudgetForRange,
  estimateAudioNormalizationBudgetForRange,
  normalizeAudioBufferRange,
} from "./audio-normalize";
import { readLocalImage } from "./local-image";
import { resolveTrackMetadata, type ProjectTrack } from "./project-model";
import { buildPlaylistTimeline, clipProjectRange } from "./playlist-timeline";
import type { PlaylistClip } from "./playlist-timeline";
import type { ExportDestination } from "./export-destination";
import {
  assertBlobFallbackWithinBudget,
  preflightExport,
  type ExportPreflightSegment,
  type ExportVideoExtension,
} from "./export-preflight";
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
  segmentIndex?: number;
  totalSegments?: number;
  segmentTitle?: string;
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
  artwork?: LogoLayer | null;
  prepared?: PreparedSound;
  reducedMotion?: boolean;
  startedAt: number;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
  tracks?: ProjectTrack[];
  destination?: ExportDestination;
  filename?: string;
  generation?: number;
};

function checkCanceled(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Export canceled", "AbortError");
}

async function exportSingleVisualVideo({
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
  artwork,
  prepared,
  reducedMotion,
  startedAt,
  signal,
  onProgress,
  destination,
  filename,
  generation,
}: ExportOptions): Promise<{
  blob?: Blob;
  extension: ExportVideoExtension;
  timing: ExportTimingMeasurement;
  saved?: boolean;
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
  const preflight = await preflightExport({
    file,
    width,
    height,
    frameRate,
    videoCompression,
    generation,
  });
  checkCanceled(signal);
  if (!destination)
    assertBlobFallbackWithinBudget({
      durationSeconds: end - start,
      width,
      height,
      frameRate,
      videoCompression,
      audioIncluded: preflight.audioIncluded,
    });
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let output: Output<Mp4OutputFormat | WebMOutputFormat, BufferTarget | StreamTarget> | null = null;
  let features: PcmFeatures | null = null;
  let bufferTarget: BufferTarget | null = null;
  let destinationWriter: Awaited<ReturnType<ExportDestination["createWriter"]>> | null = null;
  try {
    const analysisStart = prepared ? 0 : Math.max(0, start - 10);
    const sourceInfo = preflight.segments[0];
    const dspReady = initializeDsp();
    let decodedAudio: AudioBuffer | null = null;
    if (!prepared && sourceInfo.hasAudio) {
      const decodeEnd = Math.min(end, sourceInfo.audioDuration);
      const decodeDuration = Math.max(0, decodeEnd - analysisStart);
      if (decodeDuration > 0) {
        const budget = estimateDecodedAudioBudgetForRange(
          decodeDuration,
          sourceInfo.sourceSampleRate,
          sourceInfo.sourceChannels,
        );
        if (budget.peakBytes > EXPORT_AUDIO_MEMORY_BUDGET_BYTES)
          throw new Error("Choose a shorter section to export this long media file.");
        decodedAudio = await decodeMediaAudio(file, signal, analysisStart, decodeEnd);
      }
    }
    const sound = prepared ?? (await prepareSound(decodedAudio, signal));
    await dspReady;
    // A bounded fallback supports long-file range exports. Omit automatic drop
    // accents when full-track musical history is unavailable.
    const events = prepared ? sound.events : [];
    const audio = sound.audio;
    if (preflight.audioIncluded && start < sourceInfo.audioDuration && !audio)
      throw new Error("The audio track could not be decoded for the selected export range.");
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
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas rendering is unavailable.");
    if (destination)
      destinationWriter = await destination.createWriter(
        preflight.extension,
        filename || `Pulseframe Export.${preflight.extension}`,
      );
    const target = destinationWriter
      ? new StreamTarget(destinationWriter.stream, { chunked: true })
      : (bufferTarget = new BufferTarget());
    const mp4 = preflight.extension === "mp4";
    const format = mp4
      ? new Mp4OutputFormat(
          destinationWriter ? { fastStart: false, metadataFormat: "mdir" } : undefined,
        )
      : new WebMOutputFormat();
    output = new Output({ format, target });
    const videoSource = new CanvasSource(canvas, {
      codec: preflight.videoCodec,
      quality,
      latencyMode: "quality",
    });
    output.addVideoTrack(videoSource, { frameRate });
    const audioSource = preflight.audioIncluded
      ? new AudioBufferSource({
          codec: preflight.audioCodec!,
          quality: audioQuality,
          ...(!mp4 ? { transform: { sampleRate: 48000 } } : {}),
        })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    const audioSectionsIterator = audioSource
      ? audioSectionsWithSilence(
          audio,
          start - analysisStart,
          end - analysisStart,
          sourceInfo.sourceSampleRate,
          sourceInfo.sourceChannels,
        )
      : null;
    let nextAudioSection = audioSectionsIterator?.next() ?? null;
    let audioFramesFed = 0;
    const feedAudioUntil = async (maxFrames: number) => {
      if (!audioSource || !audioSectionsIterator || !nextAudioSection) return;
      while (!nextAudioSection.done && audioFramesFed < maxFrames) {
        checkCanceled(signal);
        const section = nextAudioSection.value;
        await audioSource.add(section);
        audioFramesFed += section.length;
        nextAudioSection = audioSectionsIterator.next();
      }
    };
    if (audioSource) await feedAudioUntil(sourceInfo.sourceSampleRate * 5);

    const workload = makeExportWorkloadForExport({
      durationSeconds: end - start,
      analysisSeconds: Math.max(0, end - analysisStart),
      preparedAudio: !!prepared,
      settings,
      subtitles: subtitles.length > 0,
      logo: !!logo,
      artwork: !!artwork,
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
        destination: destination ? "file" : "buffer",
        workload,
      }),
      codec: preflight.videoCodec,
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
      if (audioSource)
        await feedAudioUntil(Math.ceil((localTime + 5) * sourceInfo.sourceSampleRate));
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
          sound: frameData,
          background,
          artwork,
          reducedMotion,
          drop: dropEnvelope(events, absoluteTime),
        },
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
    if (audioSource) await feedAudioUntil(Number.MAX_SAFE_INTEGER);
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
    let blob: Blob | undefined;
    let saved = false;
    if (destinationWriter) {
      checkCanceled(signal);
      report({
        phase: "Finishing file",
        percent: 98,
        completedFrames: frames,
        totalFrames: frames,
        timingProfile,
      });
      await destinationWriter.commit();
      checkCanceled(signal);
      saved = true;
    } else {
      if (!bufferTarget?.buffer) throw new Error("The output file was empty.");
      blob = new Blob([bufferTarget.buffer], { type: preflight.mimeType });
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
    return {
      ...(blob ? { blob } : {}),
      extension: preflight.extension,
      timing,
      ...(saved ? { saved: true } : {}),
    };
  } catch (error) {
    if (output && output.state !== "finalized" && output.state !== "canceled")
      await output.cancel().catch(() => {});
    await destinationWriter?.abort(error).catch(() => {});
    throw error;
  } finally {
    features?.dispose();
    input.dispose();
  }
}

type PlaylistRenderSegment = {
  clip: PlaylistClip;
  track: ProjectTrack;
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  sampleFrames: number;
  firstFrame: number;
  lastFrame: number;
  sourceInfo: ExportPreflightSegment;
};

export function playlistOutputSampleCount(durationSeconds: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    throw new Error("Playlist segments need a finite positive duration.");
  return Math.max(1, Math.round(durationSeconds * EXPORT_AUDIO_SAMPLE_RATE));
}

export function playlistFrameWindow(startSample: number, endSample: number, frameRate: number) {
  if (
    !Number.isInteger(startSample) ||
    !Number.isInteger(endSample) ||
    startSample < 0 ||
    endSample <= startSample ||
    !Number.isFinite(frameRate) ||
    frameRate <= 0
  )
    throw new Error("Invalid playlist frame window.");
  const atOrAfter = (samples: number) =>
    Math.max(0, Math.ceil((samples / EXPORT_AUDIO_SAMPLE_RATE) * frameRate - 1e-9));
  return { firstFrame: atOrAfter(startSample), lastFrame: atOrAfter(endSample) };
}

function* silentAudioSections(totalFrames: number) {
  const sectionFrames = EXPORT_AUDIO_SAMPLE_RATE * 5;
  for (let offset = 0; offset < totalFrames; offset += sectionFrames)
    yield createSilentAudioBuffer(Math.min(sectionFrames, totalFrames - offset));
}

function* silentSourceAudioSections(totalFrames: number, sampleRate: number, channels: number) {
  const sectionFrames = sampleRate * 5;
  for (let offset = 0; offset < totalFrames; offset += sectionFrames) {
    const length = Math.min(sectionFrames, totalFrames - offset);
    yield new AudioBuffer({ length, numberOfChannels: channels, sampleRate });
  }
}

/** Supplies the selected source PCM and pads its unavailable tail with silence. */
export function* audioSectionsWithSilence(
  audio: AudioBuffer | null,
  start: number,
  end: number,
  sampleRate: number,
  channels: number,
) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 2
  )
    throw new Error("The selected source audio range is invalid.");
  if (audio && (audio.sampleRate !== sampleRate || audio.numberOfChannels !== channels))
    throw new Error("The decoded audio format changed during export. Recheck the source file.");

  const requestedFrames = Math.round((end - start) * sampleRate);
  if (requestedFrames < 1) return;
  const audioStartFrame = Math.round(start * sampleRate);
  const availableFrames = audio
    ? Math.max(0, Math.min(requestedFrames, audio.length - audioStartFrame))
    : 0;
  if (audio && availableFrames > 0) {
    yield* audioSections(
      audio,
      audioStartFrame / sampleRate,
      (audioStartFrame + availableFrames) / sampleRate,
    );
  }
  const silentFrames = requestedFrames - availableFrames;
  if (silentFrames > 0) yield* silentSourceAudioSections(silentFrames, sampleRate, channels);
}

async function exportPlaylistVisualVideo(options: ExportOptions) {
  const {
    tracks = [],
    start,
    end,
    width,
    height,
    settings,
    videoCompression = false,
    frameRate = 30,
    logo,
    background,
    artwork,
    reducedMotion,
    startedAt,
    signal,
    onProgress,
    destination,
    filename,
    generation,
  } = options;
  const runClock = new ExportRunClock(startedAt);
  const report = (progress: Omit<ExportProgress, "elapsedMs" | "phaseElapsedMs">) => {
    const timing = runClock.snapshot();
    onProgress({ ...progress, elapsedMs: timing.elapsedMs, phaseElapsedMs: timing.phaseElapsedMs });
  };
  if (!tracks.length) throw new Error("Add at least one track to the playlist before exporting.");
  if (!(end > start + 0.05)) throw new Error("Select at least 0.1 seconds to export.");
  exportFrames(end - start, frameRate).next();
  checkCanceled(signal);
  report({ phase: "Preparing media", percent: 2 });
  const timeline = buildPlaylistTimeline(tracks);
  if (!timeline.segments.length || start < 0 || end > timeline.duration + 0.001)
    throw new Error("The selected export range is outside the playlist duration.");
  const clips = clipProjectRange(timeline, [start, end]);
  if (!clips.length) throw new Error("Select a range that contains playlist audio or video.");
  const preflight = await preflightExport({
    tracks,
    range: [start, end],
    width,
    height,
    frameRate,
    videoCompression,
    generation,
  });
  checkCanceled(signal);

  let output: Output<Mp4OutputFormat | WebMOutputFormat, BufferTarget | StreamTarget> | null = null;
  let bufferTarget: BufferTarget | null = null;
  let destinationWriter: Awaited<ReturnType<ExportDestination["createWriter"]>> | null = null;
  const videoCompressionQuality = new Quality(videoCompression ? COMPRESSED_VIDEO_QUALITY : "high");
  const audioQuality = new Quality("high");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas rendering is unavailable.");

  const selectedSegments: PlaylistRenderSegment[] = [];
  let outputFrames = 0;
  for (const clip of clips) {
    const sampleFrames = playlistOutputSampleCount(clip.projectRange[1] - clip.projectRange[0]);
    const sourceInfo = preflight.segments.find((segment) => segment.trackId === clip.trackId)!;
    const firstSample = outputFrames;
    const outputStart = firstSample / EXPORT_AUDIO_SAMPLE_RATE;
    outputFrames += sampleFrames;
    const frameWindow = playlistFrameWindow(firstSample, outputFrames, frameRate);
    const analysisStart = Math.max(0, clip.sourceRange[0] - 10);
    const decodeEnd = Math.min(clip.sourceRange[1], sourceInfo.audioDuration);
    const decodeDuration = Math.max(0, decodeEnd - analysisStart);
    const selectedAudioOverlap =
      sourceInfo.hasAudio && clip.sourceRange[0] < sourceInfo.audioDuration;
    const normalizationBudgetBytes = selectedAudioOverlap
      ? estimateAudioNormalizationBudgetForRange(
          decodeDuration,
          sourceInfo.sourceSampleRate,
          sourceInfo.sourceChannels,
          sampleFrames,
        ).peakBytes
      : decodeDuration > 0
        ? estimateDecodedAudioBudgetForRange(
            decodeDuration,
            sourceInfo.sourceSampleRate,
            sourceInfo.sourceChannels,
          ).peakBytes
        : 0;
    if (normalizationBudgetBytes > EXPORT_AUDIO_MEMORY_BUDGET_BYTES)
      throw new Error(
        `Track “${clip.track.title || clip.track.id}” needs too much memory to decode and convert its selected range to 48 kHz. Choose a shorter section or export tracks separately.`,
      );
    selectedSegments.push({
      clip,
      track: clip.track,
      sourceStart: clip.sourceRange[0],
      sourceEnd: clip.sourceRange[1],
      outputStart,
      outputEnd: outputFrames / EXPORT_AUDIO_SAMPLE_RATE,
      sampleFrames,
      firstFrame: frameWindow.firstFrame,
      lastFrame: frameWindow.lastFrame,
      sourceInfo,
    });
  }
  const outputDuration = outputFrames / EXPORT_AUDIO_SAMPLE_RATE;
  const totalFrames = Math.ceil(outputDuration * frameRate);
  if (!Number.isFinite(outputDuration) || totalFrames < 1)
    throw new Error("Select at least 0.1 seconds to export.");
  if (!destination)
    assertBlobFallbackWithinBudget({
      durationSeconds: outputDuration,
      width,
      height,
      frameRate,
      videoCompression,
      audioIncluded: preflight.audioIncluded,
    });
  const hasAnyVideo = selectedSegments.some((segment) => segment.sourceInfo.hasVideo);
  const analysisSeconds = selectedSegments.reduce(
    (sum, segment) => sum + segment.sourceEnd - Math.max(0, segment.sourceStart - 10),
    0,
  );
  const workload = makeExportWorkloadForExport({
    durationSeconds: outputDuration,
    analysisSeconds,
    preparedAudio: false,
    settings,
    subtitles: selectedSegments.some((segment) => segment.track.subtitles.length > 0),
    logo: !!logo,
    artwork: !!artwork || selectedSegments.some((segment) => !!segment.track.artwork),
    background: !!background,
    videoOverlay: hasAnyVideo,
    reducedMotion: !!reducedMotion,
  });
  const timingProfile: ExportTimingProfile = {
    ...makeExportTimingProfileBase({
      width,
      height,
      frameRate,
      videoCompression,
      sourceKind: hasAnyVideo ? "video" : "audio",
      preparedAudio: false,
      destination: destination ? "file" : "buffer",
      workload,
    }),
    codec: preflight.videoCodec,
    audioIncluded: preflight.audioIncluded,
  };
  const dspReady = initializeDsp();
  const silentFrequency = new Uint8Array(2048);
  const silentWave = new Uint8Array(4096).fill(128);
  let completedFrames = 0;
  let frameLoopElapsedMs = 0;
  let renderStartedAt = 0;
  let lastProgressAt = 0;

  try {
    if (destination)
      destinationWriter = await destination.createWriter(
        preflight.extension,
        filename || `Pulseframe Export.${preflight.extension}`,
      );
    const target = destinationWriter
      ? new StreamTarget(destinationWriter.stream, { chunked: true })
      : (bufferTarget = new BufferTarget());
    const mp4 = preflight.extension === "mp4";
    const format = mp4
      ? new Mp4OutputFormat(
          destinationWriter ? { fastStart: false, metadataFormat: "mdir" } : undefined,
        )
      : new WebMOutputFormat();
    output = new Output({ format, target });
    const videoSource = new CanvasSource(canvas, {
      codec: preflight.videoCodec,
      quality: videoCompressionQuality,
      latencyMode: "quality",
    });
    output.addVideoTrack(videoSource, { frameRate });
    const audioSource = preflight.audioIncluded
      ? new AudioBufferSource({
          codec: preflight.audioCodec!,
          quality: audioQuality,
        })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    await dspReady;
    report({ phase: "Preparing media", percent: 10, totalFrames, timingProfile });

    for (let segmentIndex = 0; segmentIndex < selectedSegments.length; segmentIndex++) {
      const segment = selectedSegments[segmentIndex];
      checkCanceled(signal);
      runClock.setPhase("Preparing media");
      report({
        phase: "Preparing media",
        percent: 10 + Math.floor((segmentIndex / selectedSegments.length) * 2),
        completedFrames,
        totalFrames,
        timingProfile,
        segmentIndex: segmentIndex + 1,
        totalSegments: selectedSegments.length,
        segmentTitle: segment.track.title,
      });

      let input: Input | null = null;
      let frameFeatures: PcmFeatures | null = null;
      let videoIterator: AsyncGenerator<
        import("mediabunny").WrappedCanvas | null,
        void,
        unknown
      > | null = null;
      let localArtwork: Awaited<ReturnType<typeof readLocalImage>> | null = null;
      let lastVideoFrame: HTMLCanvasElement | OffscreenCanvas | null = null;
      try {
        const analysisStart = Math.max(0, segment.sourceStart - 10);
        const decodeEnd = Math.min(segment.sourceEnd, segment.sourceInfo.audioDuration);
        const decodeDuration = Math.max(0, decodeEnd - analysisStart);
        const selectedAudioOverlap =
          segment.sourceInfo.hasAudio && segment.sourceStart < segment.sourceInfo.audioDuration;
        const decodedAudio =
          decodeDuration > 0
            ? await decodeMediaAudio(segment.track.file, signal, analysisStart, decodeEnd)
            : null;
        if (selectedAudioOverlap && !decodedAudio)
          throw new Error("The audio track could not be decoded for the selected range.");
        const sound = await prepareSound(decodedAudio, signal);
        const sourceAudio = sound.audio;
        frameFeatures = sourceAudio
          ? new PcmFeatures(
              Array.from({ length: sourceAudio.numberOfChannels }, (_, channel) =>
                sourceAudio.getChannelData(channel),
              ),
              sourceAudio.sampleRate,
            )
          : null;
        const normalizedAudio =
          audioSource && sourceAudio && selectedAudioOverlap
            ? await normalizeAudioBufferRange(
                sourceAudio,
                segment.sourceStart - analysisStart,
                segment.sourceEnd - analysisStart,
                segment.sampleFrames,
                signal,
              )
            : null;
        if (segment.track.artwork)
          localArtwork = await readLocalImage(segment.track.artwork, "artwork");
        input = new Input({ source: new BlobSource(segment.track.file), formats: ALL_FORMATS });
        const videoTrack = await input.getPrimaryVideoTrack();
        if (videoTrack && !(await videoTrack.canDecode()))
          throw new Error("The video track cannot be decoded for export on this device.");
        const videoSink = videoTrack
          ? new CanvasSink(videoTrack, { width: Math.min(width, 1280) })
          : null;
        const timestamps = function* () {
          for (let frame = segment.firstFrame; frame < segment.lastFrame; frame++) {
            const projectTime = frame / frameRate;
            yield Math.min(
              segment.sourceEnd,
              segment.sourceStart + Math.max(0, projectTime - segment.outputStart),
            );
          }
        };
        videoIterator = videoSink?.canvasesAtTimestamps(timestamps()) ?? null;

        const audioSectionsIterator = audioSource
          ? normalizedAudio
            ? audioSections(normalizedAudio, 0, normalizedAudio.duration)
            : silentAudioSections(segment.sampleFrames)
          : null;
        let nextAudioSection = audioSectionsIterator?.next() ?? null;
        let audioFramesFed = 0;
        const feedAudioUntil = async (maxFrames: number) => {
          if (!audioSource || !audioSectionsIterator || !nextAudioSection) return;
          while (!nextAudioSection.done && audioFramesFed < maxFrames) {
            checkCanceled(signal);
            const section = nextAudioSection.value;
            await audioSource.add(section);
            audioFramesFed += section.length;
            nextAudioSection = audioSectionsIterator.next();
          }
        };
        const clipSettings = resolveTrackMetadata(settings, segment.track);
        const history = warmSoundResponse(
          sound.envelopes,
          clipSettings,
          segment.sourceStart - analysisStart,
        );
        const sourceEvents = sound.events.map((event) => event + analysisStart);
        const audioState = history.state;
        let lastAnalysisTime = history.lastTime;
        const particles = makeParticles(300);

        if (audioSource) await feedAudioUntil(EXPORT_AUDIO_SAMPLE_RATE * 5);
        runClock.setPhase("Rendering frames");
        if (!renderStartedAt) {
          renderStartedAt = performance.now();
          lastProgressAt = renderStartedAt;
          report({
            phase: "Rendering frames",
            percent: 12,
            completedFrames,
            totalFrames,
            frameLoopElapsedMs: 0,
            timingProfile,
            segmentIndex: segmentIndex + 1,
            totalSegments: selectedSegments.length,
            segmentTitle: segment.track.title,
          });
        }
        const segmentRenderStartedAt = performance.now();
        for (let frame = segment.firstFrame; frame < segment.lastFrame; frame++) {
          checkCanceled(signal);
          const outputTime = frame / frameRate;
          const localTime = outputTime - segment.outputStart;
          const sourceTime = Math.min(segment.sourceEnd, segment.sourceStart + localTime);
          if (audioSource) {
            const leadFrames = Math.ceil((localTime + 5) * EXPORT_AUDIO_SAMPLE_RATE);
            await feedAudioUntil(Math.min(segment.sampleFrames, leadFrames));
          }
          const analysisTime = sourceTime - analysisStart;
          const frameData = frameFeatures
            ? exportSoundAt(sound.envelopes, analysisTime, (time) => frameFeatures!.at(time, false))
            : null;
          if (videoIterator) {
            const next = await videoIterator.next();
            lastVideoFrame = next.value?.canvas ?? lastVideoFrame;
          }
          drawVisualization(
            context,
            clipSettings,
            silentFrequency,
            silentWave,
            particles,
            sourceTime,
            Math.max(0, analysisTime - lastAnalysisTime) * 1000,
            lastVideoFrame,
            logo,
            audioState,
            sourceAudio?.sampleRate ?? EXPORT_AUDIO_SAMPLE_RATE,
            segment.track.duration,
            segment.track.subtitles,
            {
              sound: frameData,
              background,
              artwork: localArtwork?.image ?? artwork ?? null,
              reducedMotion,
              drop: dropEnvelope(sourceEvents, sourceTime),
            },
          );
          lastAnalysisTime = analysisTime;
          const frameDuration = Math.min(1 / frameRate, outputDuration - outputTime);
          await videoSource.add(outputTime, frameDuration, {
            keyFrame: frame % (frameRate * 2) === 0,
          });
          completedFrames++;
          const now = performance.now();
          if (now - lastProgressAt >= 750 || completedFrames === totalFrames) {
            report({
              phase: "Rendering frames",
              percent: 12 + Math.round((completedFrames / totalFrames) * 83),
              completedFrames,
              totalFrames,
              frameLoopElapsedMs: frameLoopElapsedMs + Math.max(0, now - segmentRenderStartedAt),
              timingProfile,
              segmentIndex: segmentIndex + 1,
              totalSegments: selectedSegments.length,
              segmentTitle: segment.track.title,
            });
            lastProgressAt = now;
          }
          if (completedFrames % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (audioSource) await feedAudioUntil(segment.sampleFrames);
        frameLoopElapsedMs += Math.max(0, performance.now() - segmentRenderStartedAt);
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : "The track could not be prepared.";
        throw new Error(
          `Track “${segment.track.title || segment.track.id}” could not be exported: ${message}`,
          {
            cause: error,
          },
        );
      } finally {
        frameFeatures?.dispose();
        await videoIterator?.return?.().catch(() => {});
        input?.dispose();
        if (localArtwork) URL.revokeObjectURL(localArtwork.url);
      }
    }

    checkCanceled(signal);
    runClock.setPhase("Finishing file");
    report({
      phase: "Finishing file",
      percent: 96,
      completedFrames,
      totalFrames,
      frameLoopElapsedMs,
      timingProfile,
    });
    const finishPulse = setInterval(() => {
      if (!signal.aborted)
        report({
          phase: "Finishing file",
          percent: 96,
          completedFrames,
          totalFrames,
          frameLoopElapsedMs,
          timingProfile,
        });
    }, 750);
    try {
      await output.finalize();
    } finally {
      clearInterval(finishPulse);
    }
    checkCanceled(signal);
    let blob: Blob | undefined;
    let saved = false;
    if (destinationWriter) {
      report({ phase: "Finishing file", percent: 98, completedFrames, totalFrames, timingProfile });
      checkCanceled(signal);
      await destinationWriter.commit();
      checkCanceled(signal);
      saved = true;
    } else {
      if (!bufferTarget?.buffer) throw new Error("The output file was empty.");
      blob = new Blob([bufferTarget.buffer], { type: preflight.mimeType });
    }
    const elapsed = runClock.complete();
    const timing: ExportTimingMeasurement = {
      profile: timingProfile,
      frameCount: totalFrames,
      ...elapsed,
    };
    report({
      phase: "Finishing file",
      percent: 100,
      completedFrames,
      totalFrames,
      frameLoopElapsedMs,
      timingProfile,
    });
    return {
      ...(blob ? { blob } : {}),
      extension: preflight.extension,
      timing,
      ...(saved ? { saved: true } : {}),
    };
  } catch (error) {
    if (output && output.state !== "finalized" && output.state !== "canceled")
      await output.cancel().catch(() => {});
    await destinationWriter?.abort(error).catch(() => {});
    throw error;
  }
}

export async function exportVisualVideo(options: ExportOptions): Promise<{
  blob?: Blob;
  extension: ExportVideoExtension;
  timing: ExportTimingMeasurement;
  saved?: boolean;
}> {
  return options.tracks?.length
    ? exportPlaylistVisualVideo(options)
    : exportSingleVisualVideo(options);
}
