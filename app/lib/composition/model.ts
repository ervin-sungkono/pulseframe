import { z } from "zod";
import type { VisualMode, VisualSettings } from "../visual/visual-settings-model";
import type { SubtitleCue } from "../subtitles/model";
import type { ExportAspect } from "../export/export-settings";

export const MAX_COMPOSITION_ELEMENTS = 32;
export const MAX_CIRCLE_INSTANCES = 4;
export type FrameTransform = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};
export const FULL_FRAME: FrameTransform = { x: 0.5, y: 0.5, width: 1, height: 1, rotation: 0 };
const color = z.string().regex(/^#[a-f\d]{6}$/i);
export const transformSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().min(0.03).max(1.5),
  height: z.number().finite().min(0.03).max(1.5),
  rotation: z.number().finite().min(-180).max(180),
});
const baseSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  transform: transformSchema,
  visible: z.boolean(),
  locked: z.boolean(),
});
const visualizerSchema = baseSchema.extend({
  palette: z.object({ primary: color, secondary: color }).optional(),
});
const commonElement = baseSchema.extend({ opacity: z.number().finite().min(0).max(1) });
const textSchema = commonElement.extend({
  type: z.literal("text"),
  text: z.string().max(600),
  binding: z.enum(["none", "title", "artist", "timer"]),
  color,
  font: z.enum(["sans", "serif", "mono"]),
  fontSize: z.number().finite().min(0.01).max(0.3),
  align: z.enum(["left", "center", "right"]),
  weight: z.union([z.literal(500), z.literal(700)]),
});
const imageSchema = commonElement.extend({
  type: z.literal("image"),
  assetId: z.string().min(1).max(80),
  fit: z.enum(["contain", "cover"]),
});
const shapeSchema = commonElement.extend({
  type: z.literal("shape"),
  shape: z.enum(["rectangle", "ellipse"]),
  color,
  roundness: z.number().finite().min(0).max(1),
});
export const elementSchema = z.discriminatedUnion("type", [textSchema, imageSchema, shapeSchema]);
export const lyricStyleSchema = z.object({
  animation: z.enum(["static", "fade", "pop", "highlight", "karaoke"]),
  color,
  highlightColor: color,
  fontSize: z.number().finite().min(0.02).max(0.12),
  position: z.number().finite().min(0.15).max(0.95),
  background: z.boolean(),
});
export const compositionSchema = z
  .object({
    visualizers: z.array(visualizerSchema).min(1).max(MAX_CIRCLE_INSTANCES),
    elements: z.array(elementSchema).max(MAX_COMPOSITION_ELEMENTS - 2),
    lyrics: lyricStyleSchema,
    logoFrameId: z.string().max(80).nullable(),
  })
  .superRefine((value, ctx) => {
    const ids = [...value.visualizers, ...value.elements].map((item) => item.id);
    if (new Set(ids).size !== ids.length || ids.length + 1 > MAX_COMPOSITION_ELEMENTS)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid composition element count or IDs.",
      });
    if (value.logoFrameId && !value.visualizers.some((item) => item.id === value.logoFrameId))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The logo frame is missing." });
  });
export type VisualizerInstance = z.infer<typeof visualizerSchema>;
export type CreativeElement = z.infer<typeof elementSchema>;
export type Composition = z.infer<typeof compositionSchema>;
export type LyricStyle = Composition["lyrics"];
export type EditorDocument = {
  settings: VisualSettings;
  composition: Composition;
  subtitles: SubtitleCue[];
  format: ExportAspect;
};
export type CompositionImage = HTMLImageElement | ImageBitmap;
export type CompositionImages = ReadonlyMap<string, CompositionImage>;
export const DEFAULT_LYRIC_STYLE: LyricStyle = {
  animation: "static",
  color: "#ffffff",
  highlightColor: "#b9a2ff",
  fontSize: 0.046,
  position: 0.945,
  background: true,
};
export function defaultComposition(): Composition {
  return {
    visualizers: [
      {
        id: "visualizer",
        name: "Visualizer",
        transform: { ...FULL_FRAME },
        visible: true,
        locked: false,
      },
    ],
    elements: [],
    lyrics: { ...DEFAULT_LYRIC_STYLE },
    logoFrameId: "visualizer",
  };
}
export function isCircularMode(mode: VisualMode) {
  return mode === "ring" || mode === "radial";
}
export function activeVisualizers(composition: Composition, mode: VisualMode) {
  return (
    isCircularMode(mode) ? composition.visualizers : composition.visualizers.slice(0, 1)
  ).filter((item) => item.visible);
}
export function newElement(
  type: "text" | "rectangle" | "ellipse" | "image",
  assetId = "",
): CreativeElement {
  const base = {
    id: crypto.randomUUID(),
    name: type === "text" ? "Text" : type === "image" ? "Artwork" : "Shape",
    visible: true,
    locked: false,
    opacity: 1,
    transform: {
      x: 0.5,
      y: 0.5,
      width: type === "text" ? 0.6 : 0.25,
      height: type === "text" ? 0.15 : 0.25,
      rotation: 0,
    },
  };
  if (type === "text")
    return {
      ...base,
      type,
      text: "Your text",
      binding: "none",
      color: "#ffffff",
      font: "sans",
      fontSize: 0.055,
      align: "center",
      weight: 700,
    };
  if (type === "image") return { ...base, type, assetId, fit: "contain" };
  return { ...base, type: "shape", shape: type, color: "#8d6fd3", roundness: 0.15 };
}
export function duplicateVisualizer(composition: Composition, sourceId?: string): Composition {
  if (
    composition.visualizers.length >= MAX_CIRCLE_INSTANCES ||
    composition.visualizers.length + composition.elements.length + 1 >= MAX_COMPOSITION_ELEMENTS
  )
    return composition;
  const source = sourceId
    ? composition.visualizers.find((item) => item.id === sourceId)
    : composition.visualizers.at(-1);
  if (!source) return composition;
  return {
    ...composition,
    visualizers: [
      ...composition.visualizers,
      {
        ...source,
        id: crypto.randomUUID(),
        name: `Visualizer ${composition.visualizers.length + 1}`,
        locked: false,
        transform: {
          ...source.transform,
          x: Math.min(0.9, source.transform.x + 0.04),
          y: Math.min(0.9, source.transform.y + 0.04),
        },
        palette: source.palette ? { ...source.palette } : undefined,
      },
    ],
  };
}
export function elementAssets(composition: Composition): string[] {
  return composition.elements.flatMap((item) => (item.type === "image" ? [item.assetId] : []));
}
export function validateComposition(value: unknown): Composition {
  return compositionSchema.parse(value);
}
