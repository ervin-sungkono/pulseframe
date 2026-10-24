import { clamp } from "./shared";

/** Smooth neighboring bands, then average one bar's fractional frequency footprint. */
export function sampleBarBand(
  channel: Float32Array | undefined,
  position: number,
  bandwidth: number,
) {
  if (!channel?.length) return 0;
  if (channel.length === 1) return channel[0];
  const value = (index: number) => channel[Math.max(0, Math.min(channel.length - 1, index))];
  // A small binomial filter softens repeated bass bins without altering DSP
  // measurements or the separate Pulse Ring response.
  const filtered = (index: number) =>
    (value(index - 2) +
      4 * value(index - 1) +
      6 * value(index) +
      4 * value(index + 1) +
      value(index + 2)) /
    16;
  const center = clamp(position) * (channel.length - 1),
    halfWidth = (clamp(bandwidth) * (channel.length - 1)) / 2,
    first = Math.max(0, center - halfWidth),
    last = Math.min(channel.length - 1, center + halfWidth);
  if (last <= first) {
    const index = Math.floor(center),
      fraction = center - index;
    return filtered(index) * (1 - fraction) + filtered(index + 1) * fraction;
  }
  let area = 0;
  for (let left = first; left < last;) {
    const index = Math.floor(left),
      right = Math.min(last, index + 1),
      start = left - index,
      end = right - index,
      amplitude = filtered(index),
      slope = filtered(index + 1) - amplitude;
    area += amplitude * (right - left) + (slope * (end * end - start * start)) / 2;
    left = right;
  }
  return area / (last - first);
}
