import type { CompositionImages, CreativeElement } from "./model";
import { applyFrame } from "./geometry";
import { formatTimestamp } from "../time";
import type { VisualSettings } from "../visual/visual-settings-model";

export function drawCreativeElements(
  ctx: CanvasRenderingContext2D,
  elements: readonly CreativeElement[],
  images: CompositionImages | undefined,
  settings: VisualSettings,
  time: number,
) {
  for (const item of elements) {
    if (!item.visible || item.opacity <= 0) continue;
    ctx.save();
    const { width, height } = applyFrame(ctx, item.transform, ctx.canvas.width, ctx.canvas.height);
    ctx.globalAlpha = item.opacity;
    if (item.type === "shape") {
      ctx.fillStyle = item.color;
      ctx.beginPath();
      if (item.shape === "ellipse")
        ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      else ctx.roundRect(0, 0, width, height, (Math.min(width, height) * item.roundness) / 2);
      ctx.fill();
    } else if (item.type === "image") {
      const image = images?.get(item.assetId);
      if (image) {
        const iw = image.width,
          ih = image.height;
        const scale =
          item.fit === "cover"
            ? Math.max(width / iw, height / ih)
            : Math.min(width / iw, height / ih);
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();
        ctx.drawImage(
          image,
          (width - iw * scale) / 2,
          (height - ih * scale) / 2,
          iw * scale,
          ih * scale,
        );
      }
    } else {
      const text =
        item.binding === "title"
          ? settings.trackTitle
          : item.binding === "artist"
            ? settings.trackArtist
            : item.binding === "timer"
              ? formatTimestamp(time)
              : item.text;
      const font =
        item.font === "serif"
          ? "Georgia,serif"
          : item.font === "mono"
            ? "ui-monospace,monospace"
            : "ui-sans-serif,system-ui,sans-serif";
      const fontSize = Math.max(8, Math.min(ctx.canvas.width, ctx.canvas.height) * item.fontSize);
      ctx.font = `${item.weight} ${fontSize}px ${font}`;
      ctx.fillStyle = item.color;
      ctx.textAlign = item.align;
      ctx.textBaseline = "middle";
      const lines = text.split("\n"),
        lineHeight = fontSize * 1.25;
      const x = item.align === "left" ? 0 : item.align === "right" ? width : width / 2;
      lines.forEach((line, index) =>
        ctx.fillText(line, x, height / 2 + (index - (lines.length - 1) / 2) * lineHeight, width),
      );
    }
    ctx.restore();
  }
}
