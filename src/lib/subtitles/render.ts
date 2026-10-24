import {
  activeSubtitles,
  validateSubtitleWords,
  type SubtitleCue,
  type SubtitleWord,
} from "./model";

type SubtitleLine = {
  start: number;
  end: number;
  visibleEnd: number;
  text: string;
};

type SubtitleLayout = { text: string; lines: SubtitleLine[]; words?: SubtitleWord[] };

const subtitleLayouts = new WeakMap<SubtitleCue, Map<string, SubtitleLayout>>();
const FONT_FAMILY = "ui-sans-serif,system-ui,sans-serif";

export type SubtitleAnimation = "static" | "fade" | "pop" | "highlight" | "karaoke";
export type SubtitleRenderStyle = {
  animation: SubtitleAnimation;
  color: string;
  highlightColor: string;
  fontSize: number;
  position: number;
  background: boolean;
};

export const DEFAULT_SUBTITLE_RENDER_STYLE: SubtitleRenderStyle = {
  animation: "static",
  color: "#ffffff",
  highlightColor: "#b9a2ff",
  fontSize: 0.046,
  position: 0.945,
  background: true,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedTextAndWords(cue: SubtitleCue) {
  const text = cue.text.replace(/\s+/gu, " ").trim();
  const words = validateSubtitleWords(cue.text, cue.words, cue);
  if (!words) return { text };
  const mapOffset = (offset: number) =>
    cue.text.slice(0, offset).replace(/\s+/gu, " ").trimStart().length;
  const normalizedWords = words.map((word) => ({
    ...word,
    textStart: mapOffset(word.textStart),
    textEnd: mapOffset(word.textEnd),
  }));
  return validateSubtitleWords(text, normalizedWords, cue)
    ? { text, words: normalizedWords }
    : { text };
}

function fitLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  start: number,
  maxWidth: number,
): SubtitleLine {
  if (ctx.measureText(text).width <= maxWidth)
    return { start, end: start + text.length, visibleEnd: start + text.length, text };
  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (ctx.measureText(chars.slice(0, middle).join("") + "…").width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  const visible = chars.slice(0, low).join("").trimEnd();
  return {
    start,
    end: start + text.length,
    visibleEnd: start + visible.length,
    text: visible + "…",
  };
}

function buildLayout(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): SubtitleLayout {
  if (!text) return { text, lines: [] };
  const tokens = [...text.matchAll(/\S+/gu)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const rawLines: Array<{ start: number; end: number }> = [];
  let lineStart = tokens[0]?.start ?? 0;
  let lineEnd = lineStart;
  let lineText = "";
  for (const token of tokens) {
    const candidate = lineText ? lineText + " " + token.text : token.text;
    if (lineText && ctx.measureText(candidate).width > maxWidth && rawLines.length < 2) {
      rawLines.push({ start: lineStart, end: lineEnd });
      lineStart = token.start;
      lineEnd = token.end;
      lineText = token.text;
    } else {
      lineEnd = token.end;
      lineText = candidate;
    }
  }
  if (lineText) rawLines.push({ start: lineStart, end: lineEnd });
  const lines = rawLines
    .slice(0, 3)
    .map(({ start, end }) => fitLine(ctx, text.slice(start, end), start, maxWidth));
  return { text, lines };
}

function layoutForCue(
  ctx: CanvasRenderingContext2D,
  cue: SubtitleCue,
  font: string,
  maxWidth: number,
) {
  const key = `${cue.text}\u0000${font}\u0000${maxWidth}`;
  let layouts = subtitleLayouts.get(cue);
  if (!layouts) {
    layouts = new Map();
    subtitleLayouts.set(cue, layouts);
  }
  const cached = layouts.get(key);
  if (cached) {
    layouts.delete(key);
    layouts.set(key, cached);
    return cached;
  }
  const normalized = normalizedTextAndWords(cue);
  const layout = { ...buildLayout(ctx, normalized.text, maxWidth), words: normalized.words };
  layouts.set(key, layout);
  while (layouts.size > 8) {
    const oldest = layouts.keys().next().value;
    if (oldest === undefined) break;
    layouts.delete(oldest);
  }
  return layout;
}

function drawHighlightedLine(
  ctx: CanvasRenderingContext2D,
  line: SubtitleLine,
  centerX: number,
  y: number,
  lineHeight: number,
  highlightColor: string,
  progress: number,
) {
  if (progress <= 0) return;
  const width = ctx.measureText(line.text).width;
  const clipWidth = width * clamp(progress, 0, 1);
  if (clipWidth <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(centerX - width / 2, y - lineHeight / 2, clipWidth, lineHeight);
  ctx.clip();
  ctx.fillStyle = highlightColor;
  ctx.fillText(line.text, centerX, y);
  ctx.restore();
}

function drawHighlightedWords(
  ctx: CanvasRenderingContext2D,
  layout: SubtitleLayout,
  words: SubtitleWord[],
  centerX: number,
  y: number,
  lineHeight: number,
  highlightColor: string,
  time: number,
  karaoke: boolean,
) {
  for (const line of layout.lines) {
    const lineWidth = ctx.measureText(line.text).width;
    for (const word of words) {
      const start = Math.max(line.start, word.textStart);
      const end = Math.min(line.visibleEnd, word.textEnd);
      if (end <= start) continue;
      let progress = 0;
      if (karaoke) {
        if (time >= word.end) progress = 1;
        else if (time > word.start) progress = (time - word.start) / (word.end - word.start);
      } else if (time >= word.start && time < word.end) progress = 1;
      if (progress <= 0) continue;

      const lineStartX = centerX - lineWidth / 2;
      const prefix = layout.text.slice(line.start, start);
      const selected = layout.text.slice(start, end);
      const selectedWidth = ctx.measureText(selected).width * clamp(progress, 0, 1);
      if (selectedWidth <= 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        lineStartX + ctx.measureText(prefix).width,
        y - lineHeight / 2,
        selectedWidth,
        lineHeight,
      );
      ctx.clip();
      ctx.fillStyle = highlightColor;
      ctx.fillText(line.text, centerX, y);
      ctx.restore();
    }
  }
}

/** Draw timed subtitle cues with source-time animation and optional word highlighting. */
export function drawAnimatedSubtitles(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cues: SubtitleCue[],
  time: number,
  style: SubtitleRenderStyle,
  reducedMotion: boolean,
) {
  const active = activeSubtitles(cues, time);
  if (!active.length || w <= 0 || h <= 0) return;

  const unit = Math.min(w, h);
  const naturalFontSize = unit * clamp(style.fontSize, 0.02, 0.12);
  const font = `700 ${naturalFontSize}px ${FONT_FAMILY}`;
  const maxWidth = w * 0.84;
  ctx.save();
  ctx.font = font;
  const layouts = active.map((cue) => layoutForCue(ctx, cue, font, maxWidth));
  const naturalLineHeight = naturalFontSize * 1.3;
  const naturalPadding = naturalFontSize * 0.55;
  const naturalGap = naturalFontSize * 0.16;
  const blockHeights = layouts.map(
    (layout) => layout.lines.length * naturalLineHeight + naturalPadding,
  );
  const totalHeight =
    blockHeights.reduce((sum, height) => sum + height, 0) +
    Math.max(0, active.length - 1) * naturalGap;
  const scale = Math.min(1, (h * 0.42) / Math.max(1, totalHeight));
  const fontSize = naturalFontSize * scale;
  const lineHeight = naturalLineHeight * scale;
  const padding = naturalPadding * scale;
  const gap = naturalGap * scale;
  const shownHeights = blockHeights.map((height) => height * scale);
  const shownTotal =
    shownHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, active.length - 1) * gap;
  const bottom = clamp(style.position * h, shownTotal, h - unit * 0.02);
  const topStart = bottom - shownTotal;
  const animation = reducedMotion ? "static" : style.animation;

  ctx.font = `700 ${fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,.92)";
  ctx.shadowBlur = fontSize * 0.22;
  let top = topStart;
  for (let cueIndex = 0; cueIndex < active.length; cueIndex += 1) {
    const cue = active[cueIndex];
    const layout = layouts[cueIndex];
    const blockHeight = shownHeights[cueIndex];
    const cueProgress = clamp((time - cue.start) / (cue.end - cue.start), 0, 1);
    const fadeAlpha = animation === "fade" ? clamp((time - cue.start) / 0.35, 0, 1) : 1;
    const popProgress = clamp(cueProgress / 0.14, 0, 1);
    const popScale = animation === "pop" ? 0.88 + 0.12 * (1 - (1 - popProgress) ** 3) : 1;
    const centerX = w / 2;
    const centerY = top + blockHeight / 2;

    ctx.save();
    ctx.globalAlpha *= fadeAlpha;
    if (popScale !== 1) {
      ctx.translate(centerX, centerY);
      ctx.scale(popScale, popScale);
      ctx.translate(-centerX, -centerY);
    }
    if (style.background) {
      ctx.fillStyle = "rgba(5,8,18,.76)";
      ctx.beginPath();
      ctx.roundRect(w * 0.07, top, w * 0.86, blockHeight, fontSize * 0.38);
      ctx.fill();
    }
    ctx.fillStyle = style.color;
    const lineYs = layout.lines.map(
      (_line, lineIndex) => top + padding * 0.76 + (lineIndex + 0.5) * lineHeight,
    );
    layout.lines.forEach((line, lineIndex) => ctx.fillText(line.text, centerX, lineYs[lineIndex]));

    if (animation === "highlight" || animation === "karaoke") {
      const words = layout.words;
      if (words?.length) {
        for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex += 1) {
          drawHighlightedWords(
            ctx,
            { ...layout, lines: [layout.lines[lineIndex]] },
            words,
            centerX,
            lineYs[lineIndex],
            lineHeight,
            style.highlightColor,
            time,
            animation === "karaoke",
          );
        }
      } else {
        layout.lines.forEach((line, lineIndex) =>
          drawHighlightedLine(
            ctx,
            line,
            centerX,
            lineYs[lineIndex],
            lineHeight,
            style.highlightColor,
            animation === "highlight" ? 1 : cueProgress,
          ),
        );
      }
    }
    ctx.restore();
    top += blockHeight + gap;
  }
  ctx.restore();
}
