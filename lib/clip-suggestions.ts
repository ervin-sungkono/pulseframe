import { ANALYSIS_FPS } from "./audio-analysis-config";
import type { PreparedSound, SoundEnvelope } from "./audio-features";

export const CLIP_LENGTHS = [15, 30, 60] as const;
export type ClipLength = (typeof CLIP_LENGTHS)[number];
export type ClipSuggestion = {
  id: string;
  range: [number, number];
  length: number;
  requestedLength: ClipLength;
  score: number;
  reason: "sustained energy" | "energy shift" | "bass return";
};
export type ClipSuggestionResult = {
  suggestions: ClipSuggestion[];
  unavailableReason?: string;
};

type PrefixStats = {
  activity: number[];
  active: number[];
  event: number[];
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const dbLevel = (value: number) => clamp((value + 60) / 54);

function activity(envelope: SoundEnvelope) {
  const rms = Number.isFinite(envelope.rmsDb) ? dbLevel(envelope.rmsDb) : 0;
  const bass = Number.isFinite(envelope.bassDb) ? dbLevel(envelope.bassDb) : 0;
  const middle = Number.isFinite(envelope.middleDb) ? dbLevel(envelope.middleDb) : 0;
  const high = Number.isFinite(envelope.highDb) ? dbLevel(envelope.highDb) : 0;
  const hit = Number.isFinite(envelope.bassHitDb) ? dbLevel(envelope.bassHitDb!) : bass;
  return clamp(rms * 0.34 + bass * 0.24 + middle * 0.18 + high * 0.12 + hit * 0.12);
}

function prefix(values: number[]) {
  const result = new Array<number>(values.length + 1).fill(0);
  for (let index = 0; index < values.length; index += 1)
    result[index + 1] = result[index] + values[index];
  return result;
}

function makeStats(sound: PreparedSound, duration: number, frameCount: number): PrefixStats | null {
  if (!sound.audio || sound.envelopes.length < frameCount) return null;
  const frames = sound.envelopes.slice(0, frameCount);
  if (
    frames.some(
      (frame) =>
        !Number.isFinite(frame.rmsDb) ||
        !Number.isFinite(frame.bassDb) ||
        !Number.isFinite(frame.middleDb) ||
        !Number.isFinite(frame.highDb),
    )
  )
    return null;
  const values = frames.map(activity);
  const active = values.map((value) => (value < 0.08 ? 1 : 0));
  const eventFrames = new Array<number>(frameCount).fill(0);
  for (const time of sound.events) {
    if (!Number.isFinite(time) || time < 0 || time >= duration) continue;
    const index = Math.min(frameCount - 1, Math.floor(time * ANALYSIS_FPS));
    eventFrames[index] += 1;
  }
  return { activity: prefix(values), active: prefix(active), event: prefix(eventFrames) };
}

function rangeSum(values: number[], start: number, end: number) {
  return values[end] - values[start];
}

function scoreWindow(
  stats: PrefixStats,
  start: number,
  end: number,
  requestedLength: number,
  frameCount: number,
) {
  const length = end - start;
  const middle = start + Math.floor(length / 2);
  const firstQuarterEnd = start + Math.max(1, Math.floor(length / 4));
  const lastQuarterStart = end - Math.max(1, Math.floor(length / 4));
  const mean = rangeSum(stats.activity, start, end) / length;
  const firstHalf = rangeSum(stats.activity, start, middle) / Math.max(1, middle - start);
  const secondHalf = rangeSum(stats.activity, middle, end) / Math.max(1, end - middle);
  const firstQuarter =
    rangeSum(stats.activity, start, firstQuarterEnd) / Math.max(1, firstQuarterEnd - start);
  const lastQuarter =
    rangeSum(stats.activity, lastQuarterStart, end) / Math.max(1, end - lastQuarterStart);
  const peakQuarter = Math.max(firstQuarter, lastQuarter);
  const energyShift = Math.abs(secondHalf - firstHalf);
  const silenceFraction = rangeSum(stats.active, start, end) / length;
  const bassReturns = rangeSum(stats.event, start, end);
  const eventScore = clamp(bassReturns / Math.max(1, requestedLength * 0.12));
  const score = clamp(
    mean * 0.58 +
      peakQuarter * 0.16 +
      energyShift * 0.16 +
      eventScore * 0.1 -
      silenceFraction * 0.3,
  );
  const reason: ClipSuggestion["reason"] =
    bassReturns > 0 ? "bass return" : energyShift >= 0.12 ? "energy shift" : "sustained energy";
  return {
    start: start / ANALYSIS_FPS,
    end: Math.min(frameCount / ANALYSIS_FPS, end / ANALYSIS_FPS),
    score,
    reason,
  };
}

function overlapsTooMuch(a: ClipSuggestion, b: { start: number; end: number }) {
  const shared = Math.max(0, Math.min(a.range[1], b.end) - Math.max(a.range[0], b.start));
  const shorter = Math.min(a.length, b.end - b.start);
  return shorter > 0 && shared / shorter > 0.65;
}

/**
 * Scores only complete, already prepared analysis history. It never decodes or
 * scans audio. Results use source-time seconds and tie-break toward earlier
 * windows for stable suggestions.
 */
export function suggestClips(
  sound: PreparedSound | null,
  duration: number,
  requestedLengths: readonly ClipLength[] = CLIP_LENGTHS,
): ClipSuggestionResult {
  if (!Number.isFinite(duration) || duration <= 0)
    return { suggestions: [], unavailableReason: "Load an audio track to suggest clips." };
  if (!sound?.audio || !sound.envelopes.length)
    return { suggestions: [], unavailableReason: "Clip suggestions need prepared audio history." };
  if (duration > sound.audio.duration + 1 / ANALYSIS_FPS)
    return {
      suggestions: [],
      unavailableReason: "Prepared audio history does not cover this track.",
    };
  const count = Math.ceil(duration * ANALYSIS_FPS);
  if (sound.envelopes.length < count)
    return {
      suggestions: [],
      unavailableReason: "Prepared audio history is incomplete for this track.",
    };
  const stats = makeStats(sound, duration, count);
  if (!stats)
    return {
      suggestions: [],
      unavailableReason: "Prepared audio history is incomplete for this track.",
    };

  const lengths = [...new Set(requestedLengths.filter((value) => CLIP_LENGTHS.includes(value)))];
  const suggestions: ClipSuggestion[] = [];
  for (const requestedLength of lengths) {
    const targetFrames = Math.max(1, Math.min(count, Math.round(requestedLength * ANALYSIS_FPS)));
    const candidates = [];
    for (let start = 0; start + targetFrames <= count; start += 1) {
      const result = scoreWindow(stats, start, start + targetFrames, requestedLength, count);
      candidates.push({ ...result, start });
    }
    candidates.sort((a, b) => b.score - a.score || a.start - b.start);
    const candidate = candidates.find((item) => {
      const range = { start: item.start / ANALYSIS_FPS, end: item.end };
      return !suggestions.some((existing) => overlapsTooMuch(existing, range));
    });
    if (!candidate) continue;
    const start = candidate.start / ANALYSIS_FPS;
    const end = Math.min(duration, candidate.end);
    suggestions.push({
      id: `${requestedLength}-${start.toFixed(3)}`,
      range: [start, end],
      length: end - start,
      requestedLength,
      score: candidate.score,
      reason: candidate.reason,
    });
  }
  if (!suggestions.some((suggestion) => suggestion.score >= 0.08)) {
    return {
      suggestions: [],
      unavailableReason: "No clear high-energy sections were found in this track.",
    };
  }
  return { suggestions: suggestions.filter((suggestion) => suggestion.score >= 0.08) };
}
