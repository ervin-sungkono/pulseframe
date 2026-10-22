import { ANALYSIS_FPS } from "../audio/audio-analysis-config";
import { DSP_BAND_COUNT } from "../dsp/contracts";
import type { ResponseStyle, VisualSettings } from "./visual-settings-model";
import { activeSubtitles, type SubtitleCue } from "../subtitles/model";
import type { SoundEnvelope } from "../audio/audio-features";
import { drawGlitch } from "./glitch";
import { drawTrackOverlay } from "./track-overlay";
import { drawBeatLighting } from "./beat-lighting";
import { clamp, rgba, ringBandAmplitude } from "./styles/legacy-common";
import { ringInnerRadius } from "./styles/pulse-ring";
import { drawVisualStyle } from "./styles/registry";
import type { FrequencyHistory } from "./styles/types";
import { bandEnergy } from "./styles/frequency-history";
import { sampleBands } from "./styles/shared";
import { radialSpectrumAperture } from "./styles/radial-spectrum";
export { ringBandAmplitude } from "./styles/legacy-common";
export { ringMagnitude } from "./styles/pulse-ring";
export { spectrumLayout } from "./styles/spectrum";
export { sampleBarBand } from "./styles/frequency-mapping";
export { edgeBarLayout, edgeBarResponse } from "./styles/edge-bars";

const styleBandBuffers = new WeakMap<CanvasRenderingContext2D, Float32Array>();

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
  history?: FrequencyHistory;
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

const average = (data: Uint8Array, start: number, end: number) => {
  let sum = 0;
  for (let i = start; i < end; i++) sum += data[i] || 0;
  return sum / Math.max(1, end - start) / 255;
};

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
  return {
    activity: state.activity,
    bassPulse: state.bass * state.activity,
    energy: state.energy,
  };
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
  return {
    activity: state.activity,
    bassPulse: state.bass * state.activity,
    energy: state.energy,
  };
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
    const circle = s.mode === "ring" || s.mode === "radial";
    const radialAperture =
      s.mode === "radial"
        ? radialSpectrumAperture(
            {
              width: w,
              height: h,
              visualScale: s.visualScale,
              glow: s.glow,
            },
            s.radialOptions,
          ) * 1.9
        : 0;
    const width =
      s.mode === "ring"
        ? ringInnerRadius(short, bass) * 2 * s.visualScale
        : s.mode === "radial"
          ? radialAperture
          : short * 0.36;
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
    return {
      x: wrap(p.x + p.vx * t * 1000 * drift),
      y: wrap(p.y + p.vy * t * 1000 * drift),
    };
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

function subtitleFontSize(w: number, h: number) {
  return Math.round(Math.max(24, Math.min(w, h) * 0.046));
}

function wrappedSubtitleLines(ctx: CanvasRenderingContext2D, cue: SubtitleCue, width: number) {
  return subtitleLines(ctx, cue.text, width)
    .slice(0, 3)
    .map((line) => fitText(ctx, line, width));
}

function subtitleBlockHeight(lines: string[], fontSize: number) {
  return lines.length * fontSize * 1.3 + fontSize * 0.55;
}

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

  const fontSize = subtitleFontSize(w, h);
  const gap = fontSize * 0.16;
  ctx.save();
  ctx.font = `700 ${fontSize}px ui-sans-serif,system-ui,sans-serif`;
  const heights = new Map<SubtitleCue, number>();
  for (const cue of cues) {
    if (
      !Number.isFinite(cue.start) ||
      !Number.isFinite(cue.end) ||
      cue.end <= cue.start ||
      !cue.text.trim()
    )
      continue;
    heights.set(cue, subtitleBlockHeight(wrappedSubtitleLines(ctx, cue, w * 0.84), fontSize));
  }
  let peak = 0;
  for (const cue of heights.keys()) {
    const active = activeSubtitles(cues, cue.start);
    const stackHeight =
      active.reduce((sum, item) => sum + (heights.get(item) ?? 0), 0) +
      Math.max(0, active.length - 1) * gap;
    peak = Math.max(peak, stackHeight);
  }
  ctx.restore();

  const height = Math.min(h * 0.42, peak);
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
  const active = activeSubtitles(cues, time);
  if (!active.length) return;

  const unit = Math.min(w, h);
  const naturalFontSize = subtitleFontSize(w, h);
  const laneCapacity = subtitleLane(ctx, w, h, cues);
  if (laneCapacity <= 0) return;

  const naturalLineHeight = naturalFontSize * 1.3;
  const naturalPadding = naturalFontSize * 0.55;
  const naturalGap = naturalFontSize * 0.16;
  ctx.save();
  ctx.font = `700 ${naturalFontSize}px ui-sans-serif,system-ui,sans-serif`;
  const lines = active.map((cue) => wrappedSubtitleLines(ctx, cue, w * 0.84));
  const blockHeights = lines.map((items) => subtitleBlockHeight(items, naturalFontSize));
  const totalHeight =
    blockHeights.reduce((sum, height) => sum + height, 0) +
    Math.max(0, active.length - 1) * naturalGap;
  const scale = Math.min(1, laneCapacity / Math.max(1, totalHeight));
  const fontSize = naturalFontSize * scale;
  const lineHeight = naturalLineHeight * scale;
  const padding = naturalPadding * scale;
  const gap = naturalGap * scale;
  const shownHeights = blockHeights.map((height) => height * scale);
  const shownTotal =
    shownHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, active.length - 1) * gap;
  const bottom = h - Math.max(unit * 0.055, 22);
  const laneTop = bottom - laneCapacity;
  ctx.beginPath();
  ctx.rect(0, laneTop, w, laneCapacity);
  ctx.clip();
  ctx.font = `700 ${fontSize}px ui-sans-serif,system-ui,sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "#000";
  ctx.shadowBlur = fontSize * 0.22;

  let top = bottom - shownTotal;
  for (let cueIndex = 0; cueIndex < active.length; cueIndex += 1) {
    const blockHeight = shownHeights[cueIndex];
    ctx.fillStyle = "rgba(5,8,18,.76)";
    ctx.beginPath();
    ctx.roundRect(w * 0.07, top, w * 0.86, blockHeight, fontSize * 0.38);
    ctx.fill();
    ctx.fillStyle = "#fff";
    lines[cueIndex].forEach((line, lineIndex) => {
      ctx.fillText(line, w / 2, top + padding * 0.76 + (lineIndex + 0.5) * lineHeight);
    });
    top += blockHeight + gap;
  }
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
  let styleActivity = activity;
  const styleAudio = {
    energy,
    impact: ringPulse,
    bands,
    bandLayers: extras.sound ? state.ringBands : [bands],
    ringMix: extras.sound ? state.ringMix : 1,
  };
  if (settings.mode === "radial" || settings.mode === "terrain") {
    let current = styleBandBuffers.get(ctx);
    if (!current) {
      current = new Float32Array(DSP_BAND_COUNT);
      styleBandBuffers.set(ctx, current);
    }
    const measured = extras.history?.read(time, current, settings.quietThreshold);
    if (!measured)
      for (let i = 0; i < current.length; i++)
        current[i] = sampleBands(bands, i / (current.length - 1));
    const bass = bandEnergy(current, 0, 0.27, settings.sensitivity * settings.bassBoost);
    const mid = bandEnergy(current, 0.27, 0.7, settings.sensitivity);
    const treble = bandEnergy(current, 0.7, 1, settings.sensitivity);
    styleActivity = Math.max(bass, mid, treble);
    styleAudio.bands = [current];
  }
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
  ctx.globalAlpha = 0.7 + styleActivity * 0.3;
  if (settings.mode === "ring") {
    ctx.translate(w / 2, h / 2);
    ctx.scale(settings.visualScale, settings.visualScale);
    ctx.translate(-w / 2, -h / 2);
  }
  drawVisualStyle(ctx, {
    width: w,
    height: h,
    time,
    sampleRate,
    settings,
    reducedMotion: !!extras.reducedMotion,
    fittedLogo: !!logo && settings.logoAutoFit[settings.mode],
    captionHeight,
    audio: styleAudio,
    history: extras.history,
  });
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
