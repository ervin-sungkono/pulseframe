import { z } from "zod";

export const COMPOSITION_ASPECTS = ["landscape", "portrait", "square"] as const;
export type CompositionAspect = (typeof COMPOSITION_ASPECTS)[number];

export const COMPOSITION_ELEMENTS = [
  "background",
  "artwork",
  "logo",
  "trackInfo",
  "promo",
  "captions",
] as const;
export type CompositionElement = (typeof COMPOSITION_ELEMENTS)[number];

export type CompositionBounds = { x: number; y: number; width: number; height: number };
export type PixelBounds = { x: number; y: number; width: number; height: number };

const normalizedBoundsSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().min(0.025).max(1),
    height: z.number().finite().min(0.025).max(1),
  })
  .superRefine((bounds, context) => {
    if (bounds.x + bounds.width > 1.000001)
      context.addIssue({ code: "custom", path: ["width"], message: "Bounds exceed the canvas." });
    if (bounds.y + bounds.height > 1.000001)
      context.addIssue({ code: "custom", path: ["height"], message: "Bounds exceed the canvas." });
  });

const layoutSchema = z.object({
  background: normalizedBoundsSchema.optional(),
  artwork: normalizedBoundsSchema.optional(),
  logo: normalizedBoundsSchema.optional(),
  trackInfo: normalizedBoundsSchema.optional(),
  promo: normalizedBoundsSchema.optional(),
  captions: normalizedBoundsSchema.optional(),
});

export const compositionSchema = z.object({
  layouts: z
    .object({
      base: layoutSchema.default({}),
      landscape: layoutSchema.optional(),
      portrait: layoutSchema.optional(),
      square: layoutSchema.optional(),
    })
    .default({ base: {} }),
  artwork: z
    .object({
      fit: z.enum(["cover", "contain"]).default("cover"),
      frame: z.enum(["square", "circle", "rounded"]).default("square"),
      radius: z.number().finite().min(0).max(0.45).default(0.12),
      opacity: z.number().finite().min(0).max(100).default(100),
    })
    .default({}),
  background: z
    .object({
      fit: z.enum(["cover", "contain"]).default("cover"),
      focusX: z.number().finite().min(0).max(100).default(50),
      focusY: z.number().finite().min(0).max(100).default(50),
      scrimOpacity: z.number().finite().min(0).max(100).default(0),
    })
    .default({}),
  captions: z
    .object({
      color: z
        .string()
        .regex(/^#[\da-fA-F]{6}$/)
        .default("#ffffff"),
      background: z
        .string()
        .regex(/^#[\da-fA-F]{6}$/)
        .default("#050812"),
      backgroundOpacity: z.number().finite().min(0).max(100).default(76),
      font: z.enum(["sans", "serif", "mono"]).default("sans"),
      weight: z.union([z.literal(500), z.literal(700)]).default(700),
      size: z.number().finite().min(0.5).max(2).default(1),
    })
    .default({}),
  promo: z
    .object({
      text: z.string().max(120).default(""),
      visible: z.boolean().default(false),
      color: z
        .string()
        .regex(/^#[\da-fA-F]{6}$/)
        .default("#ffffff"),
      background: z
        .string()
        .regex(/^#[\da-fA-F]{6}$/)
        .default("#080c20"),
      backgroundOpacity: z.number().finite().min(0).max(100).default(72),
      font: z.enum(["sans", "serif", "mono"]).default("sans"),
      weight: z.union([z.literal(500), z.literal(700)]).default(700),
      size: z.number().finite().min(0.5).max(2).default(1),
      align: z.enum(["left", "center", "right"]).default("center"),
    })
    .default({}),
});

export type Composition = z.infer<typeof compositionSchema>;
export type CompositionInput = z.input<typeof compositionSchema>;

export function createDefaultComposition(): Composition {
  return compositionSchema.parse({});
}

/** Infer a stable composition preset from the renderer's backing dimensions. */
export function compositionAspect(width: number, height: number): CompositionAspect {
  const ratio = width / Math.max(1, height);
  if (ratio > 1.1) return "landscape";
  if (ratio < 1 / 1.1) return "portrait";
  return "square";
}

/** Resolve an aspect override, then the shared layout, then renderer geometry. */
export function resolveCompositionBounds(
  composition: Composition | undefined,
  aspect: CompositionAspect,
  element: CompositionElement,
  fallback: CompositionBounds,
): CompositionBounds {
  return composition?.layouts[aspect]?.[element] ?? composition?.layouts.base[element] ?? fallback;
}

/** Return an immutable composition with only the selected aspect changed. */
export function setCompositionBounds(
  composition: Composition | undefined,
  aspect: CompositionAspect,
  element: CompositionElement,
  bounds: CompositionBounds,
): Composition {
  const current = compositionSchema.parse(composition ?? {});
  const nextBounds = clampCompositionBounds(bounds);
  return compositionSchema.parse({
    ...current,
    layouts: {
      ...current.layouts,
      [aspect]: { ...current.layouts[aspect], [element]: nextBounds },
    },
  });
}

/** Keep a resized element inside the canvas and preserve a usable minimum size. */
export function clampCompositionBounds(
  bounds: CompositionBounds,
  minimum = 0.025,
): CompositionBounds {
  const width = Math.max(
    minimum,
    Math.min(1, Number.isFinite(bounds.width) ? bounds.width : minimum),
  );
  const height = Math.max(
    minimum,
    Math.min(1, Number.isFinite(bounds.height) ? bounds.height : minimum),
  );
  const x = Math.max(0, Math.min(1 - width, Number.isFinite(bounds.x) ? bounds.x : 0));
  const y = Math.max(0, Math.min(1 - height, Number.isFinite(bounds.y) ? bounds.y : 0));
  return { x, y, width, height };
}

export function boundsToPixels(
  bounds: CompositionBounds,
  width: number,
  height: number,
): PixelBounds {
  return {
    x: bounds.x * width,
    y: bounds.y * height,
    width: bounds.width * width,
    height: bounds.height * height,
  };
}

export function pixelsToBounds(
  bounds: PixelBounds,
  width: number,
  height: number,
): CompositionBounds {
  return clampCompositionBounds({
    x: bounds.x / Math.max(1, width),
    y: bounds.y / Math.max(1, height),
    width: bounds.width / Math.max(1, width),
    height: bounds.height / Math.max(1, height),
  });
}

/** Map a displayed canvas point to its backing pixels, accounting for letterboxing. */
export function pointerToCanvas(
  clientX: number,
  clientY: number,
  displayed: Pick<DOMRect, "left" | "top" | "width" | "height">,
  canvasWidth: number,
  canvasHeight: number,
  allowOutside = false,
): { x: number; y: number } | null {
  if (displayed.width <= 0 || displayed.height <= 0 || canvasWidth <= 0 || canvasHeight <= 0)
    return null;
  const scale = Math.min(displayed.width / canvasWidth, displayed.height / canvasHeight);
  const renderedWidth = canvasWidth * scale;
  const renderedHeight = canvasHeight * scale;
  const left = displayed.left + (displayed.width - renderedWidth) / 2;
  const top = displayed.top + (displayed.height - renderedHeight) / 2;
  const x = (clientX - left) / scale;
  const y = (clientY - top) / scale;
  if (!allowOutside && (x < 0 || y < 0 || x > canvasWidth || y > canvasHeight)) return null;
  return {
    x: allowOutside ? Math.max(0, Math.min(canvasWidth, x)) : x,
    y: allowOutside ? Math.max(0, Math.min(canvasHeight, y)) : y,
  };
}

/** Hit-test from front-most painted element to the back-most. */
export function hitTestComposition(
  geometry: Partial<Record<CompositionElement, PixelBounds>>,
  point: { x: number; y: number },
  order: readonly CompositionElement[] = [
    "captions",
    "promo",
    "trackInfo",
    "artwork",
    "logo",
    "background",
  ],
): CompositionElement | null {
  for (const element of order) {
    const bounds = geometry[element];
    if (
      bounds &&
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height
    )
      return element;
  }
  return null;
}
