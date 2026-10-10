export type PaletteColors = {
  primary: string;
  secondary: string;
  background: string;
  infoColor: string;
  infoSecondaryColor: string;
  infoBackground: string;
};
export type ImagePaletteSuggestion = { id: string; label: string; colors: PaletteColors };
export type KeyedPaletteSuggestion = {
  sourceKey: string | number;
  suggestion: ImagePaletteSuggestion;
};

type ColorBin = { r: number; g: number; b: number; weight: number };
const SIDE = 64;

/** Draw a bounded thumbnail, then return up to three deterministic brand palettes. */
export function sampleImagePalette(image: CanvasImageSource): ImagePaletteSuggestion[] {
  const canvas = document.createElement("canvas");
  canvas.width = SIDE;
  canvas.height = SIDE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not prepare a small preview of this image.");
  context.clearRect(0, 0, SIDE, SIDE);
  context.drawImage(image, 0, 0, SIDE, SIDE);
  const data = context.getImageData(0, 0, SIDE, SIDE).data;
  return suggestPalettesFromPixels(data);
}

/** Histogram and contrast suggestions from an RGBA buffer; fully transparent pixels are ignored. */
export function suggestPalettesFromPixels(pixels: ArrayLike<number>): ImagePaletteSuggestion[] {
  if (pixels.length % 4 !== 0) throw new Error("Image pixels must be RGBA values.");
  const histogram = new Map<string, ColorBin>();
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = Number(pixels[index + 3]) / 255;
    if (alpha <= 0) continue;
    const r = clampByte(Number(pixels[index]));
    const g = clampByte(Number(pixels[index + 1]));
    const b = clampByte(Number(pixels[index + 2]));
    // Five high bits per channel collapse near-identical colors without a package dependency.
    const key = `${r >> 3},${g >> 3},${b >> 3}`;
    const bin = histogram.get(key) ?? { r: 0, g: 0, b: 0, weight: 0 };
    bin.r += r * alpha;
    bin.g += g * alpha;
    bin.b += b * alpha;
    bin.weight += alpha;
    histogram.set(key, bin);
  }
  if (!histogram.size) return [];

  const bins = [...histogram.values()]
    .map((bin) => ({
      r: bin.r / bin.weight,
      g: bin.g / bin.weight,
      b: bin.b / bin.weight,
      weight: bin.weight,
    }))
    .sort((a, b) => b.weight - a.weight || colorHex(a).localeCompare(colorHex(b)));
  const merged = mergeNearColors(bins);
  const totalWeight = merged.reduce((sum, color) => sum + color.weight, 0);
  const brightest = [...merged].sort(
    (a, b) => luminance(b) - luminance(a) || colorHex(a).localeCompare(colorHex(b)),
  )[0];
  const darkest = [...merged].sort(
    (a, b) => luminance(a) - luminance(b) || colorHex(a).localeCompare(colorHex(b)),
  )[0];
  const vivid = [...merged].sort(
    (a, b) =>
      chromaScore(b) - chromaScore(a) ||
      b.weight - a.weight ||
      colorHex(a).localeCompare(colorHex(b)),
  );
  const colorful = vivid[0];
  const isMonochrome = vivid.every((color) => saturation(color) < 0.12);
  const distinctAccentColors = isMonochrome
    ? ["#a78bfa", "#55d7ef", "#fb7185"]
    : selectAccents(vivid, darkest);

  const variants = [
    {
      id: "dark",
      label: "Deep background",
      source: darkBackground(darkest),
      accents: distinctAccentColors,
    },
    {
      id: "light",
      label: "Light background",
      source: lightBackground(brightest),
      accents: distinctAccentColors,
    },
    {
      id: "color",
      label: "Image colors",
      source: middleBackground(colorful, totalWeight),
      accents: distinctAccentColors,
    },
  ];
  const suggestions: ImagePaletteSuggestion[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    const background = colorHex(variant.source);
    const first = adjustContrast(variant.accents[0] ?? "#a78bfa", background, 2.2);
    const second = adjustContrast(
      variant.accents.find((color) => color !== variant.accents[0]) ?? "#55d7ef",
      background,
      2.2,
    );
    const foreground = bestForeground(background);
    const secondaryForeground = adjustContrast(
      foreground === "#ffffff" ? "#d3d9e8" : "#3e4657",
      background,
      4.5,
    );
    const colors: PaletteColors = {
      primary: first,
      secondary: second,
      background,
      infoColor: foreground,
      infoSecondaryColor: secondaryForeground,
      infoBackground: background,
    };
    const key = Object.values(colors).join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({ id: variant.id, label: variant.label, colors });
  }
  return suggestions.slice(0, 3);
}

export function keyedPaletteResult(
  sourceKey: string | number,
  suggestion: ImagePaletteSuggestion,
): KeyedPaletteSuggestion {
  return { sourceKey, suggestion };
}

export function isPaletteResultCurrent(
  result: KeyedPaletteSuggestion | null,
  sourceKey: string | number,
): result is KeyedPaletteSuggestion {
  return result !== null && result.sourceKey === sourceKey;
}

export function colorContrastRatio(first: string, second: string): number {
  const a = parseHex(first);
  const b = parseHex(second);
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

function selectAccents(colors: ColorBin[], background: ColorBin): string[] {
  const candidates = colors
    .filter((color) => distance(color, background) > 42)
    .sort(
      (a, b) =>
        chromaScore(b) - chromaScore(a) ||
        b.weight - a.weight ||
        colorHex(a).localeCompare(colorHex(b)),
    );
  const selected: string[] = [];
  for (const color of candidates) {
    const hex = colorHex(color);
    if (!selected.some((item) => distance(parseHex(item), color) < 58)) selected.push(hex);
    if (selected.length === 3) break;
  }
  return selected.length ? selected : ["#a78bfa", "#55d7ef", "#fb7185"];
}

function mergeNearColors(source: ColorBin[]): ColorBin[] {
  const merged: ColorBin[] = [];
  for (const color of source) {
    const existing = merged.find((item) => distance(item, color) <= 22);
    if (!existing) {
      merged.push({ ...color });
      continue;
    }
    const weight = existing.weight + color.weight;
    existing.r = (existing.r * existing.weight + color.r * color.weight) / weight;
    existing.g = (existing.g * existing.weight + color.g * color.weight) / weight;
    existing.b = (existing.b * existing.weight + color.b * color.weight) / weight;
    existing.weight = weight;
  }
  return merged;
}

function darkBackground(color: ColorBin): ColorBin {
  return luminance(color) < 0.28 ? color : mix(color, { r: 8, g: 11, b: 20, weight: 1 }, 0.84);
}
function lightBackground(color: ColorBin): ColorBin {
  return luminance(color) > 0.72 ? color : mix(color, { r: 246, g: 247, b: 250, weight: 1 }, 0.84);
}
function middleBackground(color: ColorBin, total: number): ColorBin {
  if (luminance(color) < 0.18) return mix(color, { r: 28, g: 32, b: 48, weight: 1 }, 0.34);
  if (luminance(color) > 0.83) return mix(color, { r: 34, g: 35, b: 48, weight: 1 }, 0.82);
  return { ...color, weight: Math.min(color.weight, total) };
}
function mix(first: ColorBin, second: ColorBin, amount: number): ColorBin {
  return {
    r: first.r * (1 - amount) + second.r * amount,
    g: first.g * (1 - amount) + second.g * amount,
    b: first.b * (1 - amount) + second.b * amount,
    weight: first.weight,
  };
}
function adjustContrast(hex: string, background: string, target: number): string {
  let color = parseHex(hex);
  if (colorContrastRatio(colorHex(color), background) >= target) return colorHex(color);
  const toward =
    luminance(parseHex(background)) < 0.43 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  for (let step = 1; step <= 10; step += 1) {
    color = mix(color, { ...toward, weight: 1 }, 0.1);
    if (colorContrastRatio(colorHex(color), background) >= target) return colorHex(color);
  }
  return colorContrastRatio("#ffffff", background) >= colorContrastRatio("#000000", background)
    ? "#ffffff"
    : "#000000";
}
function bestForeground(background: string): string {
  return colorContrastRatio("#ffffff", background) >= colorContrastRatio("#111827", background)
    ? "#ffffff"
    : "#111827";
}
function chromaScore(color: ColorBin): number {
  return saturation(color) * (0.5 + Math.min(1, color.weight / 100));
}
function saturation(color: ColorBin): number {
  const maximum = Math.max(color.r, color.g, color.b);
  const minimum = Math.min(color.r, color.g, color.b);
  return maximum === 0 ? 0 : (maximum - minimum) / maximum;
}
function luminance(color: Pick<ColorBin, "r" | "g" | "b">): number {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return linear(color.r) * 0.2126 + linear(color.g) * 0.7152 + linear(color.b) * 0.0722;
}
function distance(
  first: Pick<ColorBin, "r" | "g" | "b">,
  second: Pick<ColorBin, "r" | "g" | "b">,
): number {
  return Math.hypot(first.r - second.r, first.g - second.g, first.b - second.b);
}
function parseHex(hex: string): ColorBin {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
    weight: 1,
  };
}
function colorHex(color: Pick<ColorBin, "r" | "g" | "b">): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => Math.round(clampByte(channel)).toString(16).padStart(2, "0"))
    .join("")}`;
}
function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Number.isFinite(value) ? value : 0));
}
