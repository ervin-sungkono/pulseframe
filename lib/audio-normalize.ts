import { ANALYSIS_FPS } from "./audio-analysis-config";

export const EXPORT_AUDIO_SAMPLE_RATE = 48_000;
export const EXPORT_AUDIO_CHANNELS = 2;
export const EXPORT_AUDIO_MEMORY_BUDGET_BYTES = 300 * 1024 * 1024;

const ENVELOPE_BYTES_PER_ANALYSIS_SAMPLE_PER_CHANNEL = 96 * 4 + 128;

export type AudioNormalizationBudget = {
  peakBytes: number;
  sourceBytes: number;
  convertedBytes: number;
  historyBytes: number;
};

function audioBufferBytes(length: number, channels: number) {
  return length * channels * Float32Array.BYTES_PER_ELEMENT;
}

export function estimateAudioNormalizationBudget(
  audio: Pick<AudioBuffer, "length" | "numberOfChannels" | "sampleRate" | "duration">,
  targetFrameCount = Math.round(audio.duration * EXPORT_AUDIO_SAMPLE_RATE),
): AudioNormalizationBudget {
  const sourceBytes = audioBufferBytes(audio.length, audio.numberOfChannels);
  const isAlreadyNormalized =
    audio.sampleRate === EXPORT_AUDIO_SAMPLE_RATE &&
    audio.numberOfChannels === EXPORT_AUDIO_CHANNELS &&
    audio.length === targetFrameCount;
  const convertedBytes = isAlreadyNormalized
    ? 0
    : audioBufferBytes(targetFrameCount, EXPORT_AUDIO_CHANNELS);
  const historyBytes = estimateAnalysisHistoryBytes(audio.duration, audio.numberOfChannels);
  return {
    peakBytes: sourceBytes + convertedBytes + historyBytes,
    sourceBytes,
    convertedBytes,
    historyBytes,
  };
}

/** Estimates the peak before decoding a selected source range into PCM. */
export function estimateAudioNormalizationBudgetForRange(
  duration: number,
  sourceSampleRate: number,
  sourceChannels: number,
  targetFrameCount: number,
): AudioNormalizationBudget {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(sourceSampleRate) ||
    sourceSampleRate <= 0 ||
    !Number.isInteger(sourceChannels) ||
    sourceChannels < 1 ||
    sourceChannels > 2 ||
    !Number.isInteger(targetFrameCount) ||
    targetFrameCount < 1
  )
    throw new Error("The selected audio range cannot be budgeted for conversion.");
  const sourceFrames = Math.ceil(duration * sourceSampleRate);
  const sourceBytes = audioBufferBytes(sourceFrames, sourceChannels);
  const isAlreadyNormalized =
    sourceSampleRate === EXPORT_AUDIO_SAMPLE_RATE &&
    sourceChannels === EXPORT_AUDIO_CHANNELS &&
    sourceFrames === targetFrameCount;
  const convertedBytes = isAlreadyNormalized
    ? 0
    : audioBufferBytes(targetFrameCount, EXPORT_AUDIO_CHANNELS);
  const historyBytes = estimateAnalysisHistoryBytes(duration, sourceChannels);
  return {
    peakBytes: sourceBytes + convertedBytes + historyBytes,
    sourceBytes,
    convertedBytes,
    historyBytes,
  };
}

export function estimateDecodedAudioBudgetForRange(
  duration: number,
  sourceSampleRate: number,
  sourceChannels: number,
): AudioNormalizationBudget {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(sourceSampleRate) ||
    sourceSampleRate <= 0 ||
    !Number.isInteger(sourceChannels) ||
    sourceChannels < 1 ||
    sourceChannels > 2
  )
    throw new Error("The selected audio range cannot be budgeted for decoding.");
  const sourceFrames = Math.ceil(duration * sourceSampleRate);
  const sourceBytes = audioBufferBytes(sourceFrames, sourceChannels);
  const historyBytes = estimateAnalysisHistoryBytes(duration, sourceChannels);
  return { peakBytes: sourceBytes + historyBytes, sourceBytes, convertedBytes: 0, historyBytes };
}

function estimateAnalysisHistoryBytes(duration: number, channels: number) {
  return (
    Math.ceil(duration * ANALYSIS_FPS) * channels * ENVELOPE_BYTES_PER_ANALYSIS_SAMPLE_PER_CHANNEL
  );
}

function createOfflineContext(frameCount: number) {
  if (typeof OfflineAudioContext === "undefined")
    throw new Error(
      "This browser cannot normalize playlist audio at 48 kHz. Try a recent desktop browser.",
    );
  try {
    return new OfflineAudioContext(EXPORT_AUDIO_CHANNELS, frameCount, EXPORT_AUDIO_SAMPLE_RATE);
  } catch (error) {
    throw new Error(
      "This browser could not allocate the audio conversion buffer. Choose a shorter export range.",
      {
        cause: error,
      },
    );
  }
}

/**
 * Uses the browser's Web Audio resampler to create a continuous, stereo 48 kHz
 * track. The exact output frame count is supplied by the playlist timeline so
 * segment boundaries do not accumulate duration drift.
 */
export async function normalizeAudioBuffer(
  audio: AudioBuffer,
  targetFrameCount: number,
  signal?: AbortSignal,
): Promise<AudioBuffer> {
  return normalizeAudioBufferRange(audio, 0, audio.duration, targetFrameCount, signal);
}

export async function normalizeAudioBufferRange(
  audio: AudioBuffer,
  sourceStart: number,
  sourceEnd: number,
  targetFrameCount: number,
  signal?: AbortSignal,
): Promise<AudioBuffer> {
  if (!Number.isInteger(targetFrameCount) || targetFrameCount < 1)
    throw new Error("The selected audio range is too short to normalize.");
  if (
    !Number.isFinite(sourceStart) ||
    !Number.isFinite(sourceEnd) ||
    sourceStart < 0 ||
    sourceEnd <= sourceStart
  )
    throw new Error("The selected audio range cannot be normalized.");
  if (audio.numberOfChannels < 1 || audio.numberOfChannels > 2)
    throw new Error("Export needs a mono or stereo audio track.");
  if (signal?.aborted) throw new DOMException("Export canceled", "AbortError");
  if (sourceStart >= audio.duration) return createSilentAudioBuffer(targetFrameCount);
  const availableDuration = Math.max(0, Math.min(sourceEnd, audio.duration) - sourceStart);
  if (availableDuration <= 0) return createSilentAudioBuffer(targetFrameCount);
  if (
    sourceStart === 0 &&
    Math.abs(sourceEnd - audio.duration) < 1 / audio.sampleRate &&
    audio.sampleRate === EXPORT_AUDIO_SAMPLE_RATE &&
    audio.numberOfChannels === EXPORT_AUDIO_CHANNELS &&
    audio.length === targetFrameCount
  ) {
    return audio;
  }
  const budget = estimateAudioNormalizationBudget(audio, targetFrameCount);
  if (!Number.isFinite(budget.peakBytes) || budget.peakBytes > EXPORT_AUDIO_MEMORY_BUDGET_BYTES)
    throw new Error(
      "This audio range needs too much memory for 48 kHz playlist conversion. Choose a shorter section or export tracks separately.",
    );

  let context: OfflineAudioContext;
  try {
    context = createOfflineContext(targetFrameCount);
    const source = context.createBufferSource();
    source.buffer = audio;
    source.connect(context.destination);
    source.start(0, sourceStart, availableDuration);
  } catch (error) {
    if (error instanceof Error && error.message.includes("could not allocate")) throw error;
    throw new Error(
      "This browser could not prepare the audio conversion. Choose a shorter export range.",
      {
        cause: error,
      },
    );
  }

  let normalized: AudioBuffer;
  try {
    normalized = await context.startRendering();
  } catch (error) {
    throw new Error(
      "The browser could not convert this audio track. Try a shorter range or a different file.",
      {
        cause: error,
      },
    );
  }
  if (signal?.aborted) throw new DOMException("Export canceled", "AbortError");
  if (
    normalized.numberOfChannels !== EXPORT_AUDIO_CHANNELS ||
    normalized.sampleRate !== EXPORT_AUDIO_SAMPLE_RATE ||
    normalized.length !== targetFrameCount
  ) {
    throw new Error("The browser returned an unexpected audio conversion format.");
  }
  return normalized;
}

export function createSilentAudioBuffer(frameCount: number): AudioBuffer {
  if (!Number.isInteger(frameCount) || frameCount < 1)
    throw new Error("Cannot create an empty silent audio section.");
  if (audioBufferBytes(frameCount, EXPORT_AUDIO_CHANNELS) > EXPORT_AUDIO_MEMORY_BUDGET_BYTES)
    throw new Error(
      "This silent audio range needs too much memory to export. Choose a shorter section.",
    );
  return new AudioBuffer({
    length: frameCount,
    numberOfChannels: EXPORT_AUDIO_CHANNELS,
    sampleRate: EXPORT_AUDIO_SAMPLE_RATE,
  });
}
