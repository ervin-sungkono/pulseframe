import {
  artistProfileNameSchema,
  artistProfileStyleSchema,
  validateArtistProfileAsset,
  validateArtistProfileDraft,
  type ArtistProfileAssetKind,
  type ArtistProfileAssets,
  type ArtistProfileDraft,
} from "./artist-profile";

const MAGIC = "PFAP";
const HEADER_BYTES = 8;
const MAX_MANIFEST_BYTES = 128 * 1024;
export const MAX_ARTIST_PROFILE_FILE_BYTES = 48 * 1024 * 1024;
const ASSET_ORDER: ArtistProfileAssetKind[] = ["logo", "background", "artwork"];

type PortableManifest = {
  format: "pulseframe-artist-profile";
  version: 1;
  name: string;
  defaultArtist: string;
  style: ArtistProfileDraft["style"];
  assets: Partial<Record<ArtistProfileAssetKind, { name: string; type: string; size: number }>>;
};

/** Header + bounded JSON manifest + image bytes, matching the project-file framing pattern. */
export function makeArtistProfileFile(value: ArtistProfileDraft): Blob {
  const draft = validateArtistProfileDraft(value);
  const assets = draft.assets ?? {};
  const descriptors: PortableManifest["assets"] = {};
  let totalBytes = HEADER_BYTES;
  for (const kind of ASSET_ORDER) {
    const asset = assets[kind];
    if (!asset) continue;
    descriptors[kind] = { name: asset.name, type: asset.type, size: asset.size };
    totalBytes += asset.size;
  }
  const manifest: PortableManifest = {
    format: "pulseframe-artist-profile",
    version: 1,
    name: draft.name,
    defaultArtist: draft.defaultArtist,
    style: draft.style,
    assets: descriptors,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  totalBytes += manifestBytes.byteLength;
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES || totalBytes > MAX_ARTIST_PROFILE_FILE_BYTES)
    throw new Error("This profile file is too large to export.");
  const header = new Uint8Array(HEADER_BYTES);
  header.set(new TextEncoder().encode(MAGIC));
  new DataView(header.buffer).setUint32(4, manifestBytes.byteLength, true);
  return new Blob(
    [
      header,
      manifestBytes,
      ...ASSET_ORDER.flatMap((kind) => (assets[kind] ? [assets[kind]!.blob] : [])),
    ],
    { type: "application/x-pulseframe-artist-profile" },
  );
}

export async function readArtistProfileFile(file: Blob): Promise<ArtistProfileDraft> {
  if (file.size < HEADER_BYTES || file.size > MAX_ARTIST_PROFILE_FILE_BYTES)
    throw new Error("This is not a supported artist profile file.");
  const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  if (new TextDecoder().decode(header.slice(0, 4)) !== MAGIC)
    throw new Error("This is not a Pulseframe artist profile file.");
  const manifestLength = new DataView(header.buffer).getUint32(4, true);
  if (
    manifestLength === 0 ||
    manifestLength > MAX_MANIFEST_BYTES ||
    HEADER_BYTES + manifestLength > file.size
  ) {
    throw new Error("The artist profile header is damaged.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await file.slice(HEADER_BYTES, HEADER_BYTES + manifestLength).text());
  } catch {
    throw new Error("The artist profile details could not be read.");
  }
  const manifest = parseManifest(raw);
  let offset = HEADER_BYTES + manifestLength;
  const assets: ArtistProfileAssets = {};
  for (const kind of ASSET_ORDER) {
    const descriptor = manifest.assets[kind];
    if (!descriptor) continue;
    const end = offset + descriptor.size;
    if (end > file.size) throw new Error("An artist profile image is missing or damaged.");
    const blob = file.slice(offset, end, descriptor.type);
    assets[kind] = validateArtistProfileAsset(kind, { ...descriptor, blob });
    offset = end;
  }
  if (offset !== file.size) throw new Error("The artist profile contains unsupported extra data.");
  return validateArtistProfileDraft({
    name: manifest.name,
    defaultArtist: manifest.defaultArtist,
    style: manifest.style,
    assets,
  });
}

function parseManifest(value: unknown): PortableManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The artist profile details are invalid.");
  const manifest = value as Record<string, unknown>;
  const expectedKeys = ["format", "version", "name", "defaultArtist", "style", "assets"];
  if (
    Object.keys(manifest).some((key) => !expectedKeys.includes(key)) ||
    expectedKeys.some((key) => !(key in manifest))
  )
    throw new Error("This artist profile uses an unsupported format.");
  if (manifest.format !== "pulseframe-artist-profile" || manifest.version !== 1)
    throw new Error("This artist profile uses an unsupported format.");
  const name = artistProfileNameSchema.safeParse(manifest.name);
  if (
    !name.success ||
    typeof manifest.defaultArtist !== "string" ||
    manifest.defaultArtist.length > 120
  )
    throw new Error("The artist profile details are invalid.");
  const style = artistProfileStyleSchema.safeParse(manifest.style);
  if (!style.success) throw new Error("The artist profile contains invalid branding values.");
  if (!manifest.assets || typeof manifest.assets !== "object" || Array.isArray(manifest.assets))
    throw new Error("The artist profile image list is invalid.");
  const sourceAssets = manifest.assets as Record<string, unknown>;
  if (Object.keys(sourceAssets).some((key) => !ASSET_ORDER.includes(key as ArtistProfileAssetKind)))
    throw new Error("The artist profile contains an unsupported image type.");
  const parsedAssets: PortableManifest["assets"] = {};
  for (const kind of ASSET_ORDER) {
    const value = sourceAssets[kind];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("The artist profile image details are invalid.");
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["name", "type", "size"].includes(key)))
      throw new Error("The artist profile image details are invalid.");
    if (
      typeof row.name !== "string" ||
      row.name.length === 0 ||
      row.name.length > 255 ||
      typeof row.type !== "string" ||
      row.type.length > 100 ||
      typeof row.size !== "number" ||
      !Number.isSafeInteger(row.size) ||
      row.size <= 0
    ) {
      throw new Error("The artist profile image details are invalid.");
    }
    const sizeLimit = kind === "logo" ? 8 : 20;
    const types =
      kind === "logo"
        ? ["image/png", "image/jpeg", "image/webp"]
        : ["image/png", "image/jpeg", "image/webp", "image/avif"];
    if (row.size > sizeLimit * 1024 * 1024 || !types.includes(row.type))
      throw new Error(`The profile ${kind} image has an unsupported type or size.`);
    parsedAssets[kind] = { name: row.name, type: row.type, size: row.size };
  }
  return {
    format: "pulseframe-artist-profile",
    version: 1,
    name: name.data,
    defaultArtist: manifest.defaultArtist,
    style: style.data,
    assets: parsedAssets,
  };
}
