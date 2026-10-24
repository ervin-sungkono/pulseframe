import type { FrameTransform } from "./model";
export function framePoint(
  frame: FrameTransform,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const angle = (-frame.rotation * Math.PI) / 180,
    dx = x - frame.x * width,
    dy = y - frame.y * height;
  return {
    x: (dx * Math.cos(angle) - dy * Math.sin(angle)) / (frame.width * width) + 0.5,
    y: (dx * Math.sin(angle) + dy * Math.cos(angle)) / (frame.height * height) + 0.5,
  };
}
export function hitFrame(
  frame: FrameTransform,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const local = framePoint(frame, x, y, width, height);
  return local.x >= 0 && local.x <= 1 && local.y >= 0 && local.y <= 1;
}
export function applyFrame(
  ctx: CanvasRenderingContext2D,
  frame: FrameTransform,
  width: number,
  height: number,
) {
  const w = frame.width * width,
    h = frame.height * height;
  ctx.translate(frame.x * width, frame.y * height);
  ctx.rotate((frame.rotation * Math.PI) / 180);
  ctx.translate(-w / 2, -h / 2);
  return { width: w, height: h };
}
export function boundedTransform(frame: FrameTransform): FrameTransform {
  const bound = (n: number, min: number, max: number, fallback: number) =>
    Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  return {
    x: bound(frame.x, 0, 1, 0.5),
    y: bound(frame.y, 0, 1, 0.5),
    width: bound(frame.width, 0.03, 1.5, 1),
    height: bound(frame.height, 0.03, 1.5, 1),
    rotation: bound(frame.rotation, -180, 180, 0),
  };
}
