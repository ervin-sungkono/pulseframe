import { DSP_BAND_COUNT as BAND_COUNT } from "../../dsp/contracts";
import { ANALYSIS_FPS } from "../../audio/audio-analysis-config";
import { clamp } from "./shared";
import type { FrequencyHistory } from "./types";

export const STYLE_RESPONSE_LOOKBACK_SECONDS = 0.9;
const MAX_CACHE_FRAMES = 384;
const RESPONSE_STEPS = Math.ceil(STYLE_RESPONSE_LOOKBACK_SECONDS * ANALYSIS_FPS);
const releaseSeconds = new Float64Array(BAND_COUNT);
const releaseStep = new Float64Array(BAND_COUNT);
const releaseFloor = new Float64Array(BAND_COUNT);

for (let band = 0; band < BAND_COUNT; band++) {
  const position = band / (BAND_COUNT - 1);
  const seconds = position < 0.27 ? 0.18 : position < 0.7 ? 0.125 : 0.075;
  // Smooth transitions keep the response from changing at a hard band boundary.
  const mix = clamp((position - 0.22) / 0.1);
  const highMix = clamp((position - 0.65) / 0.1);
  releaseSeconds[band] = seconds;
  if (position >= 0.22 && position <= 0.32) releaseSeconds[band] = 0.18 - mix * 0.055;
  if (position >= 0.65 && position <= 0.75) releaseSeconds[band] = 0.125 - highMix * 0.05;
  releaseStep[band] = Math.exp(-1 / (ANALYSIS_FPS * releaseSeconds[band]));
  releaseFloor[band] = Math.exp(-STYLE_RESPONSE_LOOKBACK_SECONDS / releaseSeconds[band]);
}

function retain(cache: Map<number, Float32Array>, key: number, value: Float32Array) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_FRAMES) cache.delete(cache.keys().next().value!);
  return value;
}

/** A finite peak-release envelope, reconstructed from measured audio rather than draw state. */
class MusicalResponseHistory implements FrequencyHistory {
  private readonly measured = new Map<number, Float32Array>();
  private readonly responses = new Map<number, Float32Array>();
  private readonly current = new Float32Array(BAND_COUNT);
  private readonly measurementScratch = new Float32Array(BAND_COUNT);
  private readonly decay = new Float64Array(BAND_COUNT);
  private threshold = -1;
  private sourceRevision = -1;

  constructor(private readonly source: FrequencyHistory) {}

  get revision() {
    return this.source.revision ?? 0;
  }

  get cachedFrames() {
    return this.measured.size + this.responses.size;
  }

  private sample(index: number) {
    if (index < 0) return undefined;
    const cached = this.measured.get(index);
    if (cached) return retain(this.measured, index, cached);
    this.measurementScratch.fill(0);
    if (!this.source.read(index / ANALYSIS_FPS, this.measurementScratch, this.threshold))
      return undefined;
    for (let band = 0; band < BAND_COUNT; band++)
      this.measurementScratch[band] = clamp(this.measurementScratch[band]);
    return retain(this.measured, index, this.measurementScratch.slice());
  }

  read(time: number, target: Float32Array, quietThreshold: number) {
    target.fill(0);
    if (!Number.isFinite(time) || time < 0 || !target.length) return false;
    const index = Math.floor(time * ANALYSIS_FPS);
    if (!Number.isSafeInteger(index)) return false;
    const threshold = clamp(quietThreshold, 0, 0.1);
    if (threshold !== this.threshold || this.sourceRevision !== this.revision) {
      this.measured.clear();
      this.responses.clear();
      this.threshold = threshold;
      this.sourceRevision = this.revision;
    }
    // Check availability even on a cache hit: live history may have expired.
    this.current.fill(0);
    if (!this.source.read(time, this.current, threshold)) return false;
    let response = this.responses.get(time);
    if (response) {
      retain(this.responses, time, response);
    } else {
      response = new Float32Array(BAND_COUNT);
      const fractionSeconds = Math.max(0, time - index / ANALYSIS_FPS);
      for (let band = 0; band < BAND_COUNT; band++) {
        response[band] = clamp(this.current[band]);
        this.decay[band] = Math.exp(-fractionSeconds / releaseSeconds[band]);
      }
      for (let lag = 0; lag <= RESPONSE_STEPS; lag++) {
        const sampleTime = (index - lag) / ANALYSIS_FPS;
        if (sampleTime <= time && time - sampleTime < STYLE_RESPONSE_LOOKBACK_SECONDS) {
          const bands = this.sample(index - lag);
          if (bands) {
            for (let band = 0; band < BAND_COUNT; band++) {
              // Subtract the finite-window floor so a departing sample fades to
              // zero continuously instead of dropping out with residual energy.
              const weight = Math.max(
                0,
                (this.decay[band] - releaseFloor[band]) / (1 - releaseFloor[band]),
              );
              response[band] = Math.max(response[band], bands[band] * weight);
            }
          }
        }
        for (let band = 0; band < BAND_COUNT; band++) this.decay[band] *= releaseStep[band];
      }
      retain(this.responses, time, response);
    }
    for (let band = 0; band < target.length; band++) {
      const position = target.length === 1 ? 0.5 : band / (target.length - 1);
      const coordinate = position * (BAND_COUNT - 1);
      const first = Math.floor(coordinate);
      const mix = coordinate - first;
      target[band] =
        response[first] * (1 - mix) + response[Math.min(BAND_COUNT - 1, first + 1)] * mix;
    }
    return true;
  }
}

const histories = new WeakMap<FrequencyHistory, MusicalResponseHistory>();

/** Shared only by Blob and Terrain; original styles retain their current response. */
export function styleResponseHistory(source: FrequencyHistory) {
  let response = histories.get(source);
  if (!response) {
    response = new MusicalResponseHistory(source);
    histories.set(source, response);
  }
  return response;
}
