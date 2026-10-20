import type { VisualSettings } from "./visual-settings-model";

export type MotionTransform = { x: number; y: number; rotation: number; scale: number };

const TAU = Math.PI * 2;

function identity(): MotionTransform {
  return { x: 0, y: 0, rotation: 0, scale: 1 };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function wrapPhase(phase: number): number {
  const wrapped = phase % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

function hasValidClock(time: number, w: number, h: number): boolean {
  return Number.isFinite(time) && Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1;
}

function motionPhase(time: number, speed: number, angularRate: number): number {
  const rate = speed * angularRate;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const period = TAU / rate;
  if (period === Infinity) {
    const phase = time * rate;
    return Number.isFinite(phase) ? wrapPhase(phase) : 0;
  }
  if (!Number.isFinite(period) || period <= 0) return 0;
  let wrappedTime = time % period;
  if (wrappedTime < 0) wrappedTime += period;
  return wrapPhase(wrappedTime * rate);
}

/** Returns a deterministic ring-and-logo transform at an absolute media time. */
export function ringMotion(
  time: number,
  w: number,
  h: number,
  settings: VisualSettings,
  pulse: number,
  reducedMotion = false,
): MotionTransform {
  if (reducedMotion || !settings || settings.mode !== "ring" || !hasValidClock(time, w, h))
    return identity();

  const amount = Number.isFinite(settings.motionAmount) ? clamp01(settings.motionAmount / 100) : 0;
  const speed = settings.motionSpeed;
  const preset = settings.motionPreset;
  if (!amount || !Number.isFinite(speed) || speed <= 0 || typeof preset !== "string")
    return identity();

  const shortEdge = Math.min(w, h);
  const activity = clamp01(Number.isFinite(pulse) ? pulse : 0);
  const idle = { x: 0, y: 0, rotation: 0, scale: 1 };
  switch (preset) {
    case "orbit": {
      const phase = motionPhase(time, speed, TAU / 12);
      const radius = shortEdge * 0.1 * amount;
      return { x: Math.cos(phase) * radius, y: Math.sin(phase) * radius, rotation: 0, scale: 1 };
    }
    case "bounce": {
      const phase = motionPhase(time, speed, TAU / 4.8);
      const rise = shortEdge * 0.12 * amount;
      return { x: 0, y: -rise * (1 - Math.cos(phase)) * 0.5, rotation: 0, scale: 1 };
    }
    case "drift": {
      const phase = motionPhase(time, speed, TAU / 17);
      const verticalPhase = motionPhase(time, speed, (TAU / 17) * 0.71);
      return {
        x: Math.sin(phase) * shortEdge * 0.1 * amount,
        y: Math.sin(verticalPhase + 1.2) * shortEdge * 0.07 * amount,
        rotation: 0,
        scale: 1,
      };
    }
    case "rotate": {
      // Reducing the rate keeps each amount value a smooth full rotation loop.
      const phase = motionPhase(time, speed * amount, TAU / 16);
      return { x: 0, y: 0, rotation: phase % TAU, scale: 1 };
    }
    case "zoom": {
      const phase = motionPhase(time, speed, TAU / 8.5);
      return { x: 0, y: 0, rotation: 0, scale: 1 + 0.06 * amount * (1 + Math.sin(phase)) };
    }
    case "beat": {
      if (!activity) return idle;
      const jump = activity * amount;
      return {
        x: 0,
        y: -shortEdge * 0.08 * jump,
        rotation: 0,
        scale: 1 + 0.12 * jump,
      };
    }
    case "none":
    default:
      return idle;
  }
}

const SHAKE_RATE = 8.5;
const SHAKE_CELLS = 1024;
const SHAKE_PERIOD = SHAKE_CELLS / SHAKE_RATE;

function hashNoise(index: number, seed: number): number {
  let value = Math.imul(index ^ seed, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = (value ^ (value >>> 16)) >>> 0;
  return (value / 0xffffffff) * 2 - 1;
}

function shakeNoise(time: number, seed: number): number {
  // A periodic, seeded value-noise carrier stays smooth at its wrap point and
  // remains stable for seeks because it has no accumulated random state.
  const localTime = ((time % SHAKE_PERIOD) + SHAKE_PERIOD) % SHAKE_PERIOD;
  const position = localTime * SHAKE_RATE;
  const cell = Math.floor(position) % SHAKE_CELLS;
  const fraction = position - Math.floor(position);
  const smooth = fraction * fraction * fraction * (fraction * (fraction * 6 - 15) + 10);
  const start = hashNoise(cell, seed);
  const end = hashNoise((cell + 1) % SHAKE_CELLS, seed);
  return start + (end - start) * smooth;
}

/** Returns bounded camera translation and a steady overscan envelope. */
export function cameraMotion(
  time: number,
  w: number,
  h: number,
  settings: VisualSettings,
  pulse: number,
  activity: number,
  reducedMotion = false,
): MotionTransform {
  if (reducedMotion || !settings || settings.cameraShake !== true || !hasValidClock(time, w, h))
    return identity();

  const amount = Number.isFinite(settings.cameraShakeAmount)
    ? clamp01(settings.cameraShakeAmount / 100)
    : 0;
  const audioPulse = clamp01(Number.isFinite(pulse) ? pulse : 0);
  const audioActivity = clamp01(Number.isFinite(activity) ? activity : 0);
  const gate = amount * audioPulse * audioActivity;
  if (!gate) return identity();

  const shortEdge = Math.min(w, h);
  const maxDisplacement = shortEdge * 0.018 * gate;
  const x = maxDisplacement * shakeNoise(time, 0x13579bdf);
  const y = maxDisplacement * shakeNoise(time, 0x2468ace0);

  // Use the maximum carrier displacement for scale so zoom does not pulse as
  // the seeded noise crosses zero. The short edge covers both dimensions.
  const scale = 1 + (2 * maxDisplacement) / shortEdge;
  return { x, y, rotation: 0, scale };
}
