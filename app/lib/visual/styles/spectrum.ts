import type { VisualSettings } from "../visual-settings-model";
import { trackOverlayLayout } from "../track-overlay";
import { clamp, rgba } from "./legacy-common";
import { sampleBarBand } from "./frequency-mapping";
import type { VisualStyleRenderer } from "./types";

/** Final canvas coordinates: scaling changes the composition, never its center or bounds. */
export function spectrumLayout(
  w: number,
  h: number,
  scale: number,
  glow: number,
  reservedTop = 0,
  reservedBottom = 0,
) {
  const short = Math.min(w, h),
    margin = Math.max(12, short * 0.035 + glow * short * 0.018);
  const zone = Math.max(1, Math.min(w - margin * 2, w * 0.78 * scale));
  const count = Math.max(32, Math.min(72, Math.round(zone / 12 / 2) * 2));
  const gap = Math.min((zone / count) * 0.4, Math.max(1.5, zone * 0.0025));
  const barWidth = (zone - gap * (count - 1)) / count;
  const maxHalf = Math.max(
    2,
    Math.min(
      short * 0.32 * scale,
      h / 2 - margin,
      h / 2 - reservedTop - margin,
      h / 2 - reservedBottom - margin,
    ),
  );
  return {
    centerX: w / 2,
    centerY: h / 2,
    x: (w - zone) / 2,
    zone,
    count,
    gap,
    barWidth,
    maxHalf,
    margin,
  };
}

function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: VisualSettings,
  bands: Float32Array[],
  energy: number,
  impact: number,
  fittedLogo: boolean,
  captionLane: number,
) {
  const short = Math.min(w, h),
    edge = Math.max(22, short * 0.055);
  // Reserve the same caption lane for the whole track, preventing layout jumps.
  let top = fittedLogo ? h * 0.21 + short * 0.085 * (s.logoFitScale.spectrum / 100) : 0;
  let bottom = captionLane ? edge + captionLane : 0;
  const overlay = trackOverlayLayout(w, h, s, captionLane);
  top = Math.max(top, overlay.topSpace);
  bottom = Math.max(bottom, overlay.bottomSpace);
  const layout = spectrumLayout(w, h, s.visualScale, s.glow, top, bottom);
  const { x, centerY: mid, zone, count, gap, barWidth, maxHalf } = layout;
  const idle = Math.min(maxHalf, Math.max(2, short * 0.004));
  const bars = Array.from({ length: count }, (_, i) => {
    const pos = Math.abs(i - (count - 1) / 2) / ((count - 1) / 2);
    // Each mirrored half spans the full frequency range.
    const bandwidth = 2 / (count - 1);
    const left = sampleBarBand(bands[0], pos, bandwidth),
      right = sampleBarBand(bands[Math.min(1, bands.length - 1)], pos, bandwidth);
    const value = Math.sqrt((left * left + right * right) / 2);
    const response = clamp(
      1 - Math.exp(-value * s.sensitivity * 3.8) + impact * 0.12 * (1 - pos) ** 2,
    );
    const amp = idle + response * (maxHalf - idle),
      bx = x + i * (barWidth + gap);
    const radius = Math.min(barWidth / 2, amp) * clamp((s.spectrumRoundness ?? 100) / 100);
    return { amp, bx, radius };
  });
  ctx.save();
  // Each half shares one clip and shadow setup; retain individual gradients.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, mid);
  ctx.clip();
  ctx.shadowColor = s.primary;
  ctx.shadowBlur = s.glow * short * 0.014;
  for (const { amp, bx, radius } of bars) {
    const upper = ctx.createLinearGradient(0, mid - amp, 0, mid);
    upper.addColorStop(0, s.secondary);
    upper.addColorStop(0.25, s.primary);
    upper.addColorStop(1, s.secondary);
    ctx.fillStyle = upper;
    ctx.beginPath();
    ctx.roundRect(bx, mid - amp, barWidth, amp * 2, radius);
    ctx.fill();
  }
  ctx.restore();
  const reflection = clamp((s.spectrumReflection ?? 45) / 100);
  if (reflection > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, mid, w, h - mid);
    ctx.clip();
    ctx.shadowBlur = 0;
    for (const { amp, bx, radius } of bars) {
      const lower = ctx.createLinearGradient(0, mid, 0, mid + amp);
      lower.addColorStop(0, rgba(s.secondary, reflection));
      lower.addColorStop(0.45, rgba(s.primary, reflection * 0.65));
      lower.addColorStop(1, rgba(s.secondary, reflection * 0.08));
      ctx.fillStyle = lower;
      ctx.beginPath();
      ctx.roundRect(bx, mid - amp, barWidth, amp * 2, radius);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.shadowBlur = 0;
  ctx.strokeStyle = rgba(s.secondary, 0.2 + energy * 0.25);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, mid);
  ctx.lineTo(x + zone, mid);
  ctx.stroke();
  ctx.restore();
}

export const spectrum: VisualStyleRenderer<VisualSettings> = {
  id: "spectrum",
  draw(ctx, frame, options) {
    drawSpectrum(
      ctx,
      frame.width,
      frame.height,
      options,
      frame.audio.bands as Float32Array[],
      frame.audio.energy,
      frame.audio.impact,
      frame.fittedLogo,
      frame.captionHeight,
    );
  },
};
