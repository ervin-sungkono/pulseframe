/* tslint:disable */
/* eslint-disable */
export function core_version(): string;
export function feature_schema_version(): number;
/**
 * Reusable, scalar f64 analysis for the trailing 4096-sample audio frame.
 *
 * JavaScript owns the memory containing the exposed pointers for the lifetime
 * of this instance. All buffers are allocated in `new` and retain their
 * addresses until `free`; `analyze` does not resize or replace them.
 */
export class FrameDsp {
  free(): void;
  constructor(sample_rate: number, channel_count: number);
  /**
   * Pointer to channel-major Float32 input (`channel_count * FFT_SIZE`).
   * Fill it with trailing samples and leading zeros before calling analyze.
   */
  input_ptr(): number;
  input_len(): number;
  /**
   * Feature order: rms, rmsDb, bassDb, bassHitDb, ringBassDb, middleDb, highDb.
   */
  features_ptr(): number;
  features_len(): number;
  /**
   * Channel-major bands, 96 values per channel.
   */
  bands_ptr(): number;
  bands_len(): number;
  /**
   * Channel-major Float64 magnitudes, 2049 values per channel.
   */
  amplitudes_ptr(): number;
  amplitudes_len(): number;
  /**
   * Channel-major Float32 dB values, 2049 values per channel.
   */
  db_ptr(): number;
  db_len(): number;
  sample_rate(): number;
  channel_count(): number;
  /**
   * Compute calibrated 4096 and impact 1024 spectra, RMS and legacy bands.
   * This function uses only constructor-allocated buffers.
   */
  analyze(): void;
}
/**
 * Optional stateful spectral-flux and tempo analysis.
 *
 * `input_ptr` addresses one chronological 2048-sample, mono window whose
 * exclusive end is given to `observe`. Call once per 512-sample hop. A
 * repeated, backwards, or non-adjacent sample position clears detector state
 * before that frame is consumed. Output order is spectral flux, onset time in
 * seconds (or -1), onset strength, coarse tempo BPM (or 0), beat phase, tempo
 * confidence, and causal latency in seconds. Tempo can be half/double
 * ambiguous; confidence is reduced when a related period is also strong.
 */
export class TemporalDsp {
  free(): void;
  constructor(sample_rate: number);
  /**
   * Pointer to the chronological Float32 input window (2048 samples).
   */
  input_ptr(): number;
  input_len(): number;
  /**
   * Pointer to the seven Float64 output metrics.
   */
  output_ptr(): number;
  output_len(): number;
  sample_rate(): number;
  /**
   * Analyze one causal window ending at `end_sample`.
   *
   * Consecutive calls must advance by exactly one 512-sample hop. This
   * method performs no heap allocation after construction.
   */
  observe(end_sample: number): void;
  /**
   * Clear all sequential detector state. The next observation is a warm-up
   * frame and reports zero flux, no onset, and unknown tempo.
   */
  reset(): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_temporaldsp_free: (a: number, b: number) => void;
  readonly temporaldsp_new: (a: number) => [number, number, number];
  readonly temporaldsp_input_ptr: (a: number) => number;
  readonly temporaldsp_input_len: (a: number) => number;
  readonly temporaldsp_output_ptr: (a: number) => number;
  readonly temporaldsp_sample_rate: (a: number) => number;
  readonly temporaldsp_observe: (a: number, b: number) => void;
  readonly temporaldsp_reset: (a: number) => void;
  readonly core_version: () => [number, number];
  readonly feature_schema_version: () => number;
  readonly __wbg_framedsp_free: (a: number, b: number) => void;
  readonly framedsp_new: (a: number, b: number) => [number, number, number];
  readonly framedsp_input_ptr: (a: number) => number;
  readonly framedsp_input_len: (a: number) => number;
  readonly framedsp_features_ptr: (a: number) => number;
  readonly framedsp_features_len: (a: number) => number;
  readonly framedsp_bands_ptr: (a: number) => number;
  readonly framedsp_bands_len: (a: number) => number;
  readonly framedsp_amplitudes_ptr: (a: number) => number;
  readonly framedsp_amplitudes_len: (a: number) => number;
  readonly framedsp_db_ptr: (a: number) => number;
  readonly framedsp_db_len: (a: number) => number;
  readonly framedsp_sample_rate: (a: number) => number;
  readonly framedsp_channel_count: (a: number) => number;
  readonly framedsp_analyze: (a: number) => void;
  readonly temporaldsp_output_len: (a: number) => number;
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
