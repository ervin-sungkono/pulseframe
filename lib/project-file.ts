import { z } from "zod";
import type { VisualSettings } from "./visual-settings-model";
import { settingsSchema, migrateSettings } from "./visual-settings";
import type { ExportResolution } from "./export-settings";
import type { ExportFrameRate } from "./export-timeline";
import type { SubtitleCue } from "./subtitles";
import type { ReleaseRecipe } from "./release-recipe";
import { buildPlaylistTimeline } from "./playlist-timeline";
import {
  PROJECT_LIMITS,
  createProjectTrack,
  resolveTrackMetadata,
  validateProjectTrack,
  type ProjectTrack,
} from "./project-model";

const cueSchema = z.object({
  id: z.string().max(80),
  start: z.number().finite().min(0),
  end: z.number().finite().min(0),
  text: z.string().max(600),
});
const assetSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.string().max(100),
  size: z.number().int().min(0),
});
const legacyManifestSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  format: z.enum(["landscape", "portrait", "square"]),
  profile: z.enum(["standard", "smaller"]).optional(),
  resolution: z
    .union([z.literal(480), z.literal(720), z.literal(1080), z.literal(1440)])
    .optional(),
  videoCompression: z.boolean().optional().default(false),
  frameRate: z
    .union([z.literal(24), z.literal(30), z.literal(60)])
    .optional()
    .default(30),
  range: z.tuple([z.number().finite().min(0), z.number().finite().min(0)]),
  settings: settingsSchema,
  subtitles: z.array(cueSchema).max(500),
  media: assetSchema,
  logo: assetSchema.nullable(),
  background: assetSchema.nullable().optional().default(null),
});
const v3AssetSchema = z.object({
  id: z.string().min(1).max(PROJECT_LIMITS.trackIdLength),
  role: z.enum(["media", "logo", "background", "artwork"]),
  name: z.string().min(1).max(255),
  type: z.string().max(100),
  size: z.number().int().min(0),
});
const v3TrackSchema = z.object({
  id: z.string().min(1).max(PROJECT_LIMITS.trackIdLength),
  mediaAssetId: z.string().min(1).max(PROJECT_LIMITS.trackIdLength),
  duration: z.number().finite().positive(),
  range: z.tuple([z.number().finite().min(0), z.number().finite().min(0)]),
  title: z.string().max(PROJECT_LIMITS.titleLength),
  artist: z.string().max(PROJECT_LIMITS.artistLength),
  subtitles: z.array(cueSchema).max(PROJECT_LIMITS.cuesPerTrack),
  artworkAssetId: z.string().min(1).max(PROJECT_LIMITS.trackIdLength).nullable().optional(),
});
const releaseVideoOutputSchema = z
  .object({
    enabled: z.boolean(),
    aspect: z.enum(["landscape", "portrait", "square"]),
    resolution: z.union([z.literal(480), z.literal(720), z.literal(1080), z.literal(1440)]),
    frameRate: z.union([z.literal(24), z.literal(30), z.literal(60)]),
    videoCompression: z.boolean(),
    range: z.tuple([z.number().finite().min(0), z.number().finite().min(0)]),
  })
  .superRefine((output, context) => {
    if (output.range[1] < output.range[0])
      context.addIssue({ code: "custom", path: ["range"], message: "Invalid output range." });
  });
const releaseStillOutputSchema = z.object({
  enabled: z.boolean(),
  aspect: z.enum(["landscape", "portrait", "square"]),
  resolution: z.union([z.literal(480), z.literal(720), z.literal(1080), z.literal(1440)]),
  time: z.number().finite().min(0),
});
const releaseRecipeSchema = z.object({
  fullVideo: releaseVideoOutputSchema,
  portraitTeaser: releaseVideoOutputSchema,
  thumbnail: releaseStillOutputSchema,
});
const v3ManifestSchema = z.object({
  version: z.literal(3),
  format: z.enum(["landscape", "portrait", "square"]),
  profile: z.enum(["standard", "smaller"]).optional(),
  resolution: z
    .union([z.literal(480), z.literal(720), z.literal(1080), z.literal(1440)])
    .optional()
    .default(720),
  videoCompression: z.boolean().optional().default(false),
  frameRate: z
    .union([z.literal(24), z.literal(30), z.literal(60)])
    .optional()
    .default(30),
  settings: settingsSchema,
  tracks: z.array(v3TrackSchema).min(1).max(PROJECT_LIMITS.tracks),
  activeTrackId: z.string().min(1).max(PROJECT_LIMITS.trackIdLength),
  exportRange: z.tuple([z.number().finite().min(0), z.number().finite().min(0)]).optional(),
  releaseRecipe: releaseRecipeSchema.optional(),
  assets: z.array(v3AssetSchema).max(PROJECT_LIMITS.tracks * 2 + 2),
  logoAssetId: z.string().min(1).max(PROJECT_LIMITS.trackIdLength).nullable(),
  backgroundAssetId: z.string().min(1).max(PROJECT_LIMITS.trackIdLength).nullable(),
});
const MAGIC = "PF01";
const MAX_MANIFEST = PROJECT_LIMITS.legacyManifestBytes;

export type ProjectContent = {
  format: "landscape" | "portrait" | "square";
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
  migratedStyle?: string;
  tracks?: ProjectTrack[];
  activeTrackId?: string;
  artwork?: File | null;
  globalExportRange?: [number, number];
  releaseRecipe?: ReleaseRecipe;
};

// A small header followed by the original media bytes and optional logo bytes.
// Blob slicing and composition avoid reading large videos into JS memory.
export function makeProjectFile(content: ProjectContent): Blob {
  if (
    content.tracks?.length ||
    content.artwork ||
    content.globalExportRange ||
    content.releaseRecipe ||
    (content.settings as VisualSettings & { composition?: unknown }).composition
  ) {
    return makeV3ProjectFile(content);
  }
  return makeLegacyProjectFile(content);
}

function makeLegacyProjectFile(content: ProjectContent): Blob {
  const manifest = {
    version: 2,
    videoCompression: content.videoCompression ?? false,
    resolution: content.resolution ?? (content.profile === "smaller" ? 480 : 720),
    format: content.format,
    frameRate: content.frameRate ?? 30,
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
    ],
    { type: "application/x-pulseframe" },
  );
}

type V3Asset = {
  id: string;
  role: "media" | "logo" | "background" | "artwork";
  file: File;
};

function makeV3ProjectFile(content: ProjectContent): Blob {
  const tracks = content.tracks?.length
    ? content.tracks.map((track) => validateProjectTrack(track))
    : [
        createProjectTrack(
          content.media,
          Math.max(content.range[1], ...content.subtitles.map((cue) => cue.end), 0.001),
          "track-legacy-1",
        ),
      ];
  if (!content.tracks?.length) {
    tracks[0].range = [content.range[0], content.range[1]];
    tracks[0].subtitles = content.subtitles.map((cue) => ({ ...cue }));
    tracks[0].title = content.settings.trackTitle;
    tracks[0].artist = content.settings.trackArtist;
    tracks[0].artwork = content.artwork ?? null;
    validateProjectTrack(tracks[0]);
  }
  if (tracks.length > PROJECT_LIMITS.tracks)
    throw new Error("A project can contain up to 20 tracks.");
  const trackIds = new Set<string>();
  for (const track of tracks) {
    if (trackIds.has(track.id)) throw new Error("A project contains duplicate track IDs.");
    trackIds.add(track.id);
  }
  const activeTrackId = content.activeTrackId ?? tracks[0].id;
  const activeTrack = tracks.find((track) => track.id === activeTrackId);
  if (!activeTrack) throw new Error("The selected track is missing from this project.");
  const timeline = buildPlaylistTimeline(tracks);
  const globalExportRange = content.globalExportRange ?? [0, timeline.duration];
  validateProjectRange(globalExportRange, timeline.duration);
  const releaseRecipe = content.releaseRecipe
    ? validateReleaseRecipe(content.releaseRecipe, globalExportRange)
    : undefined;

  const assets: V3Asset[] = [];
  const usedIds = new Set<string>();
  const addAsset = (base: string, role: V3Asset["role"], file: File | null) => {
    if (!file) return null;
    const stem = base.slice(0, PROJECT_LIMITS.trackIdLength - 4);
    let id = stem;
    let suffix = 2;
    while (usedIds.has(id)) {
      const end = `-${suffix++}`;
      id = `${stem.slice(0, PROJECT_LIMITS.trackIdLength - end.length)}${end}`;
    }
    usedIds.add(id);
    assets.push({ id, role, file });
    return id;
  };
  const manifestTracks = tracks.map((track) => ({
    id: track.id,
    mediaAssetId: addAsset(`media-${track.id}`, "media", track.file)!,
    duration: track.duration,
    range: track.range,
    title: track.title,
    artist: track.artist,
    subtitles: track.subtitles,
    artworkAssetId: addAsset(`artwork-${track.id}`, "artwork", track.artwork),
  }));
  const logoAssetId = addAsset("logo", "logo", content.logo);
  const backgroundAssetId = addAsset("background", "background", content.background);
  for (const asset of assets) {
    if (!Number.isSafeInteger(asset.file.size) || asset.file.size <= 0)
      throw new Error("The project contains an invalid or empty asset.");
    if (asset.role === "media") validateMediaAsset(asset.file);
    else validateImageAsset(asset.file, asset.role);
  }
  const manifest = {
    version: 3,
    videoCompression: content.videoCompression ?? false,
    resolution: content.resolution ?? (content.profile === "smaller" ? 480 : 720),
    format: content.format,
    frameRate: content.frameRate ?? 30,
    settings: resolveTrackMetadata(content.settings, activeTrack),
    tracks: manifestTracks,
    activeTrackId,
    exportRange: globalExportRange,
    releaseRecipe,
    assets: assets.map(({ id, role, file }) => ({
      id,
      role,
      name: file.name,
      type: file.type,
      size: file.size,
    })),
    logoAssetId,
    backgroundAssetId,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (bytes.length > PROJECT_LIMITS.manifestBytes)
    throw new Error("This project has too much text to save.");
  const header = makeHeader(bytes);
  return new Blob([header, bytes, ...assets.map((asset) => asset.file)], {
    type: "application/x-pulseframe",
  });
}

function makeHeader(manifest: Uint8Array) {
  const header = new Uint8Array(8);
  header.set(new TextEncoder().encode(MAGIC));
  new DataView(header.buffer).setUint32(4, manifest.length, true);
  return header;
}

export async function readProjectFile(file: File): Promise<ProjectContent> {
  if (file.size < 8) throw new Error("This is not a Pulseframe project.");
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (new TextDecoder().decode(header.slice(0, 4)) !== MAGIC)
    throw new Error("This is not a Pulseframe project.");
  const manifestLength = new DataView(header.buffer).getUint32(4, true);
  if (
    !manifestLength ||
    manifestLength > PROJECT_LIMITS.manifestBytes ||
    !Number.isSafeInteger(8 + manifestLength) ||
    8 + manifestLength > file.size
  ) {
    throw new Error("The project header is damaged.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await file.slice(8, 8 + manifestLength).text());
  } catch {
    throw new Error("The project details could not be read.");
  }
  if (!raw || typeof raw !== "object" || !("version" in raw))
    throw new Error("This project is incomplete or uses an unsupported version.");
  if ((raw as { version?: unknown }).version === 3) {
    if (manifestLength > PROJECT_LIMITS.manifestBytes)
      throw new Error("The project header is damaged.");
    const result = v3ManifestSchema.safeParse(raw);
    if (!result.success)
      throw new Error("This project is incomplete or uses an unsupported version.");
    return readV3Project(file, manifestLength, result.data);
  }
  if (manifestLength > MAX_MANIFEST) throw new Error("The project header is damaged.");
  const result = legacyManifestSchema.safeParse(raw);
  if (!result.success)
    throw new Error("This project is incomplete or uses an unsupported version.");
  const data = result.data;
  if (data.range[1] < data.range[0] || data.subtitles.some((cue) => cue.end <= cue.start)) {
    throw new Error("This project has invalid timestamps.");
  }
  const mediaStart = 8 + manifestLength;
  const logoStart = mediaStart + data.media.size;
  const backgroundStart = logoStart + (data.logo?.size ?? 0);
  if (
    !Number.isSafeInteger(logoStart) ||
    !Number.isSafeInteger(backgroundStart) ||
    !Number.isSafeInteger(backgroundStart + (data.background?.size ?? 0)) ||
    !data.media.size ||
    backgroundStart + (data.background?.size ?? 0) !== file.size
  ) {
    throw new Error("The project media is missing or damaged.");
  }
  validateMediaAsset(data.media);
  validateImageAsset(data.logo, "logo", true);
  validateImageAsset(data.background, "background", true);
  const media = new File([file.slice(mediaStart, logoStart)], data.media.name, {
    type: data.media.type,
  });
  const logo = data.logo
    ? new File([file.slice(logoStart, backgroundStart)], data.logo.name, { type: data.logo.type })
    : null;
  const background = data.background
    ? new File([file.slice(backgroundStart)], data.background.name, { type: data.background.type })
    : null;
  const settings = migrateSettings(data.settings);
  const duration = Math.max(data.range[1], ...data.subtitles.map((cue) => cue.end), 0.001);
  const track = createProjectTrack(media, duration, "track-legacy-1");
  track.range = [data.range[0], data.range[1]];
  track.title = settings.trackTitle;
  track.artist = settings.trackArtist;
  track.subtitles = data.subtitles;
  track.artwork = null;
  return {
    videoCompression: data.videoCompression,
    resolution: data.resolution ?? (data.profile === "smaller" ? 480 : 720),
    format: data.format,
    frameRate: data.frameRate,
    range: data.range,
    settings: resolveTrackMetadata(settings, track),
    migratedStyle:
      data.settings.mode === "ring" ||
      data.settings.mode === "spectrum" ||
      data.settings.mode === "edges"
        ? undefined
        : data.settings.mode,
    subtitles: data.subtitles,
    media,
    logo,
    background,
    artwork: null,
    tracks: [track],
    activeTrackId: track.id,
    globalExportRange: [0, Math.max(0, data.range[1] - data.range[0])],
  };
}

type ParsedV3Manifest = z.infer<typeof v3ManifestSchema>;

async function readV3Project(file: File, manifestLength: number, data: ParsedV3Manifest) {
  const trackIds = new Set<string>();
  for (const track of data.tracks) {
    if (trackIds.has(track.id)) throw new Error("The project contains duplicate track IDs.");
    trackIds.add(track.id);
    if (
      track.range[1] < track.range[0] ||
      track.range[1] > track.duration ||
      track.subtitles.some((cue) => cue.end <= cue.start || cue.end > track.duration)
    ) {
      throw new Error("This project has invalid timestamps.");
    }
  }
  if (!trackIds.has(data.activeTrackId))
    throw new Error("The selected track is missing from this project.");

  const assetsById = new Map<string, z.infer<typeof v3AssetSchema>>();
  for (const asset of data.assets) {
    if (assetsById.has(asset.id)) throw new Error("The project contains duplicate asset IDs.");
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0)
      throw new Error("The project contains an invalid asset size.");
    assetsById.set(asset.id, asset);
  }
  const referencedIds = new Set<string>();
  const requireAsset = (
    id: string | null | undefined,
    role: z.infer<typeof v3AssetSchema>["role"],
  ) => {
    if (!id) return null;
    const asset = assetsById.get(id);
    if (!asset || asset.role !== role)
      throw new Error("This project refers to a missing or incompatible asset.");
    referencedIds.add(id);
    return asset;
  };
  for (const track of data.tracks) {
    requireAsset(track.mediaAssetId, "media");
    if (track.artworkAssetId) requireAsset(track.artworkAssetId, "artwork");
  }
  const logoMeta = requireAsset(data.logoAssetId, "logo");
  const backgroundMeta = requireAsset(data.backgroundAssetId, "background");
  if (referencedIds.size !== assetsById.size)
    throw new Error("The project contains an unreferenced asset.");

  let offset = 8 + manifestLength;
  if (!Number.isSafeInteger(offset)) throw new Error("The project media is missing or damaged.");
  const files = new Map<string, File>();
  for (const asset of data.assets) {
    if (asset.size > Number.MAX_SAFE_INTEGER - offset)
      throw new Error("The project media is missing or damaged.");
    const nextOffset = offset + asset.size;
    files.set(
      asset.id,
      new File([file.slice(offset, nextOffset)], asset.name, { type: asset.type }),
    );
    offset = nextOffset;
  }
  if (offset !== file.size) throw new Error("The project media is missing or damaged.");

  for (const asset of data.assets) {
    if (asset.role === "media") validateMediaAsset(asset);
    else validateImageAsset(asset, asset.role);
  }
  const tracks: ProjectTrack[] = data.tracks.map((track) =>
    validateProjectTrack({
      id: track.id,
      file: files.get(track.mediaAssetId)!,
      duration: track.duration,
      range: track.range,
      title: track.title,
      artist: track.artist,
      subtitles: track.subtitles,
      artwork: track.artworkAssetId ? files.get(track.artworkAssetId)! : null,
    }),
  );
  const activeTrack = tracks.find((track) => track.id === data.activeTrackId)!;
  const timeline = buildPlaylistTimeline(tracks);
  const globalExportRange = data.exportRange ?? [0, timeline.duration];
  validateProjectRange(globalExportRange, timeline.duration);
  const releaseRecipe = data.releaseRecipe
    ? validateReleaseRecipe(data.releaseRecipe, globalExportRange)
    : undefined;
  const settings = resolveTrackMetadata(migrateSettings(data.settings), activeTrack);
  return {
    videoCompression: data.videoCompression,
    resolution: data.resolution,
    format: data.format,
    frameRate: data.frameRate,
    range: activeTrack.range,
    settings,
    migratedStyle:
      data.settings.mode === "ring" ||
      data.settings.mode === "spectrum" ||
      data.settings.mode === "edges"
        ? undefined
        : data.settings.mode,
    subtitles: activeTrack.subtitles,
    media: activeTrack.file,
    logo: logoMeta ? files.get(logoMeta.id)! : null,
    background: backgroundMeta ? files.get(backgroundMeta.id)! : null,
    artwork: activeTrack.artwork,
    tracks,
    activeTrackId: activeTrack.id,
    globalExportRange,
    releaseRecipe,
  } satisfies ProjectContent;
}

function validateProjectRange(range: [number, number], duration: number) {
  if (
    !Number.isFinite(range[0]) ||
    !Number.isFinite(range[1]) ||
    range[0] < 0 ||
    range[1] < range[0] ||
    range[1] > duration
  ) {
    throw new Error("This project has an invalid project-time range.");
  }
}

function validateReleaseRecipe(recipe: ReleaseRecipe, projectRange: [number, number]) {
  const parsed = releaseRecipeSchema.safeParse(recipe);
  if (!parsed.success) throw new Error("This project has an invalid release recipe.");
  for (const output of [parsed.data.fullVideo, parsed.data.portraitTeaser]) {
    if (
      output.range[0] < projectRange[0] ||
      output.range[1] > projectRange[1] ||
      (output.enabled && output.range[1] <= output.range[0])
    ) {
      throw new Error("A release video range must fit inside the selected project range.");
    }
  }
  if (
    parsed.data.thumbnail.time < projectRange[0] ||
    parsed.data.thumbnail.time > projectRange[1]
  ) {
    throw new Error("The release thumbnail time must fit inside the selected project range.");
  }
  return parsed.data;
}

function validateMediaAsset(asset: { name: string; type: string; size: number }) {
  const supported =
    asset.type.startsWith("audio/") ||
    asset.type.startsWith("video/") ||
    /\.(mp3|wav|m4a|aac|ogg|flac|opus|mp4|mov|webm|m4v)$/i.test(asset.name);
  if (!supported) throw new Error("The project contains an unsupported media file.");
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0)
    throw new Error("The project contains an invalid asset size.");
}

function validateImageAsset(
  asset: { name: string; type: string; size: number } | null,
  role: "logo" | "background" | "artwork" | "media",
  allowEmpty = false,
) {
  if (!asset) return;
  if (!Number.isSafeInteger(asset.size) || asset.size < 0 || (!allowEmpty && asset.size === 0))
    throw new Error("The project contains an invalid asset size.");
  const maxSize = role === "background" ? 20 * 1024 * 1024 : 8 * 1024 * 1024;
  const supportedTypes =
    role === "background"
      ? ["image/png", "image/jpeg", "image/webp", "image/avif"]
      : ["image/png", "image/jpeg", "image/webp"];
  if (asset.size > maxSize || !supportedTypes.includes(asset.type)) {
    const label =
      role === "background" ? "background image" : role === "artwork" ? "cover artwork" : "logo";
    throw new Error(`The project contains an unsupported ${label}.`);
  }
}
