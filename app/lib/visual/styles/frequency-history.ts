import { ANALYSIS_FPS } from "../../audio/audio-analysis-config";
import type { SoundEnvelope } from "../../audio/audio-features";
import { ringBandAmplitude } from "./legacy-common";
import { clamp } from "./shared";
import type { FrequencyHistory } from "./types";

const BAND_COUNT = 96;
const MAX_CACHED_FRAMES = 384;
const MAX_LIVE_FRAMES = 10 * ANALYSIS_FPS + 4;
type MeasuredFrame = { bands: Float32Array; rms: number };

function convert(frame: SoundEnvelope): MeasuredFrame {
  const bands = new Float32Array(BAND_COUNT);
  for (let i = 0; i < BAND_COUNT; i++) {
    let power = 0;
    for (const channel of frame.bands) {
      const coordinate = (i / (BAND_COUNT - 1)) * Math.max(0, channel.length - 1);
      const first = Math.floor(coordinate),
        mix = coordinate - first;
      const value =
        ringBandAmplitude(clamp(channel[first])) * (1 - mix) +
        ringBandAmplitude(clamp(channel[Math.min(channel.length - 1, first + 1)])) * mix;
      power += value * value;
    }
    bands[i] = Math.sqrt(power / Math.max(1, frame.bands.length));
  }
  return { bands, rms: clamp(frame.rms) };
}

/** Interpolated causal three-tap response, independent of render FPS and seek order. */
function readFrames(
  time: number,
  offset: number,
  target: Float32Array,
  quietThreshold: number,
  get: (index: number) => MeasuredFrame | undefined,
) {
  target.fill(0);
  if (!Number.isFinite(time) || time < offset || !target.length) return false;
  quietThreshold = clamp(quietThreshold, 0, 0.1);
  const position = (time - offset) * ANALYSIS_FPS;
  const index = Math.floor(position);
  if (!get(index)) return false;
  const fraction = position - index;
  // Interpolate the response from the previous analysis frame toward the
  // current one. No future analysis frame is read to animate this interval.
  const weights = [
    0.6 * fraction,
    0.6 - 0.3 * fraction,
    0.3 - 0.2 * fraction,
    0.1 * (1 - fraction),
  ];
  const count = target.length;
  for (let lag = 0; lag < weights.length; lag++) {
    const measured = get(index - lag);
    if (!measured || measured.rms <= quietThreshold || !weights[lag]) continue;
    for (let band = 0; band < count; band++) {
      const u = count === 1 ? 0.5 : band / (count - 1);
      const coordinate = u * (BAND_COUNT - 1),
        first = Math.floor(coordinate),
        mix = coordinate - first;
      const value =
        measured.bands[first] * (1 - mix) +
        measured.bands[Math.min(BAND_COUNT - 1, first + 1)] * mix;
      target[band] += value * weights[lag];
    }
  }
  return true;
}

/** References prepared envelopes; only a bounded window of converted bands is cached. */
export class PreparedFrequencyHistory implements FrequencyHistory {
  private readonly cache = new Map<number, MeasuredFrame>();
  constructor(
    private readonly envelopes: readonly SoundEnvelope[],
    private readonly offset = 0,
  ) {}

  private frame = (index: number) => {
    if (index < 0 || index >= this.envelopes.length) return undefined;
    const cached = this.cache.get(index);
    if (cached) return cached;
    const value = convert(this.envelopes[index]);
    if (this.cache.size >= MAX_CACHED_FRAMES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(index, value);
    return value;
  };

  read(time: number, target: Float32Array, quietThreshold: number) {
    return readFrames(time, this.offset, target, quietThreshold, this.frame);
  }
  get cachedFrames() {
    return this.cache.size;
  }
}

const preparedHistories = new WeakMap<readonly SoundEnvelope[], PreparedFrequencyHistory>();
export function preparedFrequencyHistory(envelopes: readonly SoundEnvelope[]) {
  let history = preparedHistories.get(envelopes);
  if (!history) {
    history = new PreparedFrequencyHistory(envelopes);
    preparedHistories.set(envelopes, history);
  }
  return history;
}

/** Only measured live frames are retained; a seek or a gap starts a new window. */
export class RollingFrequencyHistory implements FrequencyHistory {
  private readonly frames = new Map<number, MeasuredFrame>();
  private lastTime = -1;
  record(time: number, frame: SoundEnvelope) {
    if (!Number.isFinite(time) || time < 0) return;
    if (time < this.lastTime || time - this.lastTime > 0.5) this.clear();
    const index = Math.floor(time * ANALYSIS_FPS + 1e-6);
    if (!this.frames.has(index)) this.frames.set(index, convert(frame));
    this.lastTime = time;
    while (this.frames.size > MAX_LIVE_FRAMES) this.frames.delete(this.frames.keys().next().value!);
  }
  read(time: number, target: Float32Array, quietThreshold: number) {
    return readFrames(time, 0, target, quietThreshold, (index) => this.frames.get(index));
  }
  clear() {
    this.frames.clear();
    this.lastTime = -1;
  }
  get cachedFrames() {
    return this.frames.size;
  }
}

export function bandEnergy(bands: Float32Array, start: number, end: number, sensitivity: number) {
  let power = 0,
    count = 0;
  for (let i = Math.floor(start * bands.length); i < Math.ceil(end * bands.length); i++) {
    power += (bands[i] ?? 0) ** 2;
    count++;
  }
  return 1 - Math.exp(-Math.sqrt(power / Math.max(1, count)) * clamp(sensitivity, 0.2, 3) * 8);
}
