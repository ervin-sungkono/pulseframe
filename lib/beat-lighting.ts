import type { BeatLighting } from "./visual-settings-model";
type LightingSettings = { primary: string; secondary: string; sensitivity: number; beatLighting: BeatLighting; beatLightingIntensity: number };
const rgba = (hex: string, alpha: number) => {
  const rgb = parseInt(hex.slice(1), 16);
  return `rgba(${rgb >>> 16},${(rgb >>> 8) & 255},${rgb & 255},${alpha})`;
};

/** Source-time animation is shared by playback and accelerated video export. */
export function drawBeatLighting(ctx: CanvasRenderingContext2D, w: number, h: number, s: LightingSettings, pulse: number, time: number, reducedMotion = false) {
  if (reducedMotion) return;
  const strength = Math.max(0, Math.min(1, (pulse * s.sensitivity - .035) / .7)) * Math.max(0, Math.min(1, s.beatLightingIntensity / 100));
  if (!strength) return;
  const short = Math.min(w, h);
  ctx.save(); ctx.globalCompositeOperation = "screen";
  if (s.beatLighting === "edges") {
    for (let i = 0; i < 4; i++) {
      const x = i % 2 ? w : 0, y = i < 2 ? 0 : h, color = i % 2 ? s.primary : s.secondary;
      const light = ctx.createRadialGradient(x, y, 0, x, y, short * (.5 + strength * .16));
      light.addColorStop(0, rgba(color, strength * .3)); light.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = light; ctx.fillRect(0, 0, w, h);
    }
  } else if (s.beatLighting === "beams") {
    for (let i = 0; i < 4; i++) {
      const x = w * (i < 2 ? .12 : .88), y = i % 2 ? h : 0;
      const angle = Math.atan2(h / 2 - y, w / 2 - x) + Math.sin(time * .32 + i * 1.8) * .12;
      const radius = Math.hypot(w, h), spread = .08 + strength * .06;
      const color = i % 2 ? s.secondary : s.primary;
      const light = ctx.createRadialGradient(x, y, 0, x, y, radius);
      light.addColorStop(0, rgba(color, strength * .2)); light.addColorStop(.55, rgba(color, strength * .08)); light.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = light; ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, radius, angle - spread, angle + spread); ctx.closePath(); ctx.fill();
    }
  } else if (s.beatLighting === "aura") {
    const light = ctx.createRadialGradient(w / 2, h / 2, short * .12, w / 2, h / 2, short * (.6 + strength * .12));
    light.addColorStop(0, rgba(s.secondary, 0)); light.addColorStop(.35, rgba(s.secondary, strength * .12));
    light.addColorStop(.65, rgba(s.primary, strength * .18)); light.addColorStop(1, rgba(s.primary, 0));
    ctx.fillStyle = light; ctx.fillRect(0, 0, w, h);
  } else {
    const radius = Math.hypot(w, h) * .6;
    ctx.translate(w / 2, h / 2); ctx.rotate(time * .055);
    for (let i = 0; i < 10; i++) {
      const angle = i * Math.PI / 5, spread = .035 + strength * .035;
      const color = i % 2 ? s.primary : s.secondary;
      const light = ctx.createRadialGradient(0, 0, short * .06, 0, 0, radius);
      light.addColorStop(0, rgba(color, 0)); light.addColorStop(.4, rgba(color, strength * .13)); light.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = light; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, radius, angle - spread, angle + spread); ctx.closePath(); ctx.fill();
    }
  }
  ctx.restore();
}
