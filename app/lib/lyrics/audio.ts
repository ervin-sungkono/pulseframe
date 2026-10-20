import { MDX_SAMPLE_RATE } from "./mdx-config";
import {
  GEMINI_AUDIO_CHUNK_MS,
  GEMINI_AUDIO_STRIDE_MS,
  GEMINI_SAMPLE_RATE,
} from "./gemini-contract";

export {
  GEMINI_AUDIO_CHUNK_MS,
  GEMINI_AUDIO_OVERLAP_MS,
  GEMINI_AUDIO_STRIDE_MS,
  GEMINI_SAMPLE_RATE,
} from "./gemini-contract";

export type CloudAudioChunkPlan = {
  index: number;
  /** 16 kHz mono sample offset, inclusive. */
  startSample: number;
  /** 16 kHz mono sample offset, exclusive. */
  endSample: number;
  /** Total resampled 16 kHz mono sample count for the source. */
  totalSamples: number;
  sampleRate: 16_000;
  startMs: number;
  endMs: number;
};

export type EncodedCloudAudioChunk = CloudAudioChunkPlan & {
  sampleCount: number;
  mimeType: "audio/wav";
  wav: Uint8Array;
};

export const WHISPER_SAMPLE_RATE = 16_000;
export const SILENCE_RMS_THRESHOLD = 1e-5;

const FILTER_TAPS = 48;
const FILTER_RADIUS = FILTER_TAPS / 2;
const RESAMPLE_YIELD_FRAMES = 32_768;

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Audio preparation canceled", "AbortError");
}

function validateChannels(channels: readonly Float32Array[], sampleRate: number) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2)
    throw new Error("Subtitle generation supports mono or stereo audio.");
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000)
    throw new Error("The audio sample rate is not supported for subtitle generation.");
  const length = channels[0]?.length ?? 0;
  if (
    length < 1 ||
    channels.some((channel) => !(channel instanceof Float32Array) || channel.length !== length)
  )
    throw new Error("The decoded audio channels have an invalid sample layout.");
  return length;
}

function gcd(a: number, b: number) {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right !== 0) [left, right] = [right, left % right];
  return left;
}

function createFilterPhases(sourceRate: number, targetRate: number) {
  const divisor = gcd(sourceRate, targetRate);
  const exactPhaseCount = divisor ? targetRate / divisor : Number.POSITIVE_INFINITY;
  const useExactPhases = exactPhaseCount <= 4_096;
  const phaseCount = useExactPhases ? exactPhaseCount : 2_048;
  const cutoff = 0.5 * Math.min(1, targetRate / sourceRate) * 0.94;
  const phases = Array.from({ length: phaseCount }, (_, phaseIndex) => {
    const fraction = phaseIndex / phaseCount;
    const weights = new Float64Array(FILTER_TAPS);
    let sum = 0;
    for (let tap = 0; tap < FILTER_TAPS; tap += 1) {
      const offset = tap - FILTER_RADIUS + 1;
      const distance = offset - fraction;
      const normalizedDistance = distance / FILTER_RADIUS;
      const window =
        Math.abs(normalizedDistance) >= 1
          ? 0
          : 0.42 +
            0.5 * Math.cos(Math.PI * normalizedDistance) +
            0.08 * Math.cos(2 * Math.PI * normalizedDistance);
      const argument = 2 * cutoff * distance;
      const sinc =
        Math.abs(argument) < 1e-12 ? 1 : Math.sin(Math.PI * argument) / (Math.PI * argument);
      const weight = 2 * cutoff * sinc * window;
      weights[tap] = weight;
      sum += weight;
    }
    if (Math.abs(sum) > 1e-12)
      for (let tap = 0; tap < weights.length; tap += 1) weights[tap] /= sum;
    return weights;
  });
  return { phaseCount, phases, useExactPhases, divisor };
}

function monoSample(channels: readonly Float32Array[], index: number) {
  if (channels.length === 1) return channels[0][index] ?? 0;
  return ((channels[0][index] ?? 0) + (channels[1][index] ?? 0)) * 0.5;
}

async function resampleRange(
  channels: readonly Float32Array[],
  sourceRate: number,
  targetRate: number,
  startOutputSample: number,
  endOutputSample: number,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
) {
  const sourceLength = validateChannels(channels, sourceRate);
  if (
    !Number.isSafeInteger(startOutputSample) ||
    !Number.isSafeInteger(endOutputSample) ||
    startOutputSample < 0 ||
    endOutputSample <= startOutputSample
  )
    throw new Error("The requested audio conversion range is invalid.");
  if (!Number.isInteger(targetRate) || targetRate < 8_000 || targetRate > 192_000)
    throw new Error("The requested audio conversion rate is not supported.");
  const output = new Float32Array(endOutputSample - startOutputSample);
  if (sourceRate === targetRate) {
    for (let base = 0; base < output.length; base += RESAMPLE_YIELD_FRAMES) {
      throwIfAborted(signal);
      const limit = Math.min(output.length, base + RESAMPLE_YIELD_FRAMES);
      for (let index = base; index < limit; index += 1)
        output[index] = monoSample(channels, startOutputSample + index);
      onProgress?.(limit, output.length);
      if (limit < output.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throwIfAborted(signal);
    return output;
  }
  const { phaseCount, phases, useExactPhases, divisor } = createFilterPhases(
    sourceRate,
    targetRate,
  );

  for (let base = 0; base < output.length; base += RESAMPLE_YIELD_FRAMES) {
    throwIfAborted(signal);
    const limit = Math.min(output.length, base + RESAMPLE_YIELD_FRAMES);
    for (let localIndex = base; localIndex < limit; localIndex += 1) {
      const outputIndex = startOutputSample + localIndex;
      const sourcePosition = (outputIndex * sourceRate) / targetRate;
      const sourceCenter = Math.floor(sourcePosition);
      let phaseIndex: number;
      if (useExactPhases) {
        const numeratorStep = sourceRate / divisor;
        phaseIndex = ((outputIndex % phaseCount) * numeratorStep) % phaseCount;
      } else {
        phaseIndex = Math.min(
          phaseCount - 1,
          Math.floor((sourcePosition - sourceCenter) * phaseCount),
        );
      }
      const weights = phases[phaseIndex];
      let value = 0;
      for (let tap = 0; tap < FILTER_TAPS; tap += 1) {
        const offset = tap - FILTER_RADIUS + 1;
        const sourceIndex = Math.max(0, Math.min(sourceLength - 1, sourceCenter + offset));
        const sample = monoSample(channels, sourceIndex);
        value += (Number.isFinite(sample) ? sample : 0) * weights[tap];
      }
      output[localIndex] = value;
    }
    onProgress?.(limit, output.length);
    if (limit < output.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throwIfAborted(signal);
  return output;
}

async function resampleSingleChannel(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
) {
  return resampleRange(
    [input],
    sourceRate,
    targetRate,
    0,
    Math.round((input.length * targetRate) / sourceRate),
    signal,
    onProgress,
  );
}

/** Downsample mono/stereo mix to anti-aliased 16 kHz mono for Whisper. */
export async function resampleMono16k(
  channels: readonly Float32Array[],
  sampleRate: number,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
) {
  const sourceLength = validateChannels(channels, sampleRate);
  return resampleRange(
    channels,
    sampleRate,
    WHISPER_SAMPLE_RATE,
    0,
    Math.round((sourceLength * WHISPER_SAMPLE_RATE) / sampleRate),
    signal,
    onProgress,
  );
}

/** Convert mono/stereo decoded audio to the 44.1 kHz stereo Kim Vocal 2 input. */
export async function resampleStereo44100(
  channels: readonly Float32Array[],
  sampleRate: number,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<[Float32Array, Float32Array]> {
  const sourceLength = validateChannels(channels, sampleRate);
  if (sampleRate === MDX_SAMPLE_RATE) {
    onProgress?.(sourceLength, sourceLength);
    return channels.length === 1 ? [channels[0], channels[0]] : [channels[0], channels[1]];
  }
  const outputLength = Math.round((sourceLength * MDX_SAMPLE_RATE) / sampleRate);
  if (channels.length === 1) {
    const mono = await resampleSingleChannel(
      channels[0],
      sampleRate,
      MDX_SAMPLE_RATE,
      signal,
      (completed, total) => onProgress?.(completed * 2, total * 2),
    );
    onProgress?.(outputLength * 2, outputLength * 2);
    if (mono.length !== outputLength)
      throw new Error("The audio conversion returned an unexpected sample count.");
    return [mono, mono.slice()];
  }
  let leftCompleted = 0;
  let rightCompleted = 0;
  const report = () => onProgress?.(leftCompleted + rightCompleted, outputLength * 2);
  const [left, right] = await Promise.all([
    resampleSingleChannel(channels[0], sampleRate, MDX_SAMPLE_RATE, signal, (completed) => {
      leftCompleted = completed;
      report();
    }),
    resampleSingleChannel(channels[1], sampleRate, MDX_SAMPLE_RATE, signal, (completed) => {
      rightCompleted = completed;
      report();
    }),
  ]);
  if (left.length !== outputLength || right.length !== outputLength)
    throw new Error("The audio conversion returned an unexpected sample count.");
  return [left, right];
}

/** Root-mean-square level for a bounded sample interval. */
export function audioRms(samples: Float32Array, start = 0, end = samples.length) {
  const first = Math.max(0, Math.min(samples.length, Math.floor(start)));
  const last = Math.max(first, Math.min(samples.length, Math.floor(end)));
  if (last <= first) return 0;
  let sumSquares = 0;
  for (let index = first; index < last; index += 1) {
    const sample = samples[index];
    if (Number.isFinite(sample)) sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / (last - first));
}

export function isNearDigitalSilence(
  samples: Float32Array,
  start = 0,
  end = samples.length,
  threshold = SILENCE_RMS_THRESHOLD,
) {
  return audioRms(samples, start, end) < threshold;
}

/** Build stable 60-second Gemini windows with 2-second overlap at 24 kHz. */
export function planCloudAudioChunks(
  sourceSampleCount: number,
  sourceSampleRate: number,
): CloudAudioChunkPlan[] {
  if (!Number.isSafeInteger(sourceSampleCount) || sourceSampleCount < 0)
    throw new Error("The source audio sample count must be a nonnegative safe integer.");
  if (!Number.isInteger(sourceSampleRate) || sourceSampleRate < 8_000 || sourceSampleRate > 384_000)
    throw new Error("The audio sample rate is not supported for subtitle generation.");
  if (!sourceSampleCount) return [];

  const totalSamples = Math.round((sourceSampleCount * GEMINI_SAMPLE_RATE) / sourceSampleRate);
  const chunkSamples = (GEMINI_AUDIO_CHUNK_MS * GEMINI_SAMPLE_RATE) / 1000;
  const strideSamples = (GEMINI_AUDIO_STRIDE_MS * GEMINI_SAMPLE_RATE) / 1000;
  const count = 1 + Math.ceil(Math.max(0, totalSamples - chunkSamples) / strideSamples);
  return Array.from({ length: count }, (_, index) => {
    const startSample = index * strideSamples;
    const endSample = Math.min(totalSamples, startSample + chunkSamples);
    return {
      index,
      startSample,
      endSample,
      totalSamples,
      sampleRate: GEMINI_SAMPLE_RATE,
      startMs: Math.round((startSample * 1000) / GEMINI_SAMPLE_RATE),
      endMs: Math.round((endSample * 1000) / GEMINI_SAMPLE_RATE),
    };
  });
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1)
    view.setUint8(offset + index, text.charCodeAt(index));
}

/** Encode a mono Float32 buffer as little-endian PCM16 WAV. */
export function encodeMonoPcm16Wav(samples: Float32Array, sampleRate = GEMINI_SAMPLE_RATE) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || samples.length < 1)
    throw new Error("The WAV audio chunk is empty or has an invalid sample rate.");
  const dataBytes = samples.length * 2;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > 0xffff_ffff - 36)
    throw new Error("The WAV audio chunk is too large to encode.");
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0;
    view.setInt16(
      44 + index * 2,
      sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff),
      true,
    );
  }
  return wav;
}

/** Resample and encode only one planned cloud chunk to bound temporary memory. */
export async function encodeCloudAudioChunk(
  channels: readonly Float32Array[],
  sourceSampleRate: number,
  plan: CloudAudioChunkPlan,
  signal?: AbortSignal,
): Promise<EncodedCloudAudioChunk> {
  const sourceSampleCount = validateChannels(channels, sourceSampleRate);
  const expectedTotalSamples = Math.round(
    (sourceSampleCount * GEMINI_SAMPLE_RATE) / sourceSampleRate,
  );
  if (
    plan.sampleRate !== GEMINI_SAMPLE_RATE ||
    plan.totalSamples !== expectedTotalSamples ||
    plan.startSample < 0 ||
    plan.endSample <= plan.startSample ||
    plan.endSample > expectedTotalSamples ||
    !Number.isInteger(plan.index) ||
    plan.index < 0
  )
    throw new Error("The Gemini audio chunk plan does not match the current source audio.");

  const samples = await resampleRange(
    channels,
    sourceSampleRate,
    GEMINI_SAMPLE_RATE,
    plan.startSample,
    plan.endSample,
    signal,
  );
  throwIfAborted(signal);
  const wav = encodeMonoPcm16Wav(samples, GEMINI_SAMPLE_RATE);
  throwIfAborted(signal);
  return { ...plan, sampleCount: samples.length, mimeType: "audio/wav", wav };
}
