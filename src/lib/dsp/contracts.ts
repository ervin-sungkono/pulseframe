import { ANALYSIS_SIZE } from "../audio/audio-analysis-config";

export const DSP_CORE_VERSION = "0.1.0";
export const DSP_FEATURE_SCHEMA_VERSION = 1;
export const DSP_FRAME_SIZE = ANALYSIS_SIZE;
export const DSP_IMPACT_SIZE = 1024;
export const DSP_BAND_COUNT = 96;
export const DSP_BIN_COUNT = DSP_FRAME_SIZE / 2 + 1;
export const DSP_FEATURE_COUNT = 7;
export const DSP_MAX_SAMPLE_RATE = 192_000;
export const DSP_SCAN_PROTOCOL_VERSION = 2;
export const DSP_SCAN_BATCH_FRAMES = 15;
export const DSP_SCAN_HISTORY_SAMPLES = DSP_FRAME_SIZE;
export const DSP_TEMPORAL_WINDOW_SIZE = 2048;
export const DSP_TEMPORAL_HOP_SIZE = 512;
export const DSP_TEMPORAL_FEATURE_COUNT = 7;
export const DSP_TEMPORAL_MAX_EVENTS = 8192;

export const enum DspFeatureIndex {
  Rms = 0,
  RmsDb = 1,
  BassDb = 2,
  BassHitDb = 3,
  RingBassDb = 4,
  MiddleDb = 5,
  HighDb = 6,
}

export const enum DspTemporalFeatureIndex {
  Flux = 0,
  OnsetTime = 1,
  OnsetStrength = 2,
  Bpm = 3,
  Phase = 4,
  Confidence = 5,
  Latency = 6,
}

export type FrameDspHandle = {
  input_ptr(): number;
  input_len(): number;
  features_ptr(): number;
  features_len(): number;
  bands_ptr(): number;
  bands_len(): number;
  amplitudes_ptr(): number;
  amplitudes_len(): number;
  db_ptr(): number;
  db_len(): number;
  sample_rate(): number;
  channel_count(): number;
  analyze(): void;
  free(): void;
};

export type FrameDspConstructor = new (sampleRate: number, channelCount: number) => FrameDspHandle;

export type TemporalDspHandle = {
  input_ptr(): number;
  input_len(): number;
  output_ptr(): number;
  output_len(): number;
  sample_rate(): number;
  observe(endSample: number): void;
  reset(): void;
  free(): void;
};

export type TemporalDspConstructor = new (sampleRate: number) => TemporalDspHandle;

export type DspModuleBindings = {
  FrameDsp: FrameDspConstructor;
  TemporalDsp?: TemporalDspConstructor;
  core_version(): string;
  feature_schema_version(): number;
  default(input?: {
    module_or_path?:
      string | URL | Request | Response | WebAssembly.Module | ArrayBuffer | ArrayBufferView;
  }): Promise<{ memory: WebAssembly.Memory }>;
};

export type DspModule = DspModuleBindings & { memory: WebAssembly.Memory };

export type FrameSpectrum = {
  amplitudes: Float64Array;
  db: Float32Array;
};

export type FrameDspOutput = {
  features: Float64Array;
  channels: FrameSpectrum[];
  bands: Float32Array[];
};

export type DspScanStartMessage = {
  type: "start";
  generation: number;
  jobId: number;
  protocolVersion: number;
  featureSchemaVersion: number;
  backendPreference?: "auto" | "js";
  sampleRate: number;
  channelCount: number;
  totalSamples: number;
  totalFrames: number;
  retain: boolean;
};

export type DspScanChunkMessage = {
  type: "chunk";
  generation: number;
  jobId: number;
  sourceOffsetSamples: number;
  frameStart: number;
  frameEnd: number;
  samples: ArrayBuffer[];
};

export type DspScanCancelMessage = { type: "cancel"; generation: number; jobId: number };
export type DspScanWorkerRequest = DspScanStartMessage | DspScanChunkMessage | DspScanCancelMessage;

export type DspScanWorkerResponse = {
  type: "ready" | "batch" | "chunk-done" | "canceled" | "error";
  generation: number;
  jobId: number;
  protocolVersion?: number;
  featureSchemaVersion?: number;
  backend?: "js" | "wasm";
  frameStart?: number;
  frameCount?: number;
  eventFrames?: number[];
  metrics?: ArrayBuffer;
  bands?: ArrayBuffer;
  temporalAvailable?: boolean;
  temporal?: ArrayBuffer;
  temporalEvents?: ArrayBuffer;
  nextFrame?: number;
  message?: string;
};
