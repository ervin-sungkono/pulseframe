import type { VisualSettings } from "../visual-settings-model";
import { clamp } from "./legacy-common";
import { spectrumLayout } from "./spectrum";
import { sampleBarBand } from "./frequency-mapping";
import type { VisualStyleRenderer } from "./types";

export function edgeBarLayout(
  w: number,
  h: number,
  scale: number,
  glow: number,
  centerClearance = 0,
) {
  const base = spectrumLayout(w, h, scale, glow);
  return {
    ...base,
    maxHeight: Math.max(
      2,
      Math.min(Math.min(w, h) * 0.32 * scale, h * 0.38, h / 2 - centerClearance - base.margin),
    ),
  };
}
export function edgeBarResponse(
  bands: Float32Array[],
  index: number,
  count: number,
  edge: "top" | "bottom",
  sensitivity: number,
) {
  const position = edge === "top" ? index / (count - 1) : 1 - index / (count - 1);
  const bandwidth = 1 / Math.max(1, count - 1);
  const left = sampleBarBand(bands[0], position, bandwidth),
    right = sampleBarBand(bands[Math.min(1, bands.length - 1)], position, bandwidth);
  return 1 - Math.exp(-Math.sqrt((left * left + right * right) / 2) * sensitivity * 3.8);
}
function drawEdgeBars(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: VisualSettings,
  bands: Float32Array[],
  fittedLogo: boolean,
) {
  const clear = fittedLogo
    ? Math.min(w, h) * 0.085 * (s.logoFitScale.edges / 100) + s.glow * 16
    : 0;
  const { x, count, gap, barWidth, maxHeight } = edgeBarLayout(w, h, s.visualScale, s.glow, clear),
    idle = Math.min(3, maxHeight);
  ctx.save();
  ctx.shadowColor = s.primary;
  ctx.shadowBlur = s.glow * Math.min(w, h) * 0.009;
  for (const edge of ["top", "bottom"] as const) {
    for (let i = 0; i < count; i++) {
      const amp = idle + edgeBarResponse(bands, i, count, edge, s.sensitivity) * (maxHeight - idle);
      // Map both colors to the visible bar, so quiet frequencies retain the accent too.
      const gradient = ctx.createLinearGradient(
        0,
        edge === "top" ? 0 : h,
        0,
        edge === "top" ? amp : h - amp,
      );
      gradient.addColorStop(0, s.primary);
      gradient.addColorStop(0.55, s.secondary);
      gradient.addColorStop(1, s.secondary);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.roundRect(
        x + i * (barWidth + gap),
        edge === "top" ? 0 : h - amp,
        barWidth,
        amp,
        Math.min(barWidth / 2, amp / 2) * clamp((s.spectrumRoundness ?? 100) / 100),
      );
      ctx.fill();
    }
  }
  ctx.restore();
}

export const edgeBars: VisualStyleRenderer<VisualSettings> = {
  id: "edges",
  draw(ctx, frame, options) {
    drawEdgeBars(
      ctx,
      frame.width,
      frame.height,
      options,
      frame.audio.bands as Float32Array[],
      frame.fittedLogo,
    );
  },
};
