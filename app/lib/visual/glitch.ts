const clamp = (value: number) => Math.max(0, Math.min(1, value));
const noise = (seed: number) => {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
};
/** Audio-time bursts reproduce in preview, seeks and selected-range exports. */
export function glitchPulse(
  time: number,
  energy: number,
  bass: number,
  activity: number,
  strength: number,
) {
  if (!Number.isFinite(time) || time < 0 || activity <= 0.08 || energy <= 0.15 || strength <= 0)
    return 0;
  const slot = Math.floor(time / 0.24),
    local = time - slot * 0.24;
  if (local >= 0.075 || noise(slot + 1) < 0.72) return 0;
  return clamp(strength) * clamp(activity) * Math.max(energy * 0.6, bass) * (1 - local / 0.075);
}
type CanvasLayer = HTMLCanvasElement | OffscreenCanvas;
const snapshots = new WeakMap<CanvasLayer, CanvasLayer>();
export function drawGlitch(
  ctx: CanvasRenderingContext2D,
  time: number,
  energy: number,
  bass: number,
  activity: number,
  strength: number,
) {
  const pulse = glitchPulse(time, energy, bass, activity, strength);
  if (!pulse) return;
  const { width, height } = ctx.canvas;
  let snapshot = snapshots.get(ctx.canvas);
  if (!snapshot) {
    if (typeof OffscreenCanvas !== "undefined") snapshot = new OffscreenCanvas(width, height);
    else if ("ownerDocument" in ctx.canvas)
      snapshot = ctx.canvas.ownerDocument.createElement("canvas");
    else return;
    snapshots.set(ctx.canvas, snapshot);
  }
  if (snapshot.width !== width || snapshot.height !== height) {
    snapshot.width = width;
    snapshot.height = height;
  }
  const copy = snapshot.getContext("2d") as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!copy) return;
  copy.clearRect(0, 0, width, height);
  copy.drawImage(ctx.canvas, 0, 0);
  const slot = Math.floor(time / 0.24),
    unit = Math.min(width, height);
  ctx.save();
  for (let i = 0; i < 3; i++) {
    const seed = slot * 7 + i,
      bandHeight = Math.max(2, unit * (0.007 + noise(seed + 3) * 0.018));
    const y = Math.floor(height * (0.22 + noise(seed + 8) * 0.56));
    const shift = (noise(seed + 13) < 0.5 ? -1 : 1) * unit * (0.008 + pulse * 0.045);
    ctx.globalAlpha = 0.45 + pulse * 0.4;
    ctx.drawImage(snapshot, 0, y, width, bandHeight, shift, y, width, bandHeight);
    ctx.globalAlpha = pulse * 0.3;
    ctx.globalCompositeOperation = "screen";
    ctx.drawImage(snapshot, 0, y, width, bandHeight, -shift * 0.5, y, width, bandHeight);
    ctx.fillStyle = i % 2 ? "#ff4b95" : "#54e9ff";
    ctx.fillRect(width * 0.15, y, width * 0.7, Math.max(1, bandHeight * 0.12));
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.restore();
}
