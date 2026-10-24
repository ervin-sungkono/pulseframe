import { waveformEnvelope } from "./audio-dsp.mjs";
import { scanPreparedSound } from "../dsp/scan-client";
import { ANALYSIS_FPS } from "./audio-analysis-config";
import type {
  SoundEnvelope,
  TemporalFeatures,
  TemporalOnset,
  TemporalSample,
} from "./pcm-features";

export { PcmFeatures } from "./pcm-features";
export type {
  PcmBackendOverride,
  SoundEnvelope,
  SoundFrame,
  TemporalFeatures,
  TemporalFrame,
  TemporalOnset,
  TemporalSample,
} from "./pcm-features";

function onsetEnvelope(events: readonly TemporalOnset[], time: number) {
  let low = 0,
    high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  const event = events[low - 1];
  if (!event) return 0;
  const age = time - event.time;
  if (age < 0 || age >= 0.9) return 0;
  return Math.max(0, event.strength) * Math.exp(-age / 0.23);
}

/** Read prepared temporal data at source time without depending on draw history. */
export function temporalAt(prepared: PreparedSound, time: number): TemporalSample | undefined {
  const temporal = prepared.temporal;
  if (!temporal?.available || !temporal.frames.length || !Number.isFinite(time) || time < 0)
    return undefined;
  const index = Math.max(0, Math.min(temporal.frames.length - 1, Math.floor(time * ANALYSIS_FPS)));
  const frame = temporal.frames[index];
  return {
    time: frame.time,
    flux: frame.flux,
    onsetTime: frame.onsetTime,
    onsetStrength: frame.onsetStrength,
    bpm: frame.bpm,
    phase: frame.phase,
    confidence: frame.confidence,
    latency: frame.latency,
    onsetEnvelope: onsetEnvelope(temporal.events, time),
  };
}

export function dropEnvelope(events: number[], time: number) {
  let low = 0,
    high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid] <= time) low = mid + 1;
    else high = mid;
  }
  const event = events[low - 1];
  if (event === undefined || time >= event + 0.9) return 0;
  return Math.exp(-(time - event) / 0.23);
}

export async function findDropEvents(samples: Float32Array[], rate: number, signal?: AbortSignal) {
  return (await scanPreparedSound(samples, rate, signal)).events;
}

export type PreparedSound = {
  audio: AudioBuffer | null;
  events: number[];
  envelopes: SoundEnvelope[];
  temporal?: TemporalFeatures;
  overview: ReturnType<typeof waveformEnvelope>;
};
export async function prepareSound(
  audio: AudioBuffer | null,
  signal?: AbortSignal,
): Promise<PreparedSound> {
  const samples = audio
    ? Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i))
    : [];
  const analysis = audio
    ? await scanPreparedSound(samples, audio.sampleRate, signal, true)
    : {
        events: [],
        envelopes: [],
        temporal: { available: false, frames: [], events: [] },
      };
  return { audio, ...analysis, overview: waveformEnvelope(samples, 0, audio?.length ?? 0, 900) };
}

/** HTML media clock correction is an estimate; device/display latency still varies. */
export function audibleMediaTime(
  media: HTMLMediaElement,
  context: AudioContext | null,
  now: number,
) {
  if (media.paused || !context) return media.currentTime;
  let latency = context.outputLatency || context.baseLatency || 0;
  const stamp = context.getOutputTimestamp?.();
  if (
    stamp &&
    typeof stamp.contextTime === "number" &&
    typeof stamp.performanceTime === "number" &&
    stamp.contextTime > 0 &&
    stamp.performanceTime > 0
  ) {
    latency = Math.max(
      0,
      context.currentTime - (stamp.contextTime + Math.max(0, now - stamp.performanceTime) / 1000),
    );
  }
  return Math.max(0, media.currentTime - Math.min(0.25, latency));
}
