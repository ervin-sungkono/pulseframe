import { z } from "zod";
import {
  compositionSchema,
  defaultComposition,
  elementAssets,
  type Composition,
} from "../composition/model";
import {
  VISUAL_MODES,
  type VisualMode,
  type VisualSettings,
} from "../visual/visual-settings-model";
import { settingsSchema, migrateSettings } from "../visual/visual-settings";
import {
  DEFAULT_EXPORT_FRAME_RATE,
  DEFAULT_EXPORT_RESOLUTION,
  EXPORT_ASPECTS,
  EXPORT_FRAME_RATES,
  EXPORT_RESOLUTIONS,
  type ExportAspect,
  type ExportFrameRate,
  type ExportResolution,
} from "../export/export-settings";
import {
  MAX_SUBTITLE_CUES,
  MAX_SUBTITLE_TEXT_LENGTH,
  validateSubtitleWords,
  type SubtitleCue,
} from "../subtitles/model";

const cueSchema = z
  .object({
    id: z.string().max(80),
    start: z.number().finite().min(0),
    end: z.number().finite().min(0),
    text: z.string().max(MAX_SUBTITLE_TEXT_LENGTH),
    words: z.unknown().optional(),
  })
  .superRefine((cue, ctx) => {
    if (
      cue.words !== undefined &&
      !validateSubtitleWords(cue.text, cue.words, { start: cue.start, end: cue.end })
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["words"],
        message: "Invalid subtitle word timing.",
      });
    }
  });

const assetSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.string().max(100),
  size: z.number().safe().int().min(0),
});
const compositionAssetSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(255),
  type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  size: z
    .number()
    .safe()
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
});
const exportResolutionSchema = z
  .number()
  .refine((value): value is ExportResolution =>
    EXPORT_RESOLUTIONS.some((resolution) => resolution === value),
  );
const exportFrameRateSchema = z
  .number()
  .refine((value): value is ExportFrameRate =>
    EXPORT_FRAME_RATES.some((frameRate) => frameRate === value),
  );
const manifestSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    format: z.enum(EXPORT_ASPECTS),
    profile: z.enum(["standard", "smaller"]).optional(),
    resolution: exportResolutionSchema.optional(),
    videoCompression: z.boolean().optional().default(false),
    frameRate: exportFrameRateSchema.optional().default(DEFAULT_EXPORT_FRAME_RATE),
    range: z.tuple([z.number().finite().min(0), z.number().finite().min(0)]),
    settings: settingsSchema,
    subtitles: z.array(cueSchema).max(MAX_SUBTITLE_CUES),
    media: assetSchema,
    logo: assetSchema.nullable(),
    background: assetSchema.nullable().optional().default(null),
    composition: compositionSchema.optional(),
    assets: z.array(compositionAssetSchema).max(30).optional(),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.version !== 3) return;
    if (!manifest.composition || !manifest.assets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The composition details are missing.",
      });
      return;
    }
    const ids = manifest.assets.map((asset) => asset.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assets"],
        message: "Duplicate image asset IDs.",
      });
      return;
    }

    const assetIds = new Set(ids);
    const referencedIds = new Set(elementAssets(manifest.composition));
    for (const id of referencedIds) {
      if (!assetIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["composition"],
          message: "The composition references a missing image asset.",
        });
        return;
      }
    }
    if (referencedIds.size !== assetIds.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assets"],
        message: "The image assets do not match the composition references.",
      });
    }
  });

const MAGIC = "PF01";
const MAX_MANIFEST = 4 * 1024 * 1024;

export type ProjectContent = {
  format: ExportAspect;
  profile?: "standard" | "smaller";
  resolution?: ExportResolution;
  frameRate?: ExportFrameRate;
  videoCompression?: boolean;
  range: [number, number];
  settings: VisualSettings;
  subtitles: SubtitleCue[];
  media: File;
  logo: File | null;
  background: File | null;
  composition?: Composition;
  assets?: Record<string, File>;
  migratedStyle?: string;
};

function safeOffset(base: number, size: number) {
  const result = base + size;
  return Number.isSafeInteger(result) ? result : Number.POSITIVE_INFINITY;
}

function validatedAssetMetadata(composition: Composition, assets: Record<string, File>) {
  const entries = Object.entries(assets);
  if (entries.length > 30) throw new Error("A composition can contain at most 30 images.");
  const assetIds = new Set<string>();
  const metadata = entries.map(([id, file]) => {
    if (!id || id.length > 80 || assetIds.has(id))
      throw new Error("A composition image has an invalid ID.");
    assetIds.add(id);
    const parsed = compositionAssetSchema.safeParse({
      id,
      name: file.name,
      type: file.type,
      size: file.size,
    });
    if (!parsed.success) throw new Error("The project contains an unsupported composition image.");
    return parsed.data;
  });

  const referencedIds = new Set(elementAssets(composition));
  if (referencedIds.size !== assetIds.size || [...referencedIds].some((id) => !assetIds.has(id))) {
    throw new Error("The image assets do not match the composition references.");
  }
  return { entries, metadata };
}

// The file contains a small header, JSON metadata, then Blob-backed media and
// images. Keeping the original File objects here avoids reading full media bytes.
export function makeProjectFile(content: ProjectContent): Blob {
  const composition = compositionSchema.parse(content.composition ?? defaultComposition());
  const { entries: assetEntries, metadata: assets } = validatedAssetMetadata(
    composition,
    content.assets ?? Object.create(null),
  );
  const manifest = {
    version: 3,
    videoCompression: content.videoCompression ?? false,
    resolution:
      content.resolution ?? (content.profile === "smaller" ? 480 : DEFAULT_EXPORT_RESOLUTION),
    format: content.format,
    frameRate: content.frameRate ?? DEFAULT_EXPORT_FRAME_RATE,
    range: content.range,
    settings: content.settings,
    subtitles: content.subtitles,
    media: { name: content.media.name, type: content.media.type, size: content.media.size },
    logo: content.logo
      ? { name: content.logo.name, type: content.logo.type, size: content.logo.size }
      : null,
    background: content.background
      ? {
          name: content.background.name,
          type: content.background.type,
          size: content.background.size,
        }
      : null,
    composition,
    assets,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (bytes.length > MAX_MANIFEST) throw new Error("This project has too much text to save.");
  const header = new Uint8Array(8);
  header.set(new TextEncoder().encode(MAGIC));
  new DataView(header.buffer).setUint32(4, bytes.length, true);
  return new Blob(
    [
      header,
      bytes,
      content.media,
      ...(content.logo ? [content.logo] : []),
      ...(content.background ? [content.background] : []),
      ...assetEntries.map(([, file]) => file),
    ],
    { type: "application/x-pulseframe" },
  );
}

export async function readProjectFile(file: File): Promise<ProjectContent> {
  if (file.size < 8) throw new Error("This is not a Pulseframe project.");
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (new TextDecoder().decode(header.slice(0, 4)) !== MAGIC)
    throw new Error("This is not a Pulseframe project.");
  const manifestLength = new DataView(header.buffer).getUint32(4, true);
  if (!manifestLength || manifestLength > MAX_MANIFEST || 8 + manifestLength > file.size) {
    throw new Error("The project header is damaged.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await file.slice(8, 8 + manifestLength).text());
  } catch {
    throw new Error("The project details could not be read.");
  }
  const result = manifestSchema.safeParse(raw);
  if (!result.success)
    throw new Error("This project is incomplete or uses an unsupported version.");
  const data = result.data;
  if (data.range[1] < data.range[0] || data.subtitles.some((cue) => cue.end <= cue.start)) {
    throw new Error("This project has invalid timestamps.");
  }
  const mediaStart = 8 + manifestLength;
  const logoStart = safeOffset(mediaStart, data.media.size);
  const backgroundStart = safeOffset(logoStart, data.logo?.size ?? 0);
  const existingAssetsEnd = safeOffset(backgroundStart, data.background?.size ?? 0);
  if (!Number.isSafeInteger(existingAssetsEnd) || !data.media.size) {
    throw new Error("The project media is missing or damaged.");
  }
  const expectedEnd = (data.assets ?? []).reduce(
    (offset, asset) => safeOffset(offset, asset.size),
    existingAssetsEnd,
  );
  if (!Number.isSafeInteger(expectedEnd) || expectedEnd !== file.size) {
    throw new Error("The project media is missing or damaged.");
  }

  const mediaSupported =
    data.media.type.startsWith("audio/") ||
    data.media.type.startsWith("video/") ||
    /\.(mp3|wav|m4a|aac|ogg|flac|opus|mp4|mov|webm|m4v)$/i.test(data.media.name);
  if (!mediaSupported) throw new Error("The project contains an unsupported media file.");
  if (
    data.logo &&
    (data.logo.size > 8 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp"].includes(data.logo.type))
  ) {
    throw new Error("The project contains an unsupported logo.");
  }
  if (
    data.background &&
    (data.background.size > 20 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp", "image/avif"].includes(data.background.type))
  ) {
    throw new Error("The project contains an unsupported background image.");
  }

  let offset = existingAssetsEnd;
  const compositionAssets = Object.create(null) as Record<string, File>;
  for (const asset of data.assets ?? []) {
    const end = safeOffset(offset, asset.size);
    if (!Number.isSafeInteger(end) || end > file.size)
      throw new Error("The project image assets are missing or damaged.");
    compositionAssets[asset.id] = new File([file.slice(offset, end)], asset.name, {
      type: asset.type,
    });
    offset = end;
  }

  const subtitles: SubtitleCue[] = data.subtitles.map((cue) => {
    const words =
      cue.words === undefined ? undefined : validateSubtitleWords(cue.text, cue.words, cue);
    const plainCue = { id: cue.id, start: cue.start, end: cue.end, text: cue.text };
    return words ? { ...plainCue, words } : plainCue;
  });
  return {
    videoCompression: data.videoCompression,
    resolution: data.resolution ?? (data.profile === "smaller" ? 480 : DEFAULT_EXPORT_RESOLUTION),
    format: data.format,
    frameRate: data.frameRate,
    range: data.range,
    settings: migrateSettings(data.settings),
    migratedStyle: VISUAL_MODES.includes(data.settings.mode as VisualMode)
      ? undefined
      : data.settings.mode,
    subtitles,
    media: new File([file.slice(mediaStart, logoStart)], data.media.name, {
      type: data.media.type,
    }),
    logo: data.logo
      ? new File([file.slice(logoStart, backgroundStart)], data.logo.name, { type: data.logo.type })
      : null,
    background: data.background
      ? new File([file.slice(backgroundStart, existingAssetsEnd)], data.background.name, {
          type: data.background.type,
        })
      : null,
    composition: data.composition ?? defaultComposition(),
    assets: compositionAssets,
  };
}
