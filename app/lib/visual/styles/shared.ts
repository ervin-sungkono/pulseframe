export const TAU = Math.PI * 2;
export const finite = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);
export const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, finite(value)));

export function rgba(hex: string, alpha: number) {
  const color = /^#[\da-f]{6}$/i.test(hex) ? hex : "#ffffff";
  return `rgba(${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)},${clamp(alpha)})`;
}

/** Linear-amplitude interpolation on the DSP's calibrated logarithmic bands. */
export function sampleBands(bands: readonly Float32Array[], position: number, width = 0) {
  let sum = 0;
  for (const channel of bands) {
    if (!channel.length) continue;
    const sample = (u: number) => {
      const index = clamp(u) * (channel.length - 1),
        first = Math.floor(index),
        mix = index - first;
      return (
        clamp(channel[first]) * (1 - mix) +
        clamp(channel[Math.min(channel.length - 1, first + 1)]) * mix
      );
    };
    const value =
      sample(position) * 0.5 +
      sample(position - width * 0.5) * 0.25 +
      sample(position + width * 0.5) * 0.25;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, bands.length));
}

/** A closed quadratic B-spline stays inside its bounded control-point hull. */
export function closedCurve(ctx: CanvasRenderingContext2D, points: Float32Array, count: number) {
  if (count < 3) return;
  ctx.beginPath();
  ctx.moveTo(
    (points[(count - 1) * 2] + points[0]) / 2,
    (points[(count - 1) * 2 + 1] + points[1]) / 2,
  );
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    ctx.quadraticCurveTo(
      points[i * 2],
      points[i * 2 + 1],
      (points[i * 2] + points[next * 2]) / 2,
      (points[i * 2 + 1] + points[next * 2 + 1]) / 2,
    );
  }
  ctx.closePath();
}
