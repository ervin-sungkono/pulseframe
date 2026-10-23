export const rgba = (hex: string, alpha: number) => {
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16) || 0;
  const g = parseInt(v.slice(2, 4), 16) || 0;
  const b = parseInt(v.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
};

export const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Relative linear amplitude with the -12 dB display ceiling normalized to 1. */
export function ringBandAmplitude(value: number) {
  const floor = 10 ** (-63 / 20);
  return clamp((10 ** (((clamp(value) - 1) * 63) / 20) - floor) / (1 - floor));
}
