import { ANALYSIS_FPS } from "./audio-analysis-config";
import type { ResponseStyle, VisualSettings } from "./visual-settings-model";
import { activeSubtitle, type SubtitleCue } from "./subtitles";
import type { SoundEnvelope } from "./audio-features";
import { drawGlitch } from "./glitch";
import { drawTrackOverlay, trackOverlayLayout } from "./track-overlay";
import { drawBeatLighting } from "./beat-lighting";

export type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  phase: number;
};
export type VideoLayer = HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas;
export type LogoLayer = HTMLImageElement | ImageBitmap;
export type AudioReactiveState = {
  activity: number;
  bass: number;
  energy: number;
  bands: Float32Array[];
  ringBaseline: number;
  ringPulse: number;
  ringMix: number;
  ringBands: Float32Array[][];
};
export type RenderExtras = {
  sound?: SoundEnvelope | null;
  background?: LogoLayer | null;
  drop?: number;
  reducedMotion?: boolean;
};

export function createAudioReactiveState(): AudioReactiveState {
  return {
    activity: 0,
    bass: 0,
    energy: 0,
    bands: [],
    ringBaseline: 0,
    ringPulse: 0,
    ringMix: 0,
    ringBands: [],
  };
}

export function makeParticles(count: number): Particle[] {
  let seed = 0x5f3759df;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  return Array.from({ length: count }, (_, i) => ({
    x: random(),
    y: random(),
    vx: (random() - 0.5) * 0.00018,
    vy: (random() - 0.5) * 0.00018,
    size: 0.6 + random() * 2.3,
    phase: i * 2.39996 + random(),
  }));
}

const rgba = (hex: string, alpha: number) => {
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16) || 0;
  const g = parseInt(v.slice(2, 4), 16) || 0;
  const b = parseInt(v.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
};

const average = (data: Uint8Array, start: number, end: number) => {
  let sum = 0;
  for (let i = start; i < end; i++) sum += data[i] || 0;
  return sum / Math.max(1, end - start) / 255;
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const band = (data: Uint8Array, start: number, end: number) => {
  let peak = 0;
  for (let i = start; i < end; i++) peak = Math.max(peak, data[i] || 0);
  return (0.68 * peak) / 255 + 0.32 * average(data, start, end);
};

function smooth(
  current: number,
  target: number,
  deltaMs: number,
  attackMs: number,
  releaseMs: number,
) {
  if (deltaMs <= 0) return current;
  const period = target > current ? attackMs : releaseMs;
  return current + (target - current) * (1 - Math.exp(-deltaMs / period));
}

/** Relative linear amplitude with the -12 dB display ceiling normalized to 1. */
export function ringBandAmplitude(value: number) {
  const floor = 10 ** (-63 / 20);
  return clamp((10 ** (((clamp(value) - 1) * 63) / 20) - floor) / (1 - floor));
}

function updateRingResponse(
  frame: SoundEnvelope,
  settings: VisualSettings,
  state: AudioReactiveState,
  activity: number,
  deltaMs: number,
  speed: number,
) {
  const power = (db: number) => 10 ** (db / 10);
  const totalPower = power(frame.bassDb) + power(frame.middleDb) + power(frame.highDb);
  const bassShare = power(frame.ringBassDb ?? frame.bassDb) / Math.max(1e-12, totalPower);
  const mix = activity > 0.05 ? clamp((0.65 - bassShare) / 0.5) : state.ringMix;
  state.ringMix = smooth(state.ringMix, mix, deltaMs, 160, 400);
  const amplitude = 10 ** ((frame.bassHitDb ?? frame.bassDb) / 20);
  // Compare bass with its recent local level: sustained bass should not hold
  // the logo permanently expanded. No beat grid or future samples are used.
  const rise = Math.max(0, amplitude - state.ringBaseline) / Math.max(0.018, state.ringBaseline);
  const level = 1 - Math.exp(-amplitude * settings.bassBoost * settings.sensitivity * 4);
  const impact = Math.tanh(rise * 0.85 * settings.bassBoost);
  state.ringPulse = smooth(
    state.ringPulse,
    (level * 0.25 + impact * 0.75) * activity,
    deltaMs,
    9 * speed,
    85 * speed,
  );
  state.ringBaseline = smooth(state.ringBaseline, amplitude, deltaMs, 260, 420);
  if (state.ringBands.length !== 4 || state.ringBands[0]?.length !== frame.bands.length) {
    state.ringBands = Array.from({ length: 4 }, () =>
      frame.bands.map((channel) => new Float32Array(channel.length)),
    );
  }
  // Later layers react more slowly, leaving short transparent color echoes.
  for (let c = 0; c < frame.bands.length; c++)
    for (let i = 0; i < frame.bands[c].length; i++) {
      const target = ringBandAmplitude(frame.bands[c][i]) * activity;
      for (let layer = 0; layer < 4; layer++)
        state.ringBands[layer][c][i] = smooth(
          state.ringBands[layer][c][i],
          target,
          deltaMs,
          (9 + layer * 28) * speed,
          (75 + layer * 38) * speed,
        );
    }
}

export function soundResponse(
  frame: SoundEnvelope,
  settings: VisualSettings,
  state: AudioReactiveState,
  deltaMs: number,
) {
  const speed =
    settings.responseStyle === "punchy" ? 0.55 : settings.responseStyle === "smooth" ? 1.7 : 1;
  const activity = clamp((frame.rms - settings.quietThreshold) / 0.018);
  const level = (value: number, floor: number, ceiling: number) =>
    clamp((value - floor) / (ceiling - floor));
  const bass = level(frame.bassDb, -55, -12) * settings.bassBoost;
  const energy = Math.max(
    level(frame.rmsDb, -58, -9),
    bass * 0.75,
    level(frame.middleDb, -62, -18) * 0.55,
    level(frame.highDb, -72, -24) * 0.4,
  );
  state.activity = smooth(state.activity, activity, deltaMs, 28 * speed, 210 * speed);
  state.bass = smooth(state.bass, clamp(bass), deltaMs, 16 * speed, 170 * speed);
  // Soft saturation preserves contrast in loud masters without changing measurements.
  state.energy = smooth(
    state.energy,
    Math.tanh(energy * settings.sensitivity) * activity,
    deltaMs,
    20 * speed,
    180 * speed,
  );
  if (state.bands.length !== frame.bands.length)
    state.bands = frame.bands.map((b) => new Float32Array(b.length));
  for (let c = 0; c < frame.bands.length; c++)
    for (let i = 0; i < frame.bands[c].length; i++) {
      state.bands[c][i] = smooth(
        state.bands[c][i],
        frame.bands[c][i] * activity,
        deltaMs,
        12 * speed,
        100 * speed,
      );
    }
  updateRingResponse(frame, settings, state, activity, deltaMs, speed);
  return { activity: state.activity, bassPulse: state.bass * state.activity, energy: state.energy };
}

export function warmSoundResponse(
  envelopes: SoundEnvelope[],
  settings: VisualSettings,
  time: number,
) {
  const state = createAudioReactiveState(),
    count = Math.ceil(time * ANALYSIS_FPS);
  const silence: SoundEnvelope = {
    rms: 0,
    rmsDb: -160,
    bassDb: -160,
    middleDb: -160,
    highDb: -160,
    bands: (envelopes[0]?.bands ?? []).map((b) => new Float32Array(b.length)),
  };
  // Beyond ten seconds of trailing silence, every release is below a pixel.
  if (!envelopes.length || count > envelopes.length + 10 * ANALYSIS_FPS)
    return { state, lastTime: time };
  for (let i = 0; i < count; i++)
    soundResponse(envelopes[i] ?? silence, settings, state, i ? 1000 / ANALYSIS_FPS : 0);
  return { state, lastTime: count ? (count - 1) / ANALYSIS_FPS : 0 };
}

// Use the waveform's actual level to reject FFT noise and the modes' idle shapes.
// Subtract its mean so a DC offset cannot keep the visualization active.
export function audioActivity(wave: Uint8Array, threshold: number) {
  if (!wave.length) return 0;
  let sum = 0,
    squares = 0;
  for (let i = 0; i < wave.length; i++) {
    const sample = (wave[i] - 128) / 128;
    sum += sample;
    squares += sample * sample;
  }
  const mean = sum / wave.length;
  const rms = Math.sqrt(Math.max(0, squares / wave.length - mean * mean));
  return clamp((rms - threshold) / 0.018);
}

// Narrow tones must not be diluted by dozens of empty FFT bins. A slower
// release on the activity and bass envelopes prevents quiet fades from blinking.
export function audioResponse(
  frequency: Uint8Array,
  wave: Uint8Array,
  threshold: number,
  sensitivity: number,
  state: AudioReactiveState,
  deltaMs: number,
  sampleRate = 48000,
  bassBoost = 1,
  responseStyle: ResponseStyle = "balanced",
) {
  const bin = (hz: number) =>
    Math.max(
      1,
      Math.min(frequency.length - 1, Math.round((hz * frequency.length * 2) / sampleRate)),
    );
  const bass = band(frequency, bin(30), Math.max(bin(30) + 1, bin(180)));
  const mid = band(frequency, bin(180), Math.max(bin(180) + 1, bin(2500)));
  const treble = band(frequency, bin(2500), Math.max(bin(2500) + 1, bin(10000)));
  const activity = audioActivity(wave, threshold);
  const speed = responseStyle === "punchy" ? 0.55 : responseStyle === "smooth" ? 1.7 : 1;
  state.activity = smooth(state.activity, activity, deltaMs, 42 * speed, 210 * speed);
  state.bass = smooth(state.bass, clamp(bass * bassBoost), deltaMs, 28 * speed, 170 * speed);
  const boostedBass = clamp(bass * bassBoost);
  const targetEnergy =
    clamp(
      Math.max(
        boostedBass * 0.9,
        mid * 0.72,
        treble * 0.6,
        boostedBass * 0.52 + mid * 0.32 + treble * 0.16,
      ) * sensitivity,
    ) * activity;
  state.energy = smooth(state.energy, targetEnergy, deltaMs, 32 * speed, 180 * speed);
  return { activity: state.activity, bassPulse: state.bass * state.activity, energy: state.energy };
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  video: VideoLayer | LogoLayer,
  w: number,
  h: number,
  overscan = 1,
) {
  const vw =
    "videoWidth" in video
      ? video.videoWidth
      : "naturalWidth" in video
        ? video.naturalWidth
        : video.width;
  const vh =
    "videoHeight" in video
      ? video.videoHeight
      : "naturalHeight" in video
        ? video.naturalHeight
        : video.height;
  if (!vw || !vh) return;
  const scale = Math.max(w / vw, h / vh) * overscan;
  const dw = vw * scale,
    dh = vh * scale;
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: VisualSettings,
  t: number,
  video?: VideoLayer | null,
  image?: LogoLayer | null,
  drop = 0,
) {
  ctx.fillStyle = s.background;
  ctx.fillRect(0, 0, w, h);
  const layer = image ?? video;
  if (layer && (!("readyState" in layer) || layer.readyState >= 2)) {
    ctx.save();
    ctx.globalAlpha = (image ? s.backgroundOpacity : s.videoOpacity) / 100;
    if (drop > 0) ctx.filter = `blur(${(drop * Math.min(w, h)) / 144}px)`;
    drawCover(ctx, layer, w, h, drop > 0 ? 1.045 : 1);
    ctx.restore();
    if (!image) {
      ctx.fillStyle = "rgba(3,5,20,.32)";
      ctx.fillRect(0, 0, w, h);
    }
  }
  const wash = ctx.createRadialGradient(
    w * 0.5,
    h * 0.45,
    0,
    w * 0.5,
    h * 0.45,
    Math.max(w, h) * 0.8,
  );
  wash.addColorStop(0, rgba(s.primary, (s.backdrop === "clean" ? 0.055 : 0.1) * s.atmosphere));
  wash.addColorStop(0.55, rgba(s.secondary, 0.035 * s.atmosphere));
  wash.addColorStop(1, "rgba(0,0,0,.54)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);
  if (s.backdrop === "nebula") {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const span = Math.max(w, h);
    for (let i = 0; i < 3; i++) {
      const x = w * (0.23 + i * 0.29) + Math.sin(t * 0.12 + i * 2.1) * w * 0.055;
      const y = h * (0.38 + (i % 2) * 0.22) + Math.cos(t * 0.16 + i) * h * 0.045;
      const bloom = ctx.createRadialGradient(x, y, 0, x, y, span * 0.42);
      bloom.addColorStop(0, rgba(i === 1 ? s.secondary : s.primary, 0.16 * s.atmosphere));
      bloom.addColorStop(0.45, rgba(i === 1 ? s.secondary : s.primary, 0.055 * s.atmosphere));
      bloom.addColorStop(1, rgba(s.primary, 0));
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  } else if (s.backdrop === "grid") {
    ctx.save();
    ctx.strokeStyle = rgba(s.primary, 0.06);
    ctx.lineWidth = 1;
    const grid = Math.max(36, Math.round(w / 24));
    const shift = (t * 3) % grid;
    for (let x = shift; x < w; x += grid) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = shift; y < h; y += grid) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

const ringInnerRadius = (unit: number, bass: number) => unit * (0.205 + bass * 0.016) * 0.88;

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

function drawRing(
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

export function sampleBarBand(channel: Float32Array | undefined, position: number, count: number) {
  if (!channel?.length) return 0;
  const index = clamp(position) * (channel.length - 1),
    halfStep = (channel.length - 1) / Math.max(1, count - 1);
  const first = Math.max(0, Math.floor(index - halfStep)),
    last = Math.min(channel.length - 1, Math.ceil(index + halfStep));
  let peak = 0,
    power = 0;
  for (let k = first; k <= last; k++) {
    peak = Math.max(peak, channel[k]);
    power += channel[k] ** 2;
  }
  return peak * 0.75 + Math.sqrt(power / (last - first + 1)) * 0.25;
}

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
  const left = sampleBarBand(bands[0], position, count),
    right = sampleBarBand(bands[Math.min(1, bands.length - 1)], position, count);
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
  for (const edge of ["top", "bottom"] as const) {
    const gradient = ctx.createLinearGradient(
      0,
      edge === "top" ? 0 : h,
      0,
      edge === "top" ? maxHeight : h - maxHeight,
    );
    gradient.addColorStop(0, s.primary);
    gradient.addColorStop(0.65, s.primary);
    gradient.addColorStop(1, s.secondary);
    ctx.fillStyle = gradient;
    ctx.shadowColor = s.primary;
    ctx.shadowBlur = s.glow * Math.min(w, h) * 0.009;
    for (let i = 0; i < count; i++) {
      const amp = idle + edgeBarResponse(bands, i, count, edge, s.sensitivity) * (maxHeight - idle);
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
    const left = sampleBarBand(bands[0], pos, count),
      right = sampleBarBand(bands[Math.min(1, bands.length - 1)], pos, count);
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

/** Log-frequency, linear-amplitude bands for the non-PCM demo fallback. */
function fallbackBands(frequency: Uint8Array, sampleRate: number, activity: number) {
  const top = Math.min(16000, sampleRate / 2);
  return [
    Float32Array.from({ length: 96 }, (_, i) => {
      const low = 35 * (top / 35) ** (i / 96),
        high = 35 * (top / 35) ** ((i + 1) / 96);
      const first = Math.max(1, Math.round((low * frequency.length * 2) / sampleRate));
      const last = Math.min(
        frequency.length - 1,
        Math.max(first, Math.round((high * frequency.length * 2) / sampleRate)),
      );
      let peak = 0;
      for (let k = first; k <= last; k++) peak = Math.max(peak, frequency[k] ?? 0);
      return ringBandAmplitude(peak / 255) * activity;
    }),
  ];
}

export function coverCrop(sourceW: number, sourceH: number, targetW: number, targetH: number) {
  const sourceAspect = sourceW / sourceH,
    targetAspect = targetW / targetH;
  const width = sourceAspect > targetAspect ? sourceH * targetAspect : sourceW;
  const height = sourceAspect > targetAspect ? sourceH : sourceW / targetAspect;
  return { x: (sourceW - width) / 2, y: (sourceH - height) / 2, width, height };
}

function drawLogo(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: VisualSettings,
  image: LogoLayer,
  bass: number,
) {
  const sourceW = image.width,
    sourceH = image.height;
  if (!sourceW || !sourceH) return;
  ctx.save();
  ctx.globalAlpha = s.logoOpacity / 100;
  if (s.logoAutoFit[s.mode]) {
    const short = Math.min(w, h);
    const circle = s.mode === "ring";
    const width = circle ? ringInnerRadius(short, bass) * 2 * s.visualScale : short * 0.36;
    const height = circle ? width : short * 0.17;
    const centerY = circle || s.mode === "edges" ? h / 2 : h * 0.21;
    const scale = Math.max(0.5, Math.min(1, (s.logoFitScale?.[s.mode] ?? 100) / 100));
    const clipScale = Math.min(1, scale),
      clipW = width * clipScale,
      clipH = height * clipScale;
    const left = w / 2 - clipW / 2,
      top = centerY - clipH / 2;
    ctx.beginPath();
    if (circle) ctx.arc(w / 2, centerY, clipW / 2, 0, Math.PI * 2);
    else ctx.roundRect(left, top, clipW, clipH, Math.min(clipH * 0.17, 18));
    ctx.fillStyle = rgba(s.background, 0.72);
    ctx.shadowColor = s.primary;
    ctx.shadowBlur = s.glow * 16;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.clip();
    // Cover the aperture without distorting the logo. The clip removes the excess.
    const crop = coverCrop(sourceW, sourceH, width, height);
    ctx.drawImage(
      image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      w / 2 - (width * scale) / 2,
      centerY - (height * scale) / 2,
      width * scale,
      height * scale,
    );
  } else {
    const place = s.logoPlacements[s.mode];
    const box = (Math.min(w, h) * place.size) / 100;
    const ratio = sourceW / sourceH;
    const drawW = ratio >= 1 ? box : box * ratio;
    const drawH = ratio >= 1 ? box / ratio : box;
    ctx.shadowColor = s.primary;
    ctx.shadowBlur = s.glow * 12;
    ctx.drawImage(
      image,
      (w * place.x) / 100 - drawW / 2,
      (h * place.y) / 100 - drawH / 2,
      drawW,
      drawH,
    );
  }
  ctx.restore();
}

function drawParticles(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: VisualSettings,
  particles: Particle[],
  energy: number,
  t: number,
) {
  const boost = 1 + energy * 1.5;
  const visible = Math.min(s.particleCount, particles.length);
  const drift = s.particleMode === "comets" ? 2.2 : s.particleMode === "sparks" ? 1.55 : 0.65;
  const wrap = (n: number) => ((n % 1) + 1) % 1;
  const positions = particles.slice(0, visible).map((p) => {
    if (s.particleFlow === "rise")
      return {
        x: wrap(p.x + Math.sin(t * 0.4 + p.phase) * 0.03),
        y: wrap(p.y - t * (0.017 + p.size * 0.006) * drift),
      };
    if (s.particleFlow === "orbit") {
      const angle = p.phase + t * (0.12 + p.size * 0.02) * drift;
      const radius = 0.08 + p.x * 0.52;
      return {
        x: 0.5 + Math.cos(angle) * radius,
        y: 0.5 + Math.sin(angle) * radius * Math.min(1, w / h),
      };
    }
    return { x: wrap(p.x + p.vx * t * 1000 * drift), y: wrap(p.y + p.vy * t * 1000 * drift) };
  });
  ctx.save();
  if (s.particleMode === "constellation") {
    ctx.lineWidth = 1;
    for (let i = 0; i < visible; i++) {
      for (let j = i + 1; j < Math.min(visible, i + 15); j++) {
        const a = positions[i],
          b = positions[j];
        const dx = (a.x - b.x) * w,
          dy = (a.y - b.y) * h;
        const distance = Math.hypot(dx, dy);
        if (distance < Math.min(w, h) * 0.17) {
          ctx.strokeStyle = rgba(
            s.secondary,
            (1 - distance / (Math.min(w, h) * 0.17)) * 0.23 * boost,
          );
          ctx.beginPath();
          ctx.moveTo(a.x * w, a.y * h);
          ctx.lineTo(b.x * w, b.y * h);
          ctx.stroke();
        }
      }
    }
  }
  for (let i = 0; i < visible; i++) {
    const p = particles[i],
      position = positions[i];
    const twinkle = 0.5 + 0.5 * Math.sin(t * 2 + p.phase);
    const r = p.size * (w / 900) * s.particleSize * (1 + energy * 0.8);
    ctx.fillStyle = rgba(i % 4 ? s.primary : s.secondary, 0.22 + twinkle * 0.48);
    ctx.shadowColor = i % 4 ? s.primary : s.secondary;
    ctx.shadowBlur = s.glow * (s.particleMode === "comets" ? 14 : 7);
    ctx.beginPath();
    ctx.arc(position.x * w, position.y * h, Math.max(0.7, r), 0, Math.PI * 2);
    ctx.fill();
    if ((s.particleMode === "sparks" && i % 4 === 0) || s.particleMode === "comets") {
      ctx.strokeStyle = rgba(s.secondary, 0.13 + twinkle * 0.3);
      ctx.lineWidth = Math.max(1, r * (s.particleMode === "comets" ? 1.1 : 0.5));
      const length = s.particleMode === "comets" ? 430 : 100;
      ctx.beginPath();
      ctx.moveTo(position.x * w, position.y * h);
      ctx.lineTo(
        (position.x - p.vx * length * boost) * w,
        (position.y - p.vy * length * boost) * h,
      );
      ctx.stroke();
    }
  }
  ctx.restore();
}

function fitText(ctx: CanvasRenderingContext2D, raw: string, maxWidth: number) {
  const text = raw.trim().replace(/\s+/g, " ");
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  let low = 0,
    high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(chars.slice(0, mid).join("") + "…").width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join("").trimEnd() + "…";
}

function subtitleLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const words = text.trim().replace(/\s+/g, " ").split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth && lines.length < 2) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}
const subtitleLaneCache = new WeakMap<SubtitleCue[], Map<string, number>>();
function subtitleLane(ctx: CanvasRenderingContext2D, w: number, h: number, cues: SubtitleCue[]) {
  if (!cues.length) return 0;
  const key = `${w}:${h}`;
  let sizes = subtitleLaneCache.get(cues);
  if (!sizes) {
    sizes = new Map();
    subtitleLaneCache.set(cues, sizes);
  }
  const cached = sizes.get(key);
  if (cached !== undefined) return cached;
  const fontSize = Math.round(Math.max(24, Math.min(w, h) * 0.046));
  ctx.save();
  ctx.font = `700 ${fontSize}px ui-sans-serif,system-ui,sans-serif`;
  let rows = 1;
  for (const cue of cues) rows = Math.max(rows, subtitleLines(ctx, cue.text, w * 0.84).length);
  ctx.restore();
  const height = Math.min(3, rows) * fontSize * 1.3 + fontSize * 0.55;
  sizes.set(key, height);
  return height;
}

function drawSubtitle(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cues: SubtitleCue[],
  time: number,
) {
  const cue = activeSubtitle(cues, time);
  if (!cue) return;
  const unit = Math.min(w, h),
    fontSize = Math.round(Math.max(24, unit * 0.046));
  const maxWidth = w * 0.84;
  ctx.save();
  ctx.font = `700 ${fontSize}px ui-sans-serif,system-ui,sans-serif`;
  const lines = subtitleLines(ctx, cue.text, maxWidth);
  const shown = lines.slice(0, 3).map((item) => fitText(ctx, item, maxWidth));
  const lineH = fontSize * 1.3,
    blockH = shown.length * lineH + fontSize * 0.55;
  const bottom = h - Math.max(unit * 0.055, 22);
  const top = bottom - blockH;
  ctx.fillStyle = "rgba(5,8,18,.76)";
  ctx.beginPath();
  ctx.roundRect(w * 0.07, top, w * 0.86, blockH, fontSize * 0.38);
  ctx.fill();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "#000";
  ctx.shadowBlur = fontSize * 0.22;
  shown.forEach((item, i) => ctx.fillText(item, w / 2, top + fontSize * 0.42 + (i + 0.5) * lineH));
  ctx.restore();
}

export function drawVisualization(
  ctx: CanvasRenderingContext2D,
  settings: VisualSettings,
  frequency: Uint8Array,
  wave: Uint8Array,
  particles: Particle[],
  time: number,
  deltaMs: number,
  video?: VideoLayer | null,
  logo?: LogoLayer | null,
  audioState?: AudioReactiveState,
  sampleRate = 48000,
  duration = 0,
  subtitles: SubtitleCue[] = [],
  extras: RenderExtras = {},
) {
  const w = ctx.canvas.width,
    h = ctx.canvas.height;
  const motionTime = extras.reducedMotion ? 0 : time * settings.motionSpeed;
  const state = audioState ?? createAudioReactiveState();
  const response = extras.sound
    ? soundResponse(extras.sound, settings, state, audioState ? deltaMs : 1000)
    : audioResponse(
        frequency,
        wave,
        settings.quietThreshold,
        settings.sensitivity,
        state,
        audioState ? deltaMs : 1000,
        sampleRate,
        settings.bassBoost,
        settings.responseStyle,
      );
  const { activity, bassPulse, energy } = response;
  const ringPulse = extras.sound ? state.ringPulse : bassPulse;
  // Keep the composition on screen in silent passages. Only the audio-driven
  // part of each shape is gated, so low-level analyser noise cannot animate it.
  const captionHeight = subtitleLane(ctx, w, h, subtitles);
  const bands = extras.sound
    ? (state.ringBands[0] ?? [])
    : fallbackBands(frequency, sampleRate, activity);
  ctx.clearRect(0, 0, w, h);
  const drop = settings.dropEffects && !extras.reducedMotion ? (extras.drop ?? 0) : 0;
  drawBackdrop(ctx, w, h, settings, motionTime, video, extras.background, drop);
  if (drop > 0) {
    const aura = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.16,
      w / 2,
      h / 2,
      Math.min(w, h) * 0.58,
    );
    aura.addColorStop(0, rgba(settings.secondary, drop * settings.glow * 0.15));
    aura.addColorStop(0.5, rgba(settings.primary, drop * settings.glow * 0.13));
    aura.addColorStop(1, rgba(settings.primary, 0));
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, w, h);
  }
  if (settings.beatRays && activity > 0)
    drawBeatLighting(ctx, w, h, settings, ringPulse, motionTime, extras.reducedMotion);
  if (settings.particles) {
    ctx.save();
    ctx.globalAlpha = 0.26 + activity * 0.74;
    drawParticles(ctx, w, h, settings, particles, energy, motionTime);
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha = 0.7 + activity * 0.3;
  if (settings.mode === "ring") {
    ctx.translate(w / 2, h / 2);
    ctx.scale(settings.visualScale, settings.visualScale);
    ctx.translate(-w / 2, -h / 2);
  }
  if (settings.mode === "ring")
    drawRing(
      ctx,
      w,
      h,
      settings,
      extras.sound ? state.ringBands : [bands],
      ringPulse,
      energy,
      sampleRate,
      extras.sound ? state.ringMix : 1,
    );
  if (settings.mode === "edges")
    drawEdgeBars(ctx, w, h, settings, bands, !!logo && settings.logoAutoFit.edges);
  if (settings.mode === "spectrum")
    drawSpectrum(
      ctx,
      w,
      h,
      settings,
      bands,
      energy,
      ringPulse,
      !!logo && settings.logoAutoFit.spectrum,
      captionHeight,
    );
  if (settings.trails) {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(motionTime * 0.14);
    const reach = Math.min(w, h) * 0.43;
    for (let i = 0; i < 5; i++) {
      const angle = (i * Math.PI * 2) / 5 + motionTime * 0.18;
      ctx.beginPath();
      ctx.arc(0, 0, reach + i * 3 + energy * 12, angle, angle + 0.32 + energy * 0.42);
      ctx.strokeStyle = rgba(i % 2 ? settings.secondary : settings.primary, 0.16 + energy * 0.2);
      ctx.lineWidth = Math.max(1.5, w / 680);
      ctx.lineCap = "round";
      ctx.shadowColor = i % 2 ? settings.secondary : settings.primary;
      ctx.shadowBlur = settings.glow * 20;
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
  const vignette = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.2,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.72,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,.42)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
  const glitchActivity = extras.sound && extras.sound.rms <= settings.quietThreshold ? 0 : activity;
  if (settings.glitch && !extras.reducedMotion)
    drawGlitch(ctx, time, energy, bassPulse, glitchActivity, settings.glitchStrength);
  if (logo) drawLogo(ctx, w, h, settings, logo, settings.mode === "ring" ? ringPulse : bassPulse);
  drawTrackOverlay(ctx, w, h, settings, time, duration, captionHeight);
  drawSubtitle(ctx, w, h, subtitles, time);
}
