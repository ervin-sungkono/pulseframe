import type { PixelBounds } from "./composition";
import type { VisualSettings } from "./visual-settings-model";

const fonts = {
  sans: "ui-sans-serif,system-ui,sans-serif",
  serif: "Georgia,serif",
  mono: "ui-monospace,Menlo,monospace",
};
const rgba = (hex: string, alpha: number) => {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${v >>> 16},${(v >>> 8) & 255},${v & 255},${alpha})`;
};
const stamp = (time: number) =>
  `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`;
const fit = (ctx: CanvasRenderingContext2D, text: string, width: number) => {
  if (ctx.measureText(text).width <= width) return text;
  let value = text;
  while (value && ctx.measureText(value + "…").width > width) value = value.slice(0, -1);
  return value ? value + "…" : "";
};

export function trackOverlayLayout(
  w: number,
  h: number,
  s: VisualSettings,
  captionLane = 0,
): {
  title: boolean;
  artist: boolean;
  compact: boolean;
  visible: boolean;
  unit: number;
  edge: number;
  pad: number;
  titleSize: number;
  secondarySize: number;
  contentH: number;
  y: number;
  maxWidth: number;
  topSpace: number;
  bottomSpace: number;
  bounds: PixelBounds;
} {
  const unit = Math.min(w, h),
    edge = Math.max(22, unit * 0.055),
    pad = Math.max(10, unit * 0.018);
  const titleSize = Math.max(21, Math.round(unit * 0.037 * s.infoSize)),
    secondarySize = Math.max(14, Math.round(unit * 0.02 * s.infoSize));
  const title = s.showTrackInfo && !!s.trackTitle.trim(),
    artist = s.showTrackInfo && !!s.trackArtist.trim();
  const compact = s.mode === "spectrum" && s.infoPosition === "bottom" && captionLane > 0;
  const contentH = compact
    ? (title ? titleSize : secondarySize) * 1.2
    : (title ? titleSize * 1.35 : 0) +
      (artist ? secondarySize * 1.55 : 0) +
      (s.showTimer ? secondarySize * 1.7 : 0);
  const visible = title || artist || s.showTimer;
  const y =
    s.infoPosition === "center"
      ? (h - contentH) / 2
      : s.infoPosition === "top"
        ? edge + unit * 0.055
        : h - edge - contentH - (captionLane ? captionLane + unit * 0.025 : unit * 0.025);
  const maxWidth = Math.max(
    1,
    compact ? w - edge * 2 - pad * 2 : Math.min(w - edge * 2 - pad * 2, unit * 0.86),
  );
  const width = maxWidth + pad * 2;
  const left =
    s.infoAlign === "center" ? (w - width) / 2 : s.infoAlign === "right" ? w - edge - width : edge;
  const top = Math.max(0, y - pad);
  return {
    bounds: {
      x: left,
      y: top,
      width,
      height: Math.max(pad * 2, contentH + pad * 2),
    },
    title,
    artist,
    compact,
    visible,
    unit,
    edge,
    pad,
    titleSize,
    secondarySize,
    contentH,
    y: y,
    maxWidth,
    topSpace: visible && s.infoPosition === "top" ? y + contentH + pad : 0,
    bottomSpace: visible && s.infoPosition === "bottom" ? h - y + pad : 0,
  };
}

export function drawTrackOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: VisualSettings,
  time: number,
  duration: number,
  captionLane = 0,
  override?: PixelBounds,
) {
  const layout = trackOverlayLayout(w, h, s, captionLane);
  if (!layout.visible) return;
  const scale = override
    ? Math.max(
        0.5,
        Math.min(2, override.width / layout.bounds.width, override.height / layout.bounds.height),
      )
    : 1;
  const bounds = override ?? layout.bounds;
  const {
    title,
    artist,
    compact,
    unit,
    edge,
    pad: basePad,
    titleSize: baseTitleSize,
    secondarySize: baseSecondarySize,
    contentH: baseContentH,
    y: legacyY,
    maxWidth: legacyMaxWidth,
  } = layout;
  const pad = override
    ? Math.min(basePad * scale, bounds.width * 0.08, bounds.height * 0.12)
    : basePad;
  const titleSize = baseTitleSize * scale;
  const secondarySize = baseSecondarySize * scale;
  const contentH = override
    ? Math.min(baseContentH * scale, Math.max(1, bounds.height - pad * 2))
    : baseContentH;
  const y = override ? bounds.y + pad : legacyY;
  const maxWidth = override ? Math.max(1, bounds.width - pad * 2) : legacyMaxWidth;
  const family = fonts[s.infoFont ?? "sans"],
    weight = s.infoWeight ?? 700;
  const primary = s.infoColor ?? "#ffffff",
    secondary = s.infoSecondaryColor ?? "#c8d0e5";
  const rows = [
    ...(title
      ? [{ text: s.trackTitle.trim(), size: titleSize, color: primary, height: titleSize * 1.35 }]
      : []),
    ...(artist
      ? [
          {
            text: s.trackArtist.trim(),
            size: secondarySize,
            color: secondary,
            height: secondarySize * 1.55,
          },
        ]
      : []),
    ...(s.showTimer
      ? [
          {
            text: `${stamp(time)} / ${stamp(duration)}`,
            size: secondarySize,
            color: secondary,
            height: secondarySize * 1.7,
          },
        ]
      : []),
  ];
  ctx.save();
  ctx.globalAlpha *= (s.infoOpacity ?? 100) / 100;
  let rowWidth = 0;
  for (const row of rows) {
    ctx.font = `${weight} ${row.size}px ${family}`;
    row.text = fit(ctx, row.text, maxWidth);
    rowWidth = Math.max(rowWidth, ctx.measureText(row.text).width);
  }
  const compactSize = title ? titleSize : secondarySize;
  if (compact) {
    ctx.font = `${weight} ${compactSize}px ${family}`;
    const share = maxWidth / Math.max(1, rows.length) - ctx.measureText(" · ").width;
    for (const row of rows) row.text = fit(ctx, row.text, share);
    rowWidth = Math.min(
      maxWidth,
      rows.reduce((sum, row) => sum + ctx.measureText(row.text).width, 0) +
        ctx.measureText(" · ").width * (rows.length - 1),
    );
  }
  const boxW = Math.min(override ? bounds.width : w - edge * 2, rowWidth + pad * 2),
    boxH = contentH + pad * 2;
  const left = override
    ? s.infoAlign === "center"
      ? bounds.x + (bounds.width - boxW) / 2
      : s.infoAlign === "right"
        ? bounds.x + bounds.width - boxW
        : bounds.x
    : s.infoAlign === "center"
      ? (w - boxW) / 2
      : s.infoAlign === "right"
        ? w - edge - boxW
        : edge;
  const top = override ? bounds.y : Math.max(0, legacyY - basePad);
  const background = s.infoBackground ?? "#040816";
  const opacity = (s.infoBackgroundOpacity ?? 55) / 100;
  const style = s.infoStyle ?? "shade";
  if (style === "shade") {
    const shade = ctx.createLinearGradient(0, top - pad, 0, top + boxH + pad);
    shade.addColorStop(0, rgba(background, 0));
    shade.addColorStop(0.45, rgba(background, opacity));
    shade.addColorStop(1, rgba(background, 0));
    ctx.fillStyle = shade;
    ctx.fillRect(0, top - pad, w, boxH + pad * 2);
  } else if (style === "card" || style === "accent") {
    ctx.fillStyle = rgba(background, opacity);
    ctx.beginPath();
    ctx.roundRect(
      left,
      top,
      boxW,
      boxH,
      style === "card" ? Math.min(boxH / 2, ((s.infoRadius ?? 16) * unit) / 720) : pad * 0.5,
    );
    ctx.fill();
    if (style === "accent") {
      ctx.fillStyle = s.primary;
      ctx.beginPath();
      ctx.roundRect(left, top + pad * 0.5, Math.max(3, unit * 0.004), boxH - pad, pad * 0.15);
      ctx.fill();
    }
  }
  const textX = override
    ? s.infoAlign === "center"
      ? bounds.x + bounds.width / 2
      : s.infoAlign === "right"
        ? bounds.x + bounds.width - pad
        : bounds.x + pad
    : s.infoAlign === "center"
      ? w / 2
      : s.infoAlign === "right"
        ? w - edge - pad
        : edge + pad;
  ctx.textAlign = s.infoAlign;
  ctx.textBaseline = "top";
  ctx.shadowColor = "#020513";
  ctx.shadowBlur = unit * 0.012 * scale;
  if (compact) {
    ctx.textAlign = "left";
    ctx.font = `${weight} ${compactSize}px ${family}`;
    let x = override
      ? s.infoAlign === "center"
        ? bounds.x + (bounds.width - rowWidth) / 2
        : s.infoAlign === "right"
          ? bounds.x + bounds.width - pad - rowWidth
          : bounds.x + pad
      : s.infoAlign === "center"
        ? (w - rowWidth) / 2
        : s.infoAlign === "right"
          ? w - edge - pad - rowWidth
          : edge + pad;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      ctx.fillStyle = row.color;
      ctx.fillText(row.text, x, y);
      x += ctx.measureText(row.text).width;
      if (i < rows.length - 1) {
        ctx.fillStyle = secondary;
        ctx.fillText(" · ", x, y);
        x += ctx.measureText(" · ").width;
      }
    }
  } else {
    let rowY = y;
    for (const row of rows) {
      ctx.font = `${row === rows[0] && title ? weight : 500} ${row.size}px ${family}`;
      ctx.fillStyle = row.color;
      ctx.fillText(row.text, textX, rowY);
      rowY += row.height;
    }
  }
  ctx.restore();
}
