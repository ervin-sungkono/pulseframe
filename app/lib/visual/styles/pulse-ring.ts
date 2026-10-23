import type { VisualSettings } from "../visual-settings-model";
import { clamp, rgba } from "./legacy-common";
import type { VisualStyleRenderer } from "./types";

export const ringInnerRadius = (unit: number, bass: number) => unit * (0.205 + bass * 0.016) * 0.88;

export function ringMagnitude(
  bands: Float32Array[],
  position: number,
  sensitivity: number,
  mirrored: boolean,
  focus: "auto" | "bass" | "full" = "full",
  top = 16000,
  autoMix = 0,
  bassBoost = 1,
): number {
  if (focus === "auto") {
    const bass = ringMagnitude(bands, position, sensitivity * bassBoost, mirrored, "bass", top);
    const full = ringMagnitude(bands, position, sensitivity, mirrored, "full", top);
    return bass + (full - bass) * clamp(autoMix);
  }
  const u = ((position % 1) + 1) % 1,
    folded = u <= 0.5 ? u * 2 : (1 - u) * 2;
  // Bass focus spreads 35–450 Hz over each side instead of cramming it into
  // a few points of a 35–16000 Hz spectrum. Full sound retains that range.
  const mapped =
    focus === "bass"
      ? Math.log((35 + folded * (Math.min(450, top) - 35)) / 35) / Math.log(Math.max(36, top) / 35)
      : folded;
  const sample = (channel: Float32Array | undefined) => {
    if (!channel?.length) return 0;
    const index = mapped * (channel.length - 1),
      a = Math.floor(index),
      f = index - a;
    const value = (i: number) => channel[Math.max(0, Math.min(channel.length - 1, i))] || 0;
    return 0.65 * (value(a) * (1 - f) + value(a + 1) * f) + 0.175 * (value(a - 1) + value(a + 2));
  };
  const left = sample(bands[0]),
    right = sample(bands[Math.min(1, bands.length - 1)]);
  const shared = Math.sqrt((left * left + right * right) / 2);
  const edge = clamp(Math.min(folded, 1 - folded) / 0.055),
    blend = edge * edge * (3 - 2 * edge);
  const magnitude = mirrored ? shared : shared + ((u < 0.5 ? left : right) - shared) * blend;
  const contour = focus === "bass" ? Math.sin(Math.PI * folded) ** 0.45 : 1;
  return (1 - Math.exp(-magnitude * sensitivity * 3)) * contour;
}

export function drawRing(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: VisualSettings,
  bandLayers: Float32Array[][],
  bass: number,
  energy: number,
  sampleRate: number,
  autoMix: number,
) {
  const unit = Math.min(w, h),
    segments = 160;
  const innerRadius = ringInnerRadius(unit, bass),
    layers = Math.max(1, Math.min(4, Math.round(s.ringLayers ?? 3)));
  const radius = innerRadius + unit * 0.007;
  ctx.save();
  // Paint outside-in: offset contours expose contrasting, solid ribbons,
  // while the common inner aperture stays free for a fitted logo.
  for (let layer = layers - 1; layer >= 0; layer--) {
    const gradient = ctx.createLinearGradient(w * 0.23, h * 0.25, w * 0.76, h * 0.76);
    const primary = layer % 2 ? s.secondary : s.primary,
      secondary = layer % 2 ? s.primary : s.secondary;
    gradient.addColorStop(0, secondary);
    gradient.addColorStop(0.55, primary);
    gradient.addColorStop(1, secondary);
    const points: { x: number; y: number }[] = [];
    ctx.beginPath();
    for (let i = 0; i < segments; i++) {
      const u = i / segments,
        angle = u * Math.PI * 2 - Math.PI / 2;
      const response = ringMagnitude(
        bandLayers[layer] ?? bandLayers[0] ?? [],
        u,
        s.sensitivity * (s.ringFocus === "bass" ? s.bassBoost : 1),
        s.ringMirror ?? false,
        s.ringFocus ?? "auto",
        Math.min(16000, sampleRate / 2),
        autoMix,
        s.bassBoost,
      );
      const r = radius + layer * unit * 0.003 + response * unit * (0.16 + layer * 0.008);
      const x = w / 2 + Math.cos(angle) * r,
        y = h / 2 + Math.sin(angle) * r;
      points.push({ x, y });
    }
    const midpoint = (a: (typeof points)[number], b: (typeof points)[number]) =>
      [(a.x + b.x) / 2, (a.y + b.y) / 2] as const;
    ctx.moveTo(...midpoint(points.at(-1)!, points[0]));
    for (let i = 0; i < points.length; i++)
      ctx.quadraticCurveTo(
        points[i].x,
        points[i].y,
        ...midpoint(points[i], points[(i + 1) % points.length]),
      );
    ctx.closePath();
    ctx.moveTo(w / 2 + innerRadius, h / 2);
    ctx.arc(w / 2, h / 2, innerRadius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.globalAlpha = layer ? clamp((s.ringRearOpacity ?? 30) / 100) * (1 - 0.18 * (layer - 1)) : 1;
    ctx.fillStyle = gradient;
    ctx.shadowColor = primary;
    ctx.shadowBlur = s.glow * unit * (layer ? 0.01 : 0.012);
    ctx.fill("evenodd");
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, innerRadius, 0, Math.PI * 2);
  ctx.fillStyle = rgba(s.background, 0.72);
  ctx.fill();
  ctx.strokeStyle = rgba(s.secondary, 0.32 + energy * 0.16);
  ctx.lineWidth = Math.max(1, unit * 0.002);
  ctx.stroke();
  ctx.restore();
}

export const pulseRing: VisualStyleRenderer<VisualSettings> = {
  id: "ring",
  draw(ctx, frame, options) {
    drawRing(
      ctx,
      frame.width,
      frame.height,
      options,
      frame.audio.bandLayers,
      frame.audio.impact,
      frame.audio.energy,
      frame.sampleRate,
      frame.audio.ringMix,
    );
  },
};
