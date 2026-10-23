import type { RadialOptions } from "../style-options";
import { clamp, finite, sampleBands, TAU } from "./shared";
import type { VisualStyleRenderer } from "./types";

const MIN_BAR_COUNT = 32;
const MAX_BAR_COUNT = 160;
const MAX_ENVELOPE_RADIUS = 0.44;
const MAX_GLOW_BLUR = 24;
const MIN_IDLE_LENGTH = 0.0025;
const ROTATION_RADIANS_PER_SECOND = TAU / 60;

export type RadialSpectrumBar = {
  angle: number;
  frequency: number;
  amplitude: number;
  startRadius: number;
  endRadius: number;
  length: number;
  thickness: number;
  cornerRadius: number;
};

export type RadialSpectrumGeometry = {
  centerX: number;
  centerY: number;
  shortEdge: number;
  innerRadius: number;
  maxBarLength: number;
  maxOuterRadius: number;
  availableRadius: number;
  glowPadding: number;
  shadowBlur: number;
  rotation: number;
  bars: RadialSpectrumBar[];
};

export type RadialGeometryInput = {
  width: number;
  height: number;
  time: number;
  reducedMotion: boolean;
  bands: readonly Float32Array[];
  sensitivity: number;
  visualScale: number;
  glow: number;
};

export type RadialApertureInput = Pick<
  RadialGeometryInput,
  "width" | "height" | "visualScale" | "glow"
>;

type RadialLayout = {
  centerX: number;
  centerY: number;
  shortEdge: number;
  innerRadius: number;
  maxBarLength: number;
  maxOuterRadius: number;
  availableRadius: number;
  glowPadding: number;
  shadowBlur: number;
  count: number;
  thickness: number;
  idleLength: number;
  roundness: number;
};

function createRadialLayout(input: RadialApertureInput, options: RadialOptions): RadialLayout {
  const width = Math.max(0, finite(input.width));
  const height = Math.max(0, finite(input.height));
  const shortEdge = Math.min(width, height);
  const centerX = width / 2;
  const centerY = height / 2;
  const availableRadius = shortEdge * MAX_ENVELOPE_RADIUS;
  const glow = clamp(input.glow, 0, 2.5);
  const shadowBlur = Math.min(MAX_GLOW_BLUR, shortEdge * 0.02 * glow);
  const glowPadding = Math.min(shortEdge * 0.04, shadowBlur * 1.5);
  const safeRadius = Math.max(0, availableRadius - glowPadding);
  const count = Math.round(clamp(options.barCount, MIN_BAR_COUNT, MAX_BAR_COUNT));
  const scale = clamp(input.visualScale, 0.5, 1.5);
  const innerPercent = clamp(options.innerRadius, 10, 40);
  const lengthPercent = clamp(options.maxBarLength, 5, 35);
  const widthPercent = clamp(options.barWidth, 20, 100);
  const roundness = clamp(options.roundness, 0, 100) / 100;
  const requestedInnerRadius = shortEdge * (innerPercent / 100) * scale;
  const requestedMaxBarLength = shortEdge * (lengthPercent / 100) * scale;
  const requestedThickness = (TAU * requestedInnerRadius * (widthPercent / 100)) / count;
  const requestedOuterRadius =
    requestedInnerRadius + requestedMaxBarLength + requestedThickness / 2;
  const fit =
    requestedOuterRadius > safeRadius && requestedOuterRadius > 0
      ? safeRadius / requestedOuterRadius
      : 1;
  const innerRadius = requestedInnerRadius * fit;
  const maxBarLength = requestedMaxBarLength * fit;
  const thickness = requestedThickness * fit;
  const maxOuterRadius = innerRadius + maxBarLength + thickness / 2;
  const idleLength = Math.min(
    maxBarLength,
    Math.max(shortEdge * MIN_IDLE_LENGTH, maxBarLength * 0.018),
  );

  return {
    centerX,
    centerY,
    shortEdge,
    innerRadius,
    maxBarLength,
    maxOuterRadius,
    availableRadius,
    glowPadding,
    shadowBlur,
    count,
    thickness,
    idleLength,
    roundness,
  };
}

/** Computes the logo aperture with the same bounded layout as the bar renderer. */
export function radialSpectrumAperture(input: RadialApertureInput, options: RadialOptions) {
  return createRadialLayout(input, options).innerRadius;
}

/** Maps each bar center to the DSP's bass-to-treble logarithmic band axis. */
export function radialFrequencyPosition(
  index: number,
  count: number,
  direction: RadialOptions["direction"],
) {
  const safeCount = Math.max(1, Math.round(finite(count, 1)));
  const safeIndex = Math.max(0, Math.min(safeCount - 1, Math.round(finite(index))));
  const center = (safeIndex + 0.5) / safeCount;
  return direction === "mirrored" ? 1 - Math.abs(1 - 2 * center) : center;
}

/** Pure, bounded geometry shared by the renderer and unit tests. */
export function buildRadialSpectrumGeometry(
  input: RadialGeometryInput,
  options: RadialOptions,
): RadialSpectrumGeometry {
  const layout = createRadialLayout(input, options);
  const {
    centerX,
    centerY,
    shortEdge,
    innerRadius,
    maxBarLength,
    maxOuterRadius,
    availableRadius,
    glowPadding,
    shadowBlur,
    count,
    thickness,
    idleLength,
    roundness,
  } = layout;
  const sensitivity = clamp(input.sensitivity, 0.2, 3);
  const bandwidth = 1 / count;
  const rotationSpeed = clamp(options.rotationSpeed, -100, 100);
  const speedFraction = rotationSpeed / 100;
  const rotationPeriod = speedFraction ? 60 / Math.abs(speedFraction) : 0;
  const sourceTime = finite(input.time);
  const wrappedTime =
    Number.isFinite(rotationPeriod) && rotationPeriod > 0
      ? sourceTime % rotationPeriod
      : sourceTime;
  const rotation =
    input.reducedMotion || !speedFraction
      ? 0
      : wrappedTime * speedFraction * ROTATION_RADIANS_PER_SECOND;
  const variant: RadialOptions["variant"] =
    options.variant === "inward" || options.variant === "both" ? options.variant : "outward";
  const direction: RadialOptions["direction"] =
    options.direction === "mirrored" ? "mirrored" : "clockwise";
  const bars: RadialSpectrumBar[] = [];

  for (let index = 0; index < count; index++) {
    const frequency = radialFrequencyPosition(index, count, direction);
    const sample = sampleBands(input.bands, frequency, bandwidth);
    const amplitude = 1 - Math.exp(-sample * sensitivity * 3.8);
    const length = idleLength + amplitude * (maxBarLength - idleLength);
    const angle = -Math.PI / 2 + (index * TAU) / count + rotation;
    let startRadius: number;
    if (variant === "inward") startRadius = innerRadius + maxBarLength - length;
    else if (variant === "both") startRadius = innerRadius + (maxBarLength - length) / 2;
    else startRadius = innerRadius;
    const endRadius = startRadius + length;
    bars.push({
      angle,
      frequency,
      amplitude,
      startRadius,
      endRadius,
      length,
      thickness,
      cornerRadius: Math.min(thickness / 2, length / 2) * roundness,
    });
  }

  return {
    centerX,
    centerY,
    shortEdge,
    innerRadius,
    maxBarLength,
    maxOuterRadius,
    availableRadius,
    glowPadding,
    shadowBlur,
    rotation,
    bars,
  };
}

export const radialSpectrum: VisualStyleRenderer<RadialOptions> = {
  id: "radial",
  draw(ctx, frame, options) {
    const geometry = buildRadialSpectrumGeometry(
      {
        width: frame.width,
        height: frame.height,
        time: frame.time,
        reducedMotion: frame.reducedMotion,
        bands: frame.audio.bands,
        sensitivity: frame.settings.sensitivity,
        visualScale: frame.settings.visualScale,
        glow: frame.settings.glow,
      },
      options,
    );
    if (!geometry.shortEdge || !geometry.bars.length) return;

    const extent = geometry.maxOuterRadius;
    const gradient = ctx.createLinearGradient(
      geometry.centerX - extent,
      geometry.centerY + extent,
      geometry.centerX + extent,
      geometry.centerY - extent,
    );
    gradient.addColorStop(0, frame.settings.primary);
    gradient.addColorStop(0.5, frame.settings.secondary);
    gradient.addColorStop(1, frame.settings.primary);

    ctx.save();
    ctx.translate(geometry.centerX, geometry.centerY);
    ctx.fillStyle = gradient;
    ctx.shadowColor = frame.settings.primary;
    ctx.shadowBlur = geometry.shadowBlur;
    ctx.beginPath();
    for (const bar of geometry.bars) {
      ctx.save();
      ctx.rotate(bar.angle - Math.PI / 2);
      ctx.roundRect(
        -bar.thickness / 2,
        bar.startRadius,
        bar.thickness,
        bar.length,
        bar.cornerRadius,
      );
      ctx.restore();
    }
    ctx.fill();
    ctx.restore();
  },
};
