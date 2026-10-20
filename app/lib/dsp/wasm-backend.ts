import {
  DSP_BAND_COUNT,
  DSP_BIN_COUNT,
  DSP_FEATURE_COUNT,
  DSP_FRAME_SIZE,
  DSP_MAX_SAMPLE_RATE,
  type DspModule,
  type FrameDspHandle,
  type FrameDspOutput,
} from "./contracts";
import { getInitializedDspModule } from "./loader";

type BufferKey = "input" | "features" | "bands" | "amplitudes" | "db";
type BufferLayout = { pointer: number; length: number; bytesPerElement: number };

function checkedLayout(
  pointer: number,
  length: number,
  bytesPerElement: number,
  bufferBytes: number,
  key: BufferKey,
) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer % bytesPerElement !== 0) {
    throw new RangeError(`The DSP ${key} pointer is invalid.`);
  }
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    pointer + length * bytesPerElement > bufferBytes
  ) {
    throw new RangeError(`The DSP ${key} buffer is outside WASM memory.`);
  }
  return { pointer, length, bytesPerElement } satisfies BufferLayout;
}

/** Owns one synchronous frame handle and exposes ephemeral views into its WASM memory. */
export class WasmFrameBackend {
  private readonly bindings: DspModule;
  private readonly handle: FrameDspHandle;
  private readonly layouts: Record<BufferKey, BufferLayout>;
  private memoryBuffer: ArrayBuffer | null = null;
  private views: {
    input: Float32Array;
    features: Float64Array;
    bands: Float32Array;
    amplitudes: Float64Array;
    db: Float32Array;
    output: FrameDspOutput;
  } | null = null;
  private disposed = false;

  constructor(
    readonly sampleRate: number,
    readonly channelCount: number,
    bindings = getInitializedDspModule(),
  ) {
    if (!bindings) throw new Error("The DSP WASM bindings are not initialized.");
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > DSP_MAX_SAMPLE_RATE) {
      throw new RangeError(`The DSP sample rate must be between 1 and ${DSP_MAX_SAMPLE_RATE} Hz.`);
    }
    if (channelCount !== 1 && channelCount !== 2)
      throw new RangeError("The frame adapter supports mono or stereo audio.");
    this.bindings = bindings;
    this.handle = new bindings.FrameDsp(sampleRate, channelCount);
    try {
      if (
        this.handle.sample_rate() !== sampleRate ||
        this.handle.channel_count() !== channelCount
      ) {
        throw new Error("The DSP handle does not match its requested audio format.");
      }
      const bufferBytes = this.bindings.memory.buffer.byteLength;
      this.layouts = {
        input: checkedLayout(
          this.handle.input_ptr(),
          this.handle.input_len(),
          Float32Array.BYTES_PER_ELEMENT,
          bufferBytes,
          "input",
        ),
        features: checkedLayout(
          this.handle.features_ptr(),
          this.handle.features_len(),
          Float64Array.BYTES_PER_ELEMENT,
          bufferBytes,
          "features",
        ),
        bands: checkedLayout(
          this.handle.bands_ptr(),
          this.handle.bands_len(),
          Float32Array.BYTES_PER_ELEMENT,
          bufferBytes,
          "bands",
        ),
        amplitudes: checkedLayout(
          this.handle.amplitudes_ptr(),
          this.handle.amplitudes_len(),
          Float64Array.BYTES_PER_ELEMENT,
          bufferBytes,
          "amplitudes",
        ),
        db: checkedLayout(
          this.handle.db_ptr(),
          this.handle.db_len(),
          Float32Array.BYTES_PER_ELEMENT,
          bufferBytes,
          "db",
        ),
      };
      this.expectLength("input", channelCount * DSP_FRAME_SIZE);
      this.expectLength("features", DSP_FEATURE_COUNT);
      this.expectLength("bands", channelCount * DSP_BAND_COUNT);
      this.expectLength("amplitudes", channelCount * DSP_BIN_COUNT);
      this.expectLength("db", channelCount * DSP_BIN_COUNT);
      this.refreshViews();
    } catch (error) {
      try {
        this.handle.free();
      } catch {
        /* Preserve the binding-validation error. */
      }
      throw error;
    }
  }

  private expectLength(key: BufferKey, expected: number) {
    if (this.layouts[key].length !== expected)
      throw new RangeError(`The DSP ${key} buffer has an invalid length.`);
  }

  private buffer() {
    if (this.disposed) throw new Error("The DSP frame handle has been disposed.");
    return this.bindings.memory.buffer;
  }

  private refreshViews() {
    const buffer = this.buffer();
    if (this.memoryBuffer === buffer && this.views) return this.views;
    for (const key of ["input", "features", "bands", "amplitudes", "db"] as const) {
      const layout = this.layouts[key];
      if (layout.pointer + layout.length * layout.bytesPerElement > buffer.byteLength) {
        throw new RangeError(`The DSP ${key} buffer is outside current WASM memory.`);
      }
    }
    const input = new Float32Array(buffer, this.layouts.input.pointer, this.layouts.input.length);
    const features = new Float64Array(
      buffer,
      this.layouts.features.pointer,
      this.layouts.features.length,
    );
    const bands = new Float32Array(buffer, this.layouts.bands.pointer, this.layouts.bands.length);
    const amplitudes = new Float64Array(
      buffer,
      this.layouts.amplitudes.pointer,
      this.layouts.amplitudes.length,
    );
    const db = new Float32Array(buffer, this.layouts.db.pointer, this.layouts.db.length);
    const channels = Array.from({ length: this.channelCount }, (_, channel) => {
      const first = channel * DSP_BIN_COUNT;
      return {
        amplitudes: amplitudes.subarray(first, first + DSP_BIN_COUNT),
        db: db.subarray(first, first + DSP_BIN_COUNT),
      };
    });
    const bandChannels = Array.from({ length: this.channelCount }, (_, channel) => {
      const first = channel * DSP_BAND_COUNT;
      return bands.subarray(first, first + DSP_BAND_COUNT);
    });
    this.memoryBuffer = buffer;
    this.views = {
      input,
      features,
      bands,
      amplitudes,
      db,
      output: { features, channels, bands: bandChannels },
    };
    return this.views;
  }

  inputView() {
    return this.refreshViews().input;
  }

  analyze(): FrameDspOutput {
    if (this.disposed) throw new Error("The DSP frame handle has been disposed.");
    this.handle.analyze();
    return this.refreshViews().output;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.handle.free();
    } finally {
      this.memoryBuffer = null;
      this.views = null;
    }
  }
}

export function createWasmFrameBackend(sampleRate: number, channelCount: number) {
  const dspModule = getInitializedDspModule();
  return dspModule ? new WasmFrameBackend(sampleRate, channelCount, dspModule) : null;
}
