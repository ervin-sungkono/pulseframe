import { z } from "zod";
import type { VisualSettings } from "./visualizer";
import { settingsSchema, migrateSettings } from "./visual-settings";
import type { SubtitleCue } from "./subtitles";

const cueSchema = z.object({ id: z.string().max(80), start: z.number().finite().min(0),
  end: z.number().finite().min(0), text: z.string().max(600) });
const assetSchema = z.object({ name: z.string().min(1).max(255), type: z.string().max(100), size: z.number().int().min(0) });
const manifestSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), format: z.enum(["landscape", "portrait", "square"]),
  profile: z.enum(["standard", "smaller"]),
  range: z.tuple([z.number().finite().min(0), z.number().finite().min(0)]),
  settings: settingsSchema,
  subtitles: z.array(cueSchema).max(500),
  media: assetSchema,
  logo: assetSchema.nullable(),
  background: assetSchema.nullable().optional().default(null),
});
const MAGIC = "PF01";
const MAX_MANIFEST = 256 * 1024;

export type ProjectContent = {
  format: "landscape" | "portrait" | "square";
  profile: "standard" | "smaller";
  range: [number, number];
  settings: VisualSettings;
  subtitles: SubtitleCue[];
  media: File;
  logo: File | null;
  background: File | null;
  migratedStyle?: string;
};

// A small header followed by the original media bytes and optional logo bytes.
// Blob slicing and composition avoid reading large videos into JS memory.
export function makeProjectFile(content: ProjectContent): Blob {
  const manifest = {
    version: 2, format: content.format, profile: content.profile, range: content.range, settings: content.settings,
    subtitles: content.subtitles,
    media: { name: content.media.name, type: content.media.type, size: content.media.size },
    logo: content.logo ? { name: content.logo.name, type: content.logo.type, size: content.logo.size } : null,
    background: content.background ? { name: content.background.name, type: content.background.type, size: content.background.size } : null,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (bytes.length > MAX_MANIFEST) throw new Error("This project has too much text to save.");
  const header = new Uint8Array(8);
  header.set(new TextEncoder().encode(MAGIC));
  new DataView(header.buffer).setUint32(4, bytes.length, true);
  return new Blob([header, bytes, content.media, ...(content.logo ? [content.logo] : []), ...(content.background ? [content.background] : [])], { type: "application/x-pulseframe" });
}

export async function readProjectFile(file: File): Promise<ProjectContent> {
  if (file.size < 8) throw new Error("This is not a Pulseframe project.");
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (new TextDecoder().decode(header.slice(0, 4)) !== MAGIC) throw new Error("This is not a Pulseframe project.");
  const manifestLength = new DataView(header.buffer).getUint32(4, true);
  if (!manifestLength || manifestLength > MAX_MANIFEST || 8 + manifestLength > file.size) {
    throw new Error("The project header is damaged.");
  }
  let raw: unknown;
  try { raw = JSON.parse(await file.slice(8, 8 + manifestLength).text()); }
  catch { throw new Error("The project details could not be read."); }
  const result = manifestSchema.safeParse(raw);
  if (!result.success) throw new Error("This project is incomplete or uses an unsupported version.");
  const data = result.data;
  if (data.range[1] < data.range[0] || data.subtitles.some(cue => cue.end <= cue.start)) {
    throw new Error("This project has invalid timestamps.");
  }
  const mediaStart = 8 + manifestLength;
  const logoStart = mediaStart + data.media.size;
  const backgroundStart = logoStart + (data.logo?.size ?? 0);
  if (!data.media.size || backgroundStart + (data.background?.size ?? 0) !== file.size) {
    throw new Error("The project media is missing or damaged.");
  }
  const mediaSupported = data.media.type.startsWith("audio/") || data.media.type.startsWith("video/") ||
    /\.(mp3|wav|m4a|aac|ogg|flac|opus|mp4|mov|webm|m4v)$/i.test(data.media.name);
  if (!mediaSupported) throw new Error("The project contains an unsupported media file.");
  if (data.logo && (data.logo.size > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(data.logo.type))) {
    throw new Error("The project contains an unsupported logo.");
  }
  if (data.background && (data.background.size > 20 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp", "image/avif"].includes(data.background.type))) {
    throw new Error("The project contains an unsupported background image.");
  }
  return {
    format: data.format, profile: data.profile, range: data.range, settings: migrateSettings(data.settings),
    migratedStyle: data.settings.mode === "ring" || data.settings.mode === "spectrum" || data.settings.mode === "edges" ? undefined : data.settings.mode,
    subtitles: data.subtitles,
    media: new File([file.slice(mediaStart, logoStart)], data.media.name, { type: data.media.type }),
    logo: data.logo ? new File([file.slice(logoStart, backgroundStart)], data.logo.name, { type: data.logo.type }) : null,
    background: data.background ? new File([file.slice(backgroundStart)], data.background.name, { type: data.background.type }) : null,
  };
}
