import { ANALYSIS_FPS } from "./audio-analysis-config";
import type { SoundEnvelope } from "./audio-features";
import { EXPORT_FRAME_RATES, type ExportFrameRate } from "./export-settings";

/** Exact timestamps keep audio, subtitles and video on the selected timeline. */
export function* exportFrames(length: number, frameRate: ExportFrameRate) {
  if (!Number.isFinite(length) || length <= 0) throw new Error("Invalid export duration.");
  if (!EXPORT_FRAME_RATES.includes(frameRate)) throw new Error("Unsupported frame rate.");
  const count = Math.ceil(length * frameRate);
  for (let index = 0; index < count; index++) {
    const time = index / frameRate;
    const duration = Math.min(1 / frameRate, length - time);
    if (duration > 0) yield { index, time, duration, keyFrame: index % (frameRate * 2) === 0 };
  }
}

/** Reuse only exact analysis samples. Interpolation can blur short bass hits. */
export function exportSoundAt(
  envelopes: SoundEnvelope[],
  time: number,
  analyze: (time: number) => SoundEnvelope,
): SoundEnvelope {
  const position = time * ANALYSIS_FPS,
    index = Math.round(position);
  if (index >= 0 && Math.abs(position - index) < 1e-7 && envelopes[index]) return envelopes[index];
  return analyze(time);
}
