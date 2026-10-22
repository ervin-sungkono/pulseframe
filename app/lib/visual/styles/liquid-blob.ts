import { DSP_BAND_COUNT as BAND_COUNT } from "../../dsp/contracts";
import { DEFAULT_BLOB_OPTIONS, type BlobOptions } from "../style-options";
import { bandEnergy } from "./frequency-history";
import { styleResponseHistory } from "./audio-response";
import { writeMetaballContour, type FluidEllipse } from "./fluid-geometry";
import { clamp, closedCurve, finite, rgba, sampleBands, TAU } from "./shared";
import type { VisualFrameContext, VisualStyleRenderer } from "./types";

const SAMPLE_COUNTS = { low: 96, medium: 128, high: 160 } as const;
const MAX_RADIUS_RATIO = 0.43;
const LOBE_ANGLE_OFFSETS = [-1.98, 0.08, 2.04] as const;
const geometryBuffer = new Float32Array(SAMPLE_COUNTS.high * 2);
const currentBands = new Float32Array(BAND_COUNT);
const responseBands = new Float32Array(BAND_COUNT);
const lagBands = new Float32Array(BAND_COUNT);

type SpectrumFeatures = {
  total: number;
  centroid: number;
  spread: number;
  peak: number;
  contrast: number;
  bassPower: number;
  midPower: number;
  treblePower: number;
  bassCentroid: number;
  midCentroid: number;
  trebleCentroid: number;
};

const currentFeatures: SpectrumFeatures = makeSpectrumFeatures();
const lagFeatures: SpectrumFeatures = makeSpectrumFeatures();
const core: FluidEllipse = { x: 0, y: 0, radiusX: 0.1, radiusY: 0.1, angle: 0 };
const lobes: FluidEllipse[] = [
  { x: 0, y: 0, radiusX: 0.08, radiusY: 0.07, angle: 0 },
  { x: 0, y: 0, radiusX: 0.08, radiusY: 0.07, angle: 0 },
  { x: 0, y: 0, radiusX: 0.08, radiusY: 0.07, angle: 0 },
];

/** Writes a bounded, source-time-driven fluid contour into a reusable XY array. */
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
  const time = finite(frame.time);

  // Current broad values already include the user sensitivity and bass gain.
  // Keep their quick attack intact; only history-derived levels receive gain.
  const currentBass = clamp(frame.audio.bass);
  const currentMid = clamp(frame.audio.mid);
  const currentTreble = clamp(frame.audio.treble);
  const impact = clamp(frame.audio.impact);
  const responseReady =
    fluidity > 0 &&
    frame.history !== undefined &&
    styleResponseHistory(frame.history).read(time, responseBands, quietThreshold);
  const responseBlend = responseReady ? fluidity * 0.48 : 0;
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

  for (let index = 0; index < BAND_COUNT; index++) {
    const position = index / (BAND_COUNT - 1);
    const measured = sampleBands(frame.audio.bands, position);
    const response = responseReady ? responseBands[index] : measured;
    currentBands[index] = clamp(measured + (response - measured) * responseBlend);
  }
  readSpectrum(currentBands, currentFeatures, sensitivity);

  // A short raw lookback steers shape velocity without adding another release
  // tail. It stays inside measured source time and falls back to current data.
  let hasLag = false;
  if (fluidity > 0 && frame.history) {
    const lag = Math.min(0.18, fluidity * 0.18);
    if (lag > 0 && frame.history.read(time - lag, lagBands, quietThreshold)) {
      readSpectrum(lagBands, lagFeatures, sensitivity);
      hasLag = true;
    }
  }
  if (!hasLag) copySpectrumFeatures(currentFeatures, lagFeatures);

  const currentPeak = currentFeatures.peak;
  const activity = Math.max(bass, mid, treble, impact, currentPeak);
  const activityDrive = smoothstep(clamp((activity * 0.58 + currentFeatures.peak * 0.42) / 0.72));
  const shapeDrive = Math.pow(deformation, 0.25) * activityDrive;
  const quietBlend = clamp(1 - activity / Math.max(quietThreshold * 4, 0.04));
  const idleLevel = frame.reducedMotion
    ? 0
    : idleMotionLevel(options?.idleMotion) * quietBlend * quietBlend * (3 - 2 * quietBlend);
  const idlePhase = idleLevel ? (time % ((TAU * 20) / 0.6)) * 0.6 : 0;
  const radiusLift = baseRadius * (bass * bassExpansion * 0.3 + impact * 0.08);
  const maximumRadius = short * MAX_RADIUS_RATIO;
  const breathing = Math.sin(idlePhase) * idleLevel;
  const targetAreaRadius = Math.max(
    short * 0.025,
    baseRadius + radiusLift + baseRadius * breathing,
  );

  // User-selected zero deformation remains a plain circular form. Idle motion
  // only breathes that circle and never adds autonomous surface lobes.
  if (shapeDrive <= 1e-6) {
    writeCircle(target, count, width, height, Math.min(maximumRadius, targetAreaRadius));
    return count;
  }

  const centroid = currentFeatures.centroid;
  const lowShare = currentFeatures.bassPower / Math.max(1e-8, currentFeatures.total);
  const midShare = currentFeatures.midPower / Math.max(1e-8, currentFeatures.total);
  const highShare = currentFeatures.treblePower / Math.max(1e-8, currentFeatures.total);
  const centroidVelocity = hasLag ? currentFeatures.centroid - lagFeatures.centroid : 0;
  const lowVelocity = hasLag
    ? lowShare - lagFeatures.bassPower / Math.max(1e-8, lagFeatures.total)
    : 0;
  const highVelocity = hasLag
    ? highShare - lagFeatures.treblePower / Math.max(1e-8, lagFeatures.total)
    : 0;
  const shiftX =
    clamp((centroid - 0.5) * 0.07 + centroidVelocity * fluidity * 0.18, -0.065, 0.065) * shapeDrive;
  const shiftY =
    clamp(
      (lowShare - highShare) * 0.028 + (lowVelocity - highVelocity) * fluidity * 0.06,
      -0.045,
      0.045,
    ) * shapeDrive;
  const spread = currentFeatures.spread;
  const contrast = currentFeatures.contrast;
  // Keep a stable general orientation. Pitch moves the center of mass and
  // reshapes individual frequency lobes instead of rotating a rigid clover.
  const orientation = -Math.PI / 2 + (centroid - 0.5) * 0.72 + (highShare - lowShare) * 0.28;
  const axisShear = (highShare - lowShare) * 2.2 + (midShare - 1 / 3) * 1.25;
  const normalizedRadius = baseRadius / short;
  const elongation = shapeDrive * (0.08 + contrast * 0.31 + spread * 0.11);
  const coreRadius = normalizedRadius * (1 - shapeDrive * (0.7 + contrast * 0.05));
  core.x = shiftX;
  core.y = shiftY;
  core.radiusX = coreRadius + normalizedRadius * elongation * 0.22;
  core.radiusY = Math.max(
    normalizedRadius * 0.17,
    coreRadius - normalizedRadius * elongation * 0.2,
  );
  core.angle = orientation;

  for (let index = 0; index < lobes.length; index++) {
    const lobe = lobes[index];
    const share = index === 0 ? lowShare : index === 1 ? midShare : highShare;
    const regionalCentroid =
      index === 0
        ? currentFeatures.bassCentroid
        : index === 1
          ? currentFeatures.midCentroid
          : currentFeatures.trebleCentroid;
    const dominance = clamp(share);
    const regionalCenter = index === 0 ? 0.135 : index === 1 ? 0.485 : 0.85;
    const expectedShare = index === 0 ? 0.27 : index === 1 ? 0.43 : 0.3;
    const centroidOffset = clamp((regionalCentroid - regionalCenter) * 5.2, -1.2, 1.2);
    const shareOffset = clamp((dominance - expectedShare) * 1.8, -0.62, 0.62);
    const localOffset = centroidOffset + shareOffset;
    const slotShear = (index - 1) * axisShear * 0.72;
    const angle = orientation * 0.36 + LOBE_ANGLE_OFFSETS[index] + slotShear + localOffset;
    const radiusX = normalizedRadius * (0.035 + shapeDrive * (0.03 + dominance * 0.3));
    lobe.angle = angle + (regionalCentroid - regionalCenter) * 0.45;
    lobe.radiusX = radiusX;
    lobe.radiusY = radiusX * (0.58 + 0.24 * (1 - dominance));

    // Keep each fluid lobe joined to the core even at a single-band extreme.
    // A small overlap survives the field smoothing and avoids topology pops.
    const coreOffset = angle - core.angle;
    const coreCosine = Math.cos(coreOffset);
    const coreSine = Math.sin(coreOffset);
    const coreSupport =
      1 / Math.sqrt((coreCosine / core.radiusX) ** 2 + (coreSine / core.radiusY) ** 2);
    const lobeOffset = angle - lobe.angle;
    const lobeCosine = Math.cos(lobeOffset);
    const lobeSine = Math.sin(lobeOffset);
    const lobeSupport =
      1 / Math.sqrt((lobeCosine / lobe.radiusX) ** 2 + (lobeSine / lobe.radiusY) ** 2);
    const desiredDistance = normalizedRadius * (0.12 + shapeDrive * (0.2 + dominance * 0.5));
    const joinedDistance = coreSupport + lobeSupport - normalizedRadius * 0.035;
    const distance = Math.max(normalizedRadius * 0.02, Math.min(desiredDistance, joinedDistance));
    lobe.x = shiftX + Math.cos(angle) * distance;
    lobe.y = shiftY + Math.sin(angle) * distance;
  }

  const gridSize = detail === "low" ? 48 : detail === "high" ? 80 : 64;
  const written = writeMetaballContour(
    target,
    count,
    width,
    height,
    short,
    gridSize,
    core,
    lobes,
    normalizedRadius * (0.045 + shapeDrive * 0.015),
  );
  if (!written) {
    writeCircle(target, count, width, height, Math.min(maximumRadius, targetAreaRadius));
    return count;
  }

  normalizeContour(target, count, width, height, short, targetAreaRadius, maximumRadius);
  return count;
}

function makeSpectrumFeatures(): SpectrumFeatures {
  return {
    total: 0,
    centroid: 0.5,
    spread: 0,
    peak: 0,
    contrast: 0,
    bassPower: 0,
    midPower: 0,
    treblePower: 0,
    bassCentroid: 0.14,
    midCentroid: 0.485,
    trebleCentroid: 0.85,
  };
}

function readSpectrum(bands: Float32Array, target: SpectrumFeatures, sensitivity: number) {
  let total = 0;
  let weighted = 0;
  let weightedSquare = 0;
  let bassPower = 0;
  let midPower = 0;
  let treblePower = 0;
  let bassWeighted = 0;
  let midWeighted = 0;
  let trebleWeighted = 0;
  let peak = 0;
  let meanPower = 0;

  for (let index = 0; index < bands.length; index++) {
    const position = bands.length > 1 ? index / (bands.length - 1) : 0.5;
    const amplitude = Math.sqrt(clamp(bands[index] * sensitivity));
    const power = amplitude * amplitude;
    total += power;
    weighted += power * position;
    weightedSquare += power * position * position;
    meanPower += power;
    peak = Math.max(peak, amplitude);
    if (position < 0.27) {
      bassPower += power;
      bassWeighted += power * position;
    } else if (position < 0.7) {
      midPower += power;
      midWeighted += power * position;
    } else {
      treblePower += power;
      trebleWeighted += power * position;
    }
  }

  target.total = total;
  target.centroid = total > 1e-8 ? weighted / total : 0.5;
  const variance =
    total > 1e-8 ? Math.max(0, weightedSquare / total - target.centroid * target.centroid) : 0;
  target.spread = clamp(Math.sqrt(variance) * 2);
  target.peak = peak;
  target.contrast =
    peak > 1e-5 && bands.length ? clamp(1 - Math.sqrt(meanPower / bands.length) / peak) : 0;
  target.bassPower = bassPower;
  target.midPower = midPower;
  target.treblePower = treblePower;
  target.bassCentroid = bassPower > 1e-8 ? bassWeighted / bassPower : 0.14;
  target.midCentroid = midPower > 1e-8 ? midWeighted / midPower : 0.485;
  target.trebleCentroid = treblePower > 1e-8 ? trebleWeighted / treblePower : 0.85;
}

function copySpectrumFeatures(source: SpectrumFeatures, target: SpectrumFeatures) {
  target.total = source.total;
  target.centroid = source.centroid;
  target.spread = source.spread;
  target.peak = source.peak;
  target.contrast = source.contrast;
  target.bassPower = source.bassPower;
  target.midPower = source.midPower;
  target.treblePower = source.treblePower;
  target.bassCentroid = source.bassCentroid;
  target.midCentroid = source.midCentroid;
  target.trebleCentroid = source.trebleCentroid;
}

function normalizeContour(
  points: Float32Array,
  count: number,
  width: number,
  height: number,
  short: number,
  targetRadius: number,
  maximumRadius: number,
) {
  let twiceArea = 0;
  let centroidX = 0;
  let centroidY = 0;
  const centerX = width / 2;
  const centerY = height / 2;
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    const x = points[index * 2];
    const y = points[index * 2 + 1];
    const nextX = points[next * 2];
    const nextY = points[next * 2 + 1];
    const cross = x * nextY - nextX * y;
    twiceArea += cross;
    centroidX += (x + nextX) * cross;
    centroidY += (y + nextY) * cross;
  }
  if (Math.abs(twiceArea) > 1e-6) {
    centroidX /= 3 * twiceArea;
    centroidY /= 3 * twiceArea;
  } else {
    centroidX = centerX;
    centroidY = centerY;
  }

  const desiredArea = Math.PI * targetRadius * targetRadius;
  const actualArea = Math.abs(twiceArea) * 0.5;
  const areaScale = actualArea > 1e-6 ? clamp(Math.sqrt(desiredArea / actualArea), 0.82, 3.2) : 1;
  const targetCentroidX = centerX + clamp(centroidX - centerX, -short * 0.075, short * 0.075);
  const targetCentroidY = centerY + clamp(centroidY - centerY, -short * 0.075, short * 0.075);
  let farthest = 0;
  for (let index = 0; index < count; index++) {
    const x = targetCentroidX + (points[index * 2] - centroidX) * areaScale;
    const y = targetCentroidY + (points[index * 2 + 1] - centroidY) * areaScale;
    points[index * 2] = x;
    points[index * 2 + 1] = y;
    farthest = Math.max(farthest, Math.hypot(x - centerX, y - centerY));
  }

  if (farthest > maximumRadius) {
    const fit = maximumRadius / farthest;
    for (let index = 0; index < count; index++) {
      points[index * 2] = centerX + (points[index * 2] - centerX) * fit;
      points[index * 2 + 1] = centerY + (points[index * 2 + 1] - centerY) * fit;
    }
  }
}

function writeCircle(
  points: Float32Array,
  count: number,
  width: number,
  height: number,
  radius: number,
) {
  const centerX = width / 2;
  const centerY = height / 2;
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * TAU - Math.PI / 2;
    points[index * 2] = centerX + Math.cos(angle) * radius;
    points[index * 2 + 1] = centerY + Math.sin(angle) * radius;
  }
}

function smoothstep(value: number) {
  return value * value * (3 - 2 * value);
}

function idleMotionLevel(mode: BlobOptions["idleMotion"]): number {
  return mode === "active" ? 0.045 : mode === "subtle" ? 0.018 : 0;
}

function drawBlob(ctx: CanvasRenderingContext2D, frame: VisualFrameContext, options: BlobOptions) {
  const count = writeLiquidBlobGeometry(geometryBuffer, frame, options);
  if (!count) return;

  const short = Math.min(frame.width, frame.height);
  let centroidX = 0;
  let centroidY = 0;
  let maxRadius = 0;
  for (let index = 0; index < count; index++) {
    centroidX += geometryBuffer[index * 2];
    centroidY += geometryBuffer[index * 2 + 1];
  }
  centroidX /= count;
  centroidY /= count;
  for (let index = 0; index < count; index++) {
    maxRadius = Math.max(
      maxRadius,
      Math.hypot(geometryBuffer[index * 2] - centroidX, geometryBuffer[index * 2 + 1] - centroidY),
    );
  }

  const glow = clamp(frame.settings.glow, 0, 2.5);
  const internalGlow =
    clamp(options.internalGlow ?? DEFAULT_BLOB_OPTIONS.internalGlow, 0, 100) / 100;
  ctx.save();
  closedCurve(ctx, geometryBuffer, count);
  const surface = ctx.createLinearGradient(
    centroidX - maxRadius * 0.72,
    centroidY - maxRadius * 0.78,
    centroidX + maxRadius * 0.8,
    centroidY + maxRadius * 0.76,
  );
  surface.addColorStop(0, rgba(frame.settings.secondary, 0.92));
  surface.addColorStop(0.28, rgba(frame.settings.primary, 0.97));
  surface.addColorStop(0.72, rgba(frame.settings.primary, 0.94));
  surface.addColorStop(1, rgba(frame.settings.secondary, 0.84));
  ctx.fillStyle = surface;
  ctx.shadowColor = rgba(frame.settings.primary, 0.46);
  ctx.shadowBlur = Math.min(short * 0.006, glow * short * 0.003);
  ctx.fill();

  ctx.save();
  closedCurve(ctx, geometryBuffer, count);
  ctx.clip();
  ctx.shadowBlur = 0;

  const lowerRightShade = ctx.createLinearGradient(
    centroidX - maxRadius * 0.24,
    centroidY - maxRadius * 0.3,
    centroidX + maxRadius * 0.66,
    centroidY + maxRadius * 0.76,
  );
  lowerRightShade.addColorStop(0, rgba("#000000", 0));
  lowerRightShade.addColorStop(0.44, rgba("#000000", 0.025));
  lowerRightShade.addColorStop(0.78, rgba("#000000", 0.09));
  lowerRightShade.addColorStop(1, rgba("#000000", 0.16));
  ctx.fillStyle = lowerRightShade;
  ctx.fill();

  const edgeShade = ctx.createRadialGradient(
    centroidX - maxRadius * 0.06,
    centroidY - maxRadius * 0.08,
    maxRadius * 0.16,
    centroidX,
    centroidY,
    maxRadius * 1.04,
  );
  edgeShade.addColorStop(0, rgba("#000000", 0));
  edgeShade.addColorStop(0.62, rgba("#000000", 0.015));
  edgeShade.addColorStop(0.86, rgba("#000000", 0.08));
  edgeShade.addColorStop(1, rgba("#000000", 0.17));
  ctx.fillStyle = edgeShade;
  ctx.fill();

  const highlight = ctx.createRadialGradient(
    centroidX - maxRadius * 0.36,
    centroidY - maxRadius * 0.38,
    maxRadius * 0.015,
    centroidX - maxRadius * 0.34,
    centroidY - maxRadius * 0.34,
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
      centroidX - maxRadius * 0.08,
      centroidY - maxRadius * 0.12,
      maxRadius * 0.04,
      centroidX,
      centroidY,
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
      centroidX - maxRadius * 0.8,
      centroidY - maxRadius * 0.8,
      centroidX + maxRadius * 0.8,
      centroidY + maxRadius * 0.8,
    );
    rim.addColorStop(0, rgba(frame.settings.secondary, 0.14 * internalGlow));
    rim.addColorStop(0.34, rgba(frame.settings.secondary, 0.055 * internalGlow));
    rim.addColorStop(0.68, rgba(frame.settings.primary, 0.012 * internalGlow));
    rim.addColorStop(1, rgba(frame.settings.primary, 0.055 * internalGlow));
    ctx.strokeStyle = rim;
    // A contour-following, clipped fill adds depth without an inset spline,
    // which would self-intersect at the narrow necks of a fluid silhouette.
    closedCurve(ctx, geometryBuffer, count);
    ctx.stroke();
  }

  ctx.restore();
  ctx.restore();
}

export const liquidBlob: VisualStyleRenderer<BlobOptions> = {
  id: "blob",
  draw: drawBlob,
};
