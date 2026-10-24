import { clamp } from "./shared";

/** Relative linear amplitude with the -12 dB display ceiling normalized to 1. */
export function ringBandAmplitude(value: number) {
  const floor = 10 ** (-63 / 20);
  return clamp((10 ** (((clamp(value) - 1) * 63) / 20) - floor) / (1 - floor));
}
