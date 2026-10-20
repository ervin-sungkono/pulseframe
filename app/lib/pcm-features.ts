import { FFTAnalyzer, waveformEnvelope } from "./audio-dsp.mjs";
import { bandPower, recentRms } from "./art-reactivity.mjs";
import { ANALYSIS_SIZE } from "./audio-analysis-config";
import {
  DSP_BAND_COUNT,
  DSP_FEATURE_COUNT,
  DSP_FRAME_SIZE,
  DSP_IMPACT_SIZE as IMPACT_SIZE,
  DSP_MAX_SAMPLE_RATE,
  DspFeatureIndex,
  type FrameSpectrum,
} from "./dsp/contracts";
import { createWasmFrameBackend, WasmFrameBackend } from "./dsp/wasm-backend";
import { getDspBackendPreference } from "./dsp/loader";

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const db = (n: number) => (n > 0 ? 20 * Math.log10(n) : -160);
export type SoundFrame = {
  time: number;
  sampleRate: number;
  size: number;
  channels: FrameSpectrum[];
  frequency: Uint8Array;
  wave: Uint8Array;
  bands: Float32Array[];
  waveform: ReturnType<typeof waveformEnvelope>;
  rms: number;
  rmsDb: number;
  bassDb: number;
  bassHitDb?: number;
  ringBassDb?: number;
  middleDb: number;
  highDb: number;
};
export type SoundEnvelope = Pick<
  SoundFrame,
  "rms" | "rmsDb" | "bassDb" | "bassHitDb" | "ringBassDb" | "middleDb" | "highDb" | "bands"
>;
export type PcmBackendOverride = "auto" | "js" | "wasm";

/** Same calibrated, causal PCM windows for preview, saved frames and exports. */
export class PcmFeatures {
  readonly samples: Float32Array[];
  private analyzers: FFTAnalyzer[] | null = null;
  private impactAnalyzers: FFTAnalyzer[] | null = null;
  private backend: WasmFrameBackend | null = null;
  private readonly mode: PcmBackendOverride;
  private disposed = false;
  private frequency = new Uint8Array(ANALYSIS_SIZE / 2);
  private wave = new Uint8Array(ANALYSIS_SIZE);
  constructor(
    samples: Float32Array[],
    readonly sampleRate: number,
    readonly sourceOffsetSamples = 0,
    backendOverride: PcmBackendOverride = getDspBackendPreference(),
  ) {
    if (!Number.isSafeInteger(sourceOffsetSamples) || sourceOffsetSamples < 0)
      throw new RangeError("sourceOffsetSamples must be a non-negative integer");
    this.samples = samples.slice(); // Own channel references, never clone or detach PCM.
    this.mode = backendOverride;
    if (backendOverride === "wasm") {
      const backend = createWasmFrameBackend(sampleRate, samples.length);
      if (!backend) throw new Error("The DSP WASM module is not initialized.");
      this.backend = backend;
    } else if (
      backendOverride === "auto" &&
      sampleRate <= DSP_MAX_SAMPLE_RATE &&
      (samples.length === 1 || samples.length === 2)
    ) {
      try {
        this.backend = createWasmFrameBackend(sampleRate, samples.length);
      } catch {
        /* Invalid or unavailable WASM handles use the JS path. */
      }
    }
  }

  get backendMode(): "js" | "wasm" {
    return this.backend ? "wasm" : "js";
  }

  private ensureJsAnalyzers() {
    if (!this.analyzers)
      this.analyzers = this.samples.map(() => new FFTAnalyzer(ANALYSIS_SIZE, false));
    if (!this.impactAnalyzers)
      this.impactAnalyzers = this.samples.map(() => new FFTAnalyzer(IMPACT_SIZE, false));
    return { analyzers: this.analyzers, impactAnalyzers: this.impactAnalyzers };
  }

  private analyzeWasm(end: number) {
    const backend = this.backend;
    if (!backend) throw new Error("The DSP WASM frame backend is unavailable.");
    const input = backend.inputView();
    for (let channel = 0; channel < this.samples.length; channel++) {
      const source = this.samples[channel];
      const targetOffset = channel * DSP_FRAME_SIZE;
      const first = end - DSP_FRAME_SIZE;
      for (let index = 0; index < DSP_FRAME_SIZE; index++) {
        const sourceIndex = first + index;
        input[targetOffset + index] =
          sourceIndex >= 0 && sourceIndex < source.length ? source[sourceIndex] : 0;
      }
    }
    const output = backend.analyze();
    if (output.features.length !== DSP_FEATURE_COUNT)
      throw new RangeError("The DSP feature output has an invalid length.");
    return output;
  }

  private buildFrame(
    time: number,
    end: number,
    channels: FrameSpectrum[],
    bands: Float32Array[],
    levels: Omit<
      SoundFrame,
      "time" | "sampleRate" | "size" | "channels" | "frequency" | "wave" | "bands" | "waveform"
    >,
    display: boolean,
    copyBands = false,
  ): SoundFrame {
    const localTime = end / this.sampleRate;
    if (display) {
      this.frequency.fill(0);
      let loudest = 0,
        power = -1;
      for (let c = 0; c < channels.length; c++) {
        const acPower = recentRms(
          [this.samples[c]],
          localTime,
          this.sampleRate,
          (ANALYSIS_SIZE / this.sampleRate) * 1000,
        );
        if (acPower > power) {
          power = acPower;
          loudest = c;
        }
      }
      for (let i = 1; i < this.frequency.length; i++) {
        let p = 0;
        for (const channel of channels) p += channel.amplitudes[i] ** 2;
        const level = db(Math.sqrt(p / Math.max(1, channels.length)));
        this.frequency[i] = Math.round(clamp((level + 75) / 63) * 255);
      }
      for (let i = 0; i < this.wave.length; i++) {
        const index = end - ANALYSIS_SIZE + i;
        const value = index >= 0 ? (this.samples[loudest]?.[index] ?? 0) : 0;
        this.wave[i] = Math.max(0, Math.min(255, Math.round(128 + value * 127)));
      }
    }
    return {
      time,
      sampleRate: this.sampleRate,
      size: ANALYSIS_SIZE,
      channels,
      frequency: this.frequency,
      wave: this.wave,
      bands: copyBands ? bands.map((channel) => channel.slice()) : bands,
      waveform: display
        ? waveformEnvelope(this.samples, end - Math.round(this.sampleRate * 0.12), end, 240)
        : [],
      ...levels,
    };
  }

  private atJs(time: number, display: boolean, end: number): SoundFrame {
    const { analyzers, impactAnalyzers } = this.ensureJsAnalyzers();
    const channels = this.samples.map((samples, index) => {
      const analyzed = analyzers[index].analyze(samples, end - ANALYSIS_SIZE / 2, this.sampleRate);
      return { amplitudes: analyzed.amplitudes, db: analyzed.db };
    });
    const impactFrame = {
      time,
      sampleRate: this.sampleRate,
      size: IMPACT_SIZE,
      channels: this.samples.map((samples, index) =>
        impactAnalyzers[index].analyze(samples, end - IMPACT_SIZE / 2, this.sampleRate),
      ),
    };
    const bands = channels.map((channel) => {
      const output = new Float32Array(DSP_BAND_COUNT),
        top = Math.min(16000, this.sampleRate / 2);
      for (let index = 0; index < output.length; index++) {
        const low = 35 * (top / 35) ** (index / output.length);
        const high = 35 * (top / 35) ** ((index + 1) / output.length);
        let first = Math.max(1, Math.ceil((low * ANALYSIS_SIZE) / this.sampleRate));
        let last = Math.min(
          channel.db.length - 1,
          Math.floor((high * ANALYSIS_SIZE) / this.sampleRate),
        );
        if (last < first)
          first = last = Math.max(
            1,
            Math.min(
              channel.db.length - 1,
              Math.round((Math.sqrt(low * high) * ANALYSIS_SIZE) / this.sampleRate),
            ),
          );
        let peak = -160;
        for (let bin = first; bin <= last; bin++) peak = Math.max(peak, channel.db[bin]);
        output[index] = clamp((peak + 75) / 63);
      }
      return output;
    });
    const frame = { time, sampleRate: this.sampleRate, size: ANALYSIS_SIZE, channels };
    const rms = recentRms(this.samples, end / this.sampleRate, this.sampleRate);
    const level = (low: number, high: number) =>
      db(Math.sqrt(bandPower(frame, low, Math.min(high, this.sampleRate / 2))));
    return this.buildFrame(
      time,
      end,
      channels,
      bands,
      {
        rms,
        rmsDb: db(rms),
        bassDb: level(35, 180),
        bassHitDb: db(Math.sqrt(bandPower(impactFrame, 35, 180))),
        ringBassDb: level(35, 450),
        middleDb: level(180, 2500),
        highDb: level(2500, 12000),
      },
      display,
    );
  }

  at(time: number, display = true): SoundFrame {
    if (this.disposed) throw new Error("PcmFeatures has been disposed.");
    if (!Number.isFinite(this.sampleRate) || this.sampleRate <= 0)
      throw new RangeError("sampleRate must be a positive finite number");
    if (!Number.isFinite(time)) throw new RangeError("time must be finite");
    const end = Math.round(Math.max(0, time) * this.sampleRate) - this.sourceOffsetSamples;
    if (this.backend) {
      try {
        const output = this.analyzeWasm(end);
        return this.buildFrame(
          time,
          end,
          output.channels,
          output.bands,
          {
            rms: output.features[DspFeatureIndex.Rms],
            rmsDb: output.features[DspFeatureIndex.RmsDb],
            bassDb: output.features[DspFeatureIndex.BassDb],
            bassHitDb: output.features[DspFeatureIndex.BassHitDb],
            ringBassDb: output.features[DspFeatureIndex.RingBassDb],
            middleDb: output.features[DspFeatureIndex.MiddleDb],
            highDb: output.features[DspFeatureIndex.HighDb],
          },
          display,
          true,
        );
      } catch (error) {
        this.backend.dispose();
        this.backend = null;
        if (this.mode === "wasm") throw error;
      }
    }
    return this.atJs(time, display, end);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const backend = this.backend;
    this.backend = null;
    this.analyzers = null;
    this.impactAnalyzers = null;
    this.samples.length = 0;
    backend?.dispose();
  }
}
