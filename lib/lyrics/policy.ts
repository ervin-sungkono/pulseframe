import type { LyricsPreset } from "./types.js";
import { MDX_SAMPLE_RATE, MDX_TRIM, MDX_VALID_LENGTH } from "./mdx-config.js";

export { MDX_BLOCK_LENGTH, MDX_SAMPLE_RATE, MDX_TRIM, MDX_VALID_LENGTH } from "./mdx-config.js";

export type LocalLyricsCapabilities = {
  webgpuAvailable: boolean;
  memoryAdmitted: boolean;
};

export type LocalLyricsPlan = {
  model: "onnx-community/whisper-tiny" | "onnx-community/whisper-base";
  dtype: "q8";
  isolation: "none" | "kim-vocal-2";
  overlap: 0 | 0.25 | 0.5;
  notices: string[];
};

export type GeminiLyricsPlan = {
  chunkCount: number;
  initialRequests: number;
  maxRechecks: number;
  maxRequests: number;
};

export type CpuThreadCapabilities = {
  crossOriginIsolated: boolean;
  sharedArrayBufferAvailable: boolean;
  sharedWasmMemoryAvailable: boolean;
  hardwareConcurrency: number;
};

export type IsolationBlockPlan = {
  index: number;
  /** Absolute source sample index of the padded model input; may be negative. */
  inputStart: number;
  /** Absolute source sample index of the first valid output sample. */
  validStart: number;
  /** Exclusive absolute source sample index of the end of valid output. */
  validEnd: number;
  /** Offset of the valid region inside each model output block. */
  validInputOffset: number;
  /** Number of valid source samples in this block. */
  validLength: number;
};

export type LyricsInputAdmissionInput = {
  fileBytes: number;
  durationMs: number;
  sampleRate: number;
  channelCount: number;
  retainedBytes?: number;
  deviceMemoryGiB?: number;
  maxMemoryBytes?: number;
  method?: "local" | "gemini";
  isolation: boolean;
  model?: "tiny" | "base";
};

export type LyricsInputAdmission = {
  admitted: boolean;
  estimatedPeakBytes: number;
  budgetBytes: number;
  reason: string | null;
};

export const MAX_LYRICS_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_LYRICS_DURATION_MS = 10 * 60 * 1000;
/** Resolve the fixed local models and separation path without exposing knobs. */
export function resolveLocalLyricsPolicy(
  preset: LyricsPreset,
  capabilities: LocalLyricsCapabilities,
): LocalLyricsPlan {
  if (preset === "fast") {
    return {
      model: "onnx-community/whisper-tiny",
      dtype: "q8",
      isolation: "none",
      overlap: 0,
      notices: [],
    };
  }

  if (preset === "quality") {
    return {
      model: "onnx-community/whisper-base",
      dtype: "q8",
      isolation: "kim-vocal-2",
      overlap: 0.5,
      notices: [],
    };
  }

  const canIsolate = capabilities.webgpuAvailable && capabilities.memoryAdmitted;
  return {
    model: "onnx-community/whisper-tiny",
    dtype: "q8",
    isolation: canIsolate ? "kim-vocal-2" : "none",
    overlap: canIsolate ? 0.25 : 0,
    notices: canIsolate
      ? []
      : [
          capabilities.webgpuAvailable
            ? "Auto skipped vocal isolation because this track exceeds the estimated memory budget."
            : "Auto skipped vocal isolation because compatible WebGPU is unavailable.",
        ],
  };
}

/** Quality can request one accuracy recheck for at most 20% of chunks, capped at three. */
export function resolveGeminiPolicy(preset: LyricsPreset, chunkCount: number): GeminiLyricsPlan {
  if (!Number.isInteger(chunkCount) || chunkCount < 0)
    throw new Error("The Gemini chunk count must be a nonnegative integer.");
  const maxRechecks =
    preset === "quality" && chunkCount > 0 ? Math.min(3, Math.ceil(chunkCount * 0.2)) : 0;
  return {
    chunkCount,
    initialRequests: chunkCount,
    maxRechecks,
    maxRequests: chunkCount + maxRechecks,
  };
}

/** Use multiple WASM threads only when isolation and shared memory both work. */
export function getCpuThreadCount(capabilities: CpuThreadCapabilities) {
  const canShareMemory =
    capabilities.crossOriginIsolated &&
    capabilities.sharedArrayBufferAvailable &&
    capabilities.sharedWasmMemoryAvailable;
  if (!canShareMemory) return 1;
  const hardwareConcurrency = Number.isFinite(capabilities.hardwareConcurrency)
    ? Math.floor(capabilities.hardwareConcurrency)
    : 1;
  return Math.max(1, Math.min(4, Math.floor(hardwareConcurrency / 2)));
}

/** Cover the full source timeline while avoiding an unnecessary extra tail block. */
export function planIsolationBlocks(sampleCount: number, overlap: number): IsolationBlockPlan[] {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0)
    throw new Error("The vocal-isolation sample count must be a nonnegative safe integer.");
  if (![0.25, 0.5].includes(overlap))
    throw new Error("Vocal isolation overlap must be 25% or 50%.");
  if (sampleCount === 0) return [];

  const stride = Math.floor(MDX_VALID_LENGTH * (1 - overlap));
  const blockCount = 1 + Math.ceil(Math.max(0, sampleCount - MDX_VALID_LENGTH) / stride);
  return Array.from({ length: blockCount }, (_, index) => {
    const validStart = index * stride;
    const validEnd = Math.min(sampleCount, validStart + MDX_VALID_LENGTH);
    return {
      index,
      inputStart: validStart - MDX_TRIM,
      validStart,
      validEnd,
      validInputOffset: MDX_TRIM,
      validLength: validEnd - validStart,
    };
  });
}

/**
 * Estimate admission before allocating feature buffers or loading a model.
 * Device-memory values are hints; callers can supply a stricter measured budget.
 */
export function assessLyricsInput(input: LyricsInputAdmissionInput): LyricsInputAdmission {
  const mebibyte = 1024 * 1024;
  const sampleRate = input.sampleRate;
  const channels = input.channelCount;
  const durationSeconds = input.durationMs / 1000;
  const deviceMemoryGiB =
    Number.isFinite(input.deviceMemoryGiB) && (input.deviceMemoryGiB ?? 0) > 0
      ? input.deviceMemoryGiB!
      : 3;
  const budgetBytes =
    Number.isFinite(input.maxMemoryBytes) && (input.maxMemoryBytes ?? 0) > 0
      ? input.maxMemoryBytes!
      : Math.max(256 * mebibyte, Math.min(768 * mebibyte, deviceMemoryGiB * 256 * mebibyte));

  let reason: string | null = null;
  if (
    input.maxMemoryBytes !== undefined &&
    (!Number.isFinite(input.maxMemoryBytes) || input.maxMemoryBytes <= 0)
  )
    reason = "The available memory budget could not be determined.";
  if (!Number.isSafeInteger(input.fileBytes) || input.fileBytes <= 0)
    reason = "The selected file has an invalid size.";
  else if (input.fileBytes > MAX_LYRICS_SOURCE_BYTES)
    reason = "Automatic subtitles support source files up to 100 MiB.";
  else if (!Number.isFinite(input.durationMs) || input.durationMs <= 0)
    reason = "The media duration could not be read.";
  else if (input.durationMs > MAX_LYRICS_DURATION_MS)
    reason = "Automatic subtitles support tracks up to ten minutes.";
  else if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000)
    reason = "The audio sample rate is not supported for subtitle generation.";
  else if (!Number.isInteger(channels) || channels < 1 || channels > 2)
    reason = "Automatic subtitles support mono or stereo audio.";
  else if (
    input.retainedBytes !== undefined &&
    (!Number.isFinite(input.retainedBytes) || input.retainedBytes < 0)
  )
    reason = "The retained audio memory size is invalid.";

  const retainedBytes =
    input.retainedBytes ??
    Math.ceil(durationSeconds * sampleRate * channels * Float32Array.BYTES_PER_ELEMENT);
  const isGemini = input.method === "gemini";
  const workerSourceBytes = Math.ceil(
    durationSeconds * sampleRate * channels * Float32Array.BYTES_PER_ELEMENT,
  );
  const mdxPcmBytes =
    Math.ceil(durationSeconds * MDX_SAMPLE_RATE) * 2 * Float32Array.BYTES_PER_ELEMENT;
  const mdxInputBytes = sampleRate === MDX_SAMPLE_RATE ? workerSourceBytes : mdxPcmBytes;
  const vocalOutputBytes = input.isolation ? mdxPcmBytes : 0;
  const overlapWeightsBytes = input.isolation
    ? Math.ceil(durationSeconds * MDX_SAMPLE_RATE) * Float32Array.BYTES_PER_ELEMENT
    : 0;
  const whisperInputBytes = Math.ceil(durationSeconds * 16_000 * Float32Array.BYTES_PER_ELEMENT);
  const whisperWorkspaceBytes = (input.model === "base" ? 320 : 192) * mebibyte;
  // These stages are sequential. The source copy is counted during conversion,
  // then MDX buffers or the Whisper model are counted after earlier resources
  // are released. The estimate is advisory because browser model allocations vary.
  const mdxWorkspaceBytes = 160 * mebibyte;
  const preparationStageBytes = input.isolation
    ? workerSourceBytes + (sampleRate === MDX_SAMPLE_RATE ? 0 : mdxPcmBytes)
    : workerSourceBytes + whisperInputBytes;
  const mdxInferenceStageBytes = input.isolation
    ? mdxInputBytes + vocalOutputBytes + overlapWeightsBytes + mdxWorkspaceBytes
    : 0;
  const whisperPreparationStageBytes = input.isolation ? vocalOutputBytes + whisperInputBytes : 0;
  const whisperInferenceStageBytes =
    (input.isolation ? vocalOutputBytes : 0) + whisperInputBytes + whisperWorkspaceBytes;
  const cloudChunkFloatBytes = 60 * 24_000 * Float32Array.BYTES_PER_ELEMENT;
  const cloudWavBytes = 44 + 60 * 24_000 * 2;
  const cloudBase64Bytes = Math.ceil((cloudWavBytes * 4) / 3);
  const estimatedPeakBytes = isGemini
    ? retainedBytes + cloudChunkFloatBytes + cloudWavBytes + cloudBase64Bytes
    : retainedBytes +
      Math.max(
        preparationStageBytes,
        mdxInferenceStageBytes,
        whisperPreparationStageBytes,
        whisperInferenceStageBytes,
      );
  if (!reason && (!Number.isFinite(estimatedPeakBytes) || estimatedPeakBytes > budgetBytes))
    reason = "This track exceeds the estimated memory budget for subtitle generation.";

  return {
    admitted: reason === null,
    estimatedPeakBytes,
    budgetBytes,
    reason,
  };
}
