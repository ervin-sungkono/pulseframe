import { DSP_BAND_COUNT as BAND_COUNT } from "../../dsp/contracts";
import { DEFAULT_BLOB_OPTIONS, type BlobOptions } from "../style-options";
import { bandEnergy } from "./frequency-history";
import { sampleBarBand } from "./frequency-mapping";
import { styleResponseHistory } from "./audio-response";
import { clamp, closedCurve, finite, rgba, sampleBands, TAU } from "./shared";
import type { VisualFrameContext, VisualStyleRenderer } from "./types";

const SAMPLE_COUNTS = { low: 96, medium: 128, high: 160 } as const;
const MAX_RADIUS_RATIO = 0.43;
const SMOOTH_OFFSETS = [-2, -1, 0, 1, 2] as const;
const SMOOTH_WEIGHTS = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16] as const;
const geometryBuffer = new Float32Array(SAMPLE_COUNTS.high * 2);
const insetGeometryBuffer = new Float32Array(SAMPLE_COUNTS.high * 2);
const radiusBuffer = new Float32Array(SAMPLE_COUNTS.high);
const spectrumBuffer = new Float32Array(SAMPLE_COUNTS.high);
const currentBands = new Float32Array(BAND_COUNT);
const responseBands = new Float32Array(BAND_COUNT);

/** Sample count is deliberately bounded so detail never turns into a sharp-edged spectrum. */
export function liquidBlobSampleCount(detail: BlobOptions["detail"]): number {
  return detail === "low" || detail === "high" ? SAMPLE_COUNTS[detail] : SAMPLE_COUNTS.medium;
}

/**
 * Writes a closed, smoothed polar contour into a caller-owned reusable XY array.
 * Active lobes follow source-time frequency energy at fixed angular positions.
 * Only the explicit silence/idle option uses an absolute source-time phase.
 */
export function writeLiquidBlobGeometry(
  target: Float32Array,
  frame: VisualFrameContext,
  options: BlobOptions,
): number {
  const { width, height } = frame;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;

  const detail =
    options?.detail === "low" || options?.detail === "high" ? options.detail : "medium";
  const count = SAMPLE_COUNTS[detail];
  if (target.length < count * 2) return 0;

  const short = Math.min(width, height);
  if (!Number.isFinite(short) || short <= 0) return 0;

  const settings = frame.settings;
  const size = clamp(options?.size ?? DEFAULT_BLOB_OPTIONS.size, 50, 150);
  const deformation = clamp(options?.deformation ?? DEFAULT_BLOB_OPTIONS.deformation, 0, 100) / 100;
  const fluidity = clamp(options?.fluidity ?? DEFAULT_BLOB_OPTIONS.fluidity, 0, 100) / 100;
  const bassExpansion =
    clamp(options?.bassExpansion ?? DEFAULT_BLOB_OPTIONS.bassExpansion, 0, 100) / 100;
  const sensitivity = clamp(settings.sensitivity, 0.2, 3);
  const bassGain = clamp(settings.bassBoost, 0.2, 3);
  const quietThreshold = clamp(settings.quietThreshold, 0, 0.1);
  const visualScale = clamp(settings.visualScale, 0.5, 1.5);
  const baseRadius = short * clamp(0.24 * (size / 100) * visualScale, 0.055, 0.38);
  const centerX = width / 2;
  const centerY = height / 2;
  const time = finite(frame.time);

  // These values have already received the live/export sensitivity and bass
  // boost. Keep their quick measured attack and apply no second gain stage.
  const currentBass = clamp(frame.audio.bass);
  const currentMid = clamp(frame.audio.mid);
  const currentTreble = clamp(frame.audio.treble);
  const impact = clamp(frame.audio.impact);
  const responseReady =
    fluidity > 0 &&
    frame.history !== undefined &&
    styleResponseHistory(frame.history).read(time, responseBands, quietThreshold);

  // The response adapter smooths calibrated, measured history. Derive the
  // matching broad bands with the same gain used by the current frame exactly
  // once, then blend a bounded amount so attacks remain clear at all settings.
  const responseBlend = responseReady ? fluidity * 0.55 : 0;
  const responseBass = responseReady
    ? bandEnergy(responseBands, 0, 0.27, sensitivity * bassGain)
    : currentBass;
  const responseMid = responseReady
    ? bandEnergy(responseBands, 0.27, 0.7, sensitivity)
    : currentMid;
  const responseTreble = responseReady
    ? bandEnergy(responseBands, 0.7, 1, sensitivity)
    : currentTreble;
  const bass = currentBass + (responseBass - currentBass) * responseBlend;
  const mid = currentMid + (responseMid - currentMid) * responseBlend;
  const treble = currentTreble + (responseTreble - currentTreble) * responseBlend;

  for (let i = 0; i < BAND_COUNT; i++) {
    const position = i / (BAND_COUNT - 1);
    const current = sampleBands(frame.audio.bands, position);
    const response = responseReady ? responseBands[i] : current;
    currentBands[i] = current + (response - current) * responseBlend;
  }

  const currentPeak = peakBandAmplitude(frame.audio.bands);
  const activity = Math.max(bass, mid, treble, impact, currentPeak);
  const quietBlend = clamp(1 - activity / Math.max(quietThreshold * 4, 0.04));
  // Ease into idle near silence instead of switching lobes on at a threshold.
  const idleLevel = frame.reducedMotion
    ? 0
    : idleMotionLevel(options?.idleMotion) * quietBlend * quietBlend * (3 - 2 * quietBlend);
  // Idle motion is absolute-time based; active frequency lobes never rotate.
  const idlePhase = idleLevel ? (time % ((TAU * 20) / 0.6)) * 0.6 : 0;
  const radiusLift = baseRadius * (bass * bassExpansion * 0.18 + impact * 0.055);
  const maximumRadius = short * MAX_RADIUS_RATIO;

  let spectrumMean = 0;
  const spectrumWidth = 0.13 + fluidity * 0.15;
  for (let i = 0; i < count; i++) {
    // Mirror a broad, filtered frequency profile around the contour. Its fixed
    // angular mapping gives pitches stable locations without needle-like peaks.
    const position = 1 - Math.abs(1 - (2 * i) / count);
    spectrumBuffer[i] = Math.sqrt(
      clamp(sampleBarBand(currentBands, position, spectrumWidth) * sensitivity),
    );
    spectrumMean += spectrumBuffer[i];
  }
  spectrumMean /= count;

  const rawRadiusAt = (sample: number) => {
    const angle = (sample / count) * TAU - Math.PI / 2;
    const lowWave = 0.68 * Math.sin(2 * angle) + 0.32 * Math.sin(3 * angle);
    const midWave = 0.72 * Math.sin(3 * angle + 0.7) + 0.28 * Math.sin(4 * angle - 0.4);
    const highWave = 0.68 * Math.sin(4 * angle + 0.3) + 0.32 * Math.sin(5 * angle - 0.5);
    const bandContour = bass * lowWave * 0.17 + mid * midWave * 0.3 + treble * highWave * 0.11;
    const spectralContour = (spectrumBuffer[sample] - spectrumMean) * 0.78;
    const idleContour =
      idleLevel *
      (0.68 * Math.sin(2 * angle + idlePhase * 0.45) +
        0.32 * Math.sin(3 * angle - idlePhase * 0.35));
    const surfaceOffset = 0.32 * Math.tanh((deformation * (bandContour + spectralContour)) / 0.32);
    return Math.max(
      short * 0.025,
      baseRadius + radiusLift + baseRadius * (surfaceOffset + idleContour),
    );
  };

  let outerRadius = 0;
  for (let index = 0; index < count; index++) {
    radiusBuffer[index] = rawRadiusAt(index);
    outerRadius = Math.max(outerRadius, radiusBuffer[index]);
  }
  // Fit the complete silhouette uniformly. Point clipping would flatten its
  // broad lobes when size, sensitivity and bass expansion are all high.
  const fit = outerRadius > maximumRadius ? maximumRadius / outerRadius : 1;

  for (let index = 0; index < count; index += 1) {
    let radius = 0;
    for (let tap = 0; tap < SMOOTH_OFFSETS.length; tap += 1) {
      let neighbor = index + SMOOTH_OFFSETS[tap];
      if (neighbor < 0) neighbor += count;
      else if (neighbor >= count) neighbor -= count;
      radius += radiusBuffer[neighbor] * SMOOTH_WEIGHTS[tap];
    }
    radius *= fit;
    const angle = (index / count) * TAU - Math.PI / 2;
    target[index * 2] = centerX + Math.cos(angle) * radius;
    target[index * 2 + 1] = centerY + Math.sin(angle) * radius;
  }
  return count;
}

function peakBandAmplitude(bands: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of bands) {
    for (let index = 0; index < channel.length; index += 1)
      peak = Math.max(peak, clamp(channel[index]));
  }
  return peak;
}

function idleMotionLevel(mode: BlobOptions["idleMotion"]): number {
  return mode === "active" ? 0.045 : mode === "subtle" ? 0.018 : 0;
}

function writeInsetGeometry(
  points: Float32Array,
  target: Float32Array,
  count: number,
  centerX: number,
  centerY: number,
  scale: number,
) {
  for (let index = 0; index < count; index++) {
    target[index * 2] = centerX + (points[index * 2] - centerX) * scale;
    target[index * 2 + 1] = centerY + (points[index * 2 + 1] - centerY) * scale;
  }
}

function drawBlob(ctx: CanvasRenderingContext2D, frame: VisualFrameContext, options: BlobOptions) {
  const count = writeLiquidBlobGeometry(geometryBuffer, frame, options);
  if (!count) return;

  const short = Math.min(frame.width, frame.height);
  const centerX = frame.width / 2;
  const centerY = frame.height / 2;
  const glow = clamp(frame.settings.glow, 0, 2.5);
  const internalGlow =
    clamp(options.internalGlow ?? DEFAULT_BLOB_OPTIONS.internalGlow, 0, 100) / 100;
  let maxRadius = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = geometryBuffer[index * 2] - centerX;
    const dy = geometryBuffer[index * 2 + 1] - centerY;
    maxRadius = Math.max(maxRadius, Math.hypot(dx, dy));
  }

  ctx.save();
  closedCurve(ctx, geometryBuffer, count);
  const surface = ctx.createLinearGradient(
    centerX - maxRadius * 0.72,
    centerY - maxRadius * 0.78,
    centerX + maxRadius * 0.8,
    centerY + maxRadius * 0.76,
  );
  surface.addColorStop(0, rgba(frame.settings.secondary, 0.92));
  surface.addColorStop(0.28, rgba(frame.settings.primary, 0.97));
  surface.addColorStop(0.72, rgba(frame.settings.primary, 0.94));
  surface.addColorStop(1, rgba(frame.settings.secondary, 0.84));
  ctx.fillStyle = surface;
  ctx.shadowColor = rgba(frame.settings.primary, 0.46);
  // A narrow halo gives the contour lift without washing out the edge.
  ctx.shadowBlur = Math.min(short * 0.006, glow * short * 0.003);
  ctx.fill();

  ctx.save();
  closedCurve(ctx, geometryBuffer, count);
  ctx.clip();
  ctx.shadowBlur = 0;

  const lowerRightShade = ctx.createLinearGradient(
    centerX - maxRadius * 0.24,
    centerY - maxRadius * 0.3,
    centerX + maxRadius * 0.66,
    centerY + maxRadius * 0.76,
  );
  lowerRightShade.addColorStop(0, rgba("#000000", 0));
  lowerRightShade.addColorStop(0.44, rgba("#000000", 0.025));
  lowerRightShade.addColorStop(0.78, rgba("#000000", 0.09));
  lowerRightShade.addColorStop(1, rgba("#000000", 0.16));
  ctx.fillStyle = lowerRightShade;
  ctx.fill();

  const edgeShade = ctx.createRadialGradient(
    centerX - maxRadius * 0.06,
    centerY - maxRadius * 0.08,
    maxRadius * 0.16,
    centerX,
    centerY,
    maxRadius * 1.04,
  );
  edgeShade.addColorStop(0, rgba("#000000", 0));
  edgeShade.addColorStop(0.62, rgba("#000000", 0.015));
  edgeShade.addColorStop(0.86, rgba("#000000", 0.08));
  edgeShade.addColorStop(1, rgba("#000000", 0.17));
  ctx.fillStyle = edgeShade;
  ctx.fill();

  const highlight = ctx.createRadialGradient(
    centerX - maxRadius * 0.36,
    centerY - maxRadius * 0.38,
    maxRadius * 0.015,
    centerX - maxRadius * 0.34,
    centerY - maxRadius * 0.34,
    maxRadius * 0.58,
  );
  highlight.addColorStop(0, rgba("#ffffff", 0.12));
  highlight.addColorStop(0.24, rgba(frame.settings.secondary, 0.11));
  highlight.addColorStop(0.58, rgba(frame.settings.secondary, 0.045));
  highlight.addColorStop(1, rgba(frame.settings.secondary, 0));
  ctx.fillStyle = highlight;
  ctx.fill();

  if (internalGlow > 0) {
    const interior = ctx.createRadialGradient(
      centerX - maxRadius * 0.08,
      centerY - maxRadius * 0.12,
      maxRadius * 0.04,
      centerX,
      centerY,
      maxRadius * 0.92,
    );
    interior.addColorStop(0, rgba(frame.settings.secondary, internalGlow * 0.1));
    interior.addColorStop(0.58, rgba(frame.settings.secondary, internalGlow * 0.045));
    interior.addColorStop(1, rgba(frame.settings.primary, 0));
    ctx.fillStyle = interior;
    ctx.fill();

    ctx.lineWidth = Math.max(1, short * 0.0022);
    ctx.shadowBlur = 0;
    const rim = ctx.createLinearGradient(
      centerX - maxRadius * 0.8,
      centerY - maxRadius * 0.8,
      centerX + maxRadius * 0.8,
      centerY + maxRadius * 0.8,
    );
    rim.addColorStop(0, rgba(frame.settings.secondary, 0.14 * internalGlow));
    rim.addColorStop(0.34, rgba(frame.settings.secondary, 0.055 * internalGlow));
    rim.addColorStop(0.68, rgba(frame.settings.primary, 0.012 * internalGlow));
    rim.addColorStop(1, rgba(frame.settings.primary, 0.055 * internalGlow));
    ctx.strokeStyle = rim;
    writeInsetGeometry(geometryBuffer, insetGeometryBuffer, count, centerX, centerY, 0.86);
    closedCurve(ctx, insetGeometryBuffer, count);
    ctx.stroke();
  }

  ctx.restore();
  ctx.restore();
}

export const liquidBlob: VisualStyleRenderer<BlobOptions> = {
  id: "blob",
  draw: drawBlob,
};
