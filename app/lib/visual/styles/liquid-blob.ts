import { DEFAULT_BLOB_OPTIONS, type BlobOptions } from "../style-options";
import { clamp, closedCurve, finite, rgba, sampleBands, TAU } from "./shared";
import { sampleBarBand } from "./frequency-mapping";
import type { VisualFrameContext, VisualStyleRenderer } from "./types";

const SAMPLE_COUNTS = { low: 96, medium: 128, high: 160 } as const;
const MAX_RADIUS_RATIO = 0.43;
const SMOOTH_OFFSETS = [-2, -1, 0, 1, 2] as const;
const SMOOTH_WEIGHTS = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16] as const;
const geometryBuffer = new Float32Array(SAMPLE_COUNTS.high * 2);
const radiusBuffer = new Float32Array(SAMPLE_COUNTS.high);
const spectrumBuffer = new Float32Array(SAMPLE_COUNTS.high);
const responseBands = new Float32Array(96);
const previousBands = new Float32Array(96);

/** Sample count is deliberately bounded so detail never turns into a sharp-edged spectrum. */
export function liquidBlobSampleCount(detail: BlobOptions["detail"]): number {
  return detail === "low" || detail === "high" ? SAMPLE_COUNTS[detail] : SAMPLE_COUNTS.medium;
}

/**
 * Writes a closed, smoothed polar contour into a caller-owned reusable XY array.
 * Active lobes follow source-time frequency energy at fixed angular positions.
 * Only the explicit silence/idle option uses a clock-driven organic phase.
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
  const quietThreshold = clamp(settings.quietThreshold, 0, 0.1);
  const visualScale = clamp(settings.visualScale, 0.5, 1.5);
  const baseRadius = short * clamp(0.24 * (size / 100) * visualScale, 0.055, 0.38);
  const centerX = width / 2;
  const centerY = height / 2;
  const time = finite(frame.time);
  // The shared pipeline already applies sensitivity/bass boost to these
  // normalized features. Applying another limiter here flattens real music.
  const bass = clamp(frame.audio.bass);
  const mid = clamp(frame.audio.mid);
  const treble = clamp(frame.audio.treble);
  const impact = clamp(frame.audio.impact);
  const bandPeak = peakBandAmplitude(frame.audio.bands);
  const active = Math.max(bass, mid, treble, impact, bandPeak) > quietThreshold;
  const idleLevel = active || frame.reducedMotion ? 0 : idleMotionLevel(options?.idleMotion);
  // Idle animation must not rotate an active contour independently of music.
  const idlePhase = idleLevel ? (time % ((TAU * 20) / 0.6)) * 0.6 : 0;
  const radiusLift = baseRadius * (bass * bassExpansion * 0.2 + impact * 0.055);
  const maximumRadius = short * MAX_RADIUS_RATIO;

  for (let i = 0; i < responseBands.length; i++)
    responseBands[i] = sampleBands(frame.audio.bands, i / (responseBands.length - 1));
  // A bounded causal blend softens surface changes without advancing a hidden
  // simulation. Missing live history simply uses the measured current bands.
  if (fluidity > 0 && frame.history?.read(time - fluidity * 0.08, previousBands, quietThreshold)) {
    const blend = fluidity * 0.4;
    for (let i = 0; i < responseBands.length; i++)
      responseBands[i] = responseBands[i] * (1 - blend) + previousBands[i] * blend;
  }

  let spectrumMean = 0;
  for (let i = 0; i < count; i++) {
    // Mirror the frequency axis so bass/treble meet continuously at the seam.
    // Broad frequency windows retain a liquid surface rather than narrow spikes.
    const position = 1 - Math.abs(1 - (2 * i) / count);
    spectrumBuffer[i] = Math.sqrt(
      clamp(sampleBarBand(responseBands, position, 0.14 + fluidity * 0.18) * sensitivity),
    );
    spectrumMean += spectrumBuffer[i];
  }
  spectrumMean /= count;

  // Compute each radius once, then round neighboring angular samples. The
  // frequency distribution creates local bulges even when beat energy is steady.
  const rawRadiusAt = (sample: number) => {
    const angle = (sample / count) * TAU - Math.PI / 2;
    const lowWave = 0.68 * Math.sin(2 * angle) + 0.32 * Math.sin(3 * angle);
    const midWave = 0.72 * Math.sin(3 * angle + 0.7) + 0.28 * Math.sin(4 * angle - 0.4);
    const highWave = 0.64 * Math.sin(5 * angle + 0.3) + 0.36 * Math.sin(7 * angle - 0.5);
    const bandContour = bass * lowWave * 0.18 + mid * midWave * 0.42 + treble * highWave * 0.12;
    const spectralContour = (spectrumBuffer[sample] - spectrumMean) * 1.7;
    const idleContour =
      idleLevel *
      (0.68 * Math.sin(2 * angle + idlePhase * 0.45) +
        0.32 * Math.sin(3 * angle - idlePhase * 0.35));
    const surfaceOffset = 0.38 * Math.tanh((deformation * (bandContour + spectralContour)) / 0.38);
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
  // Fit the entire silhouette uniformly. Per-point clipping turns the largest
  // size/deformation settings back into a flattened, nearly circular shape.
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
  const surface = ctx.createRadialGradient(
    centerX - maxRadius * 0.24,
    centerY - maxRadius * 0.28,
    Math.max(1, maxRadius * 0.04),
    centerX,
    centerY,
    maxRadius * 1.22,
  );
  surface.addColorStop(0, rgba(frame.settings.secondary, 0.94));
  surface.addColorStop(0.46, rgba(frame.settings.primary, 0.92));
  surface.addColorStop(1, rgba(frame.settings.primary, 0.78));
  ctx.fillStyle = surface;
  ctx.shadowColor = rgba(frame.settings.primary, 0.7);
  // Canvas shadows extend several blur radii; this cap leaves the contour on-screen.
  ctx.shadowBlur = Math.min(short * 0.016, glow * short * 0.008);
  ctx.fill();

  if (internalGlow > 0) {
    closedCurve(ctx, geometryBuffer, count);
    const interior = ctx.createRadialGradient(
      centerX,
      centerY,
      maxRadius * 0.08,
      centerX,
      centerY,
      maxRadius,
    );
    interior.addColorStop(0, rgba(frame.settings.secondary, 0.1 + internalGlow * 0.18));
    interior.addColorStop(0.62, rgba(frame.settings.secondary, internalGlow * 0.11));
    interior.addColorStop(1, rgba(frame.settings.primary, 0));
    ctx.fillStyle = interior;
    ctx.shadowBlur = 0;
    ctx.fill();

    closedCurve(ctx, geometryBuffer, count);
    ctx.strokeStyle = rgba(frame.settings.secondary, internalGlow * 0.24);
    ctx.lineWidth = Math.max(1, short * 0.003);
    ctx.shadowColor = rgba(frame.settings.secondary, 0.4);
    ctx.shadowBlur = Math.min(short * 0.012, glow * short * 0.005);
    ctx.stroke();
  }
  ctx.restore();
}

export const liquidBlob: VisualStyleRenderer<BlobOptions> = {
  id: "blob",
  draw: drawBlob,
};
