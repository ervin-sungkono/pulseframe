import { z } from "zod";
import { compositionSchema } from "./composition";
import type { VisualSettings, VisualMode } from "./visual-settings-model";

const hexColorSchema = z.string().regex(/^#[\da-fA-F]{6}$/);
const placementSchema = z
  .object({
    x: z.number().finite().min(0).max(100),
    y: z.number().finite().min(0).max(100),
    size: z.number().finite().min(0).max(100),
  })
  .strict();
const modeMap = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ ring: value, spectrum: value, edges: value }).strict();
const promoStyleSchema = compositionSchema.shape.promo
  .removeDefault()
  .omit({ text: true, visible: true })
  .strict();
const artistCanvasCompositionSchema = z
  .object({
    layouts: compositionSchema.shape.layouts,
    artwork: compositionSchema.shape.artwork,
    background: compositionSchema.shape.background,
    captions: compositionSchema.shape.captions,
    promo: promoStyleSchema,
  })
  .strict();

export const artistProfileStyleSchema = z
  .object({
    palette: z
      .object({ primary: hexColorSchema, secondary: hexColorSchema, background: hexColorSchema })
      .strict(),
    typography: z
      .object({
        font: z.enum(["sans", "serif", "mono"]),
        weight: z.union([z.literal(500), z.literal(700)]),
        color: hexColorSchema,
        secondaryColor: hexColorSchema,
      })
      .strict(),
    composition: z
      .object({
        logoOpacity: z.number().finite().min(0).max(100),
        logoAutoFit: modeMap(z.boolean()),
        logoFitScale: modeMap(z.number().finite().min(50).max(100)),
        logoPlacements: modeMap(placementSchema),
        trackInfo: z
          .object({
            visible: z.boolean(),
            position: z.enum(["top", "center", "bottom"]),
            align: z.enum(["left", "center", "right"]),
            size: z.number().finite().min(0.5).max(2),
            style: z.enum(["shade", "card", "accent", "plain"]),
            opacity: z.number().finite().min(0).max(100),
            background: hexColorSchema,
            backgroundOpacity: z.number().finite().min(0).max(100),
            radius: z.number().finite().min(0).max(36),
          })
          .strict(),
        canvas: artistCanvasCompositionSchema,
      })
      .strict(),
  })
  .strict();

export type ArtistProfileStyle = z.infer<typeof artistProfileStyleSchema>;
export type ArtistProfileCanvasComposition = z.infer<typeof artistCanvasCompositionSchema>;
export type ArtistProfileAssetKind = "logo" | "background" | "artwork";
export type ArtistProfileAsset = { blob: Blob; name: string; type: string; size: number };
export type ArtistProfileAssets = Partial<Record<ArtistProfileAssetKind, ArtistProfileAsset>>;
export type ArtistProfileBranding = {
  defaultArtist: string;
  style: ArtistProfileStyle;
  assets: ArtistProfileAssets;
};
export type ArtistProfileSummary = {
  id: string;
  name: string;
  defaultArtist: string;
  style: ArtistProfileStyle;
  createdAt: number;
  updatedAt: number;
  revision: number;
};
export type ArtistProfile = ArtistProfileSummary & ArtistProfileBranding;
export type ArtistProfileDraft = {
  name: string;
  defaultArtist: string;
  style: ArtistProfileStyle;
  assets?: ArtistProfileAssets;
};
export type ArtistProfileApplication = {
  id: string;
  name: string;
  defaultArtist: string;
  applyDefaultArtist: boolean;
  style: ArtistProfileStyle;
  assets: ArtistProfileAssets;
};

export const artistProfileIdSchema = z.string().uuid();
export const artistProfileNameSchema = z.string().trim().min(1).max(80);
export const artistProfileRevisionSchema = z
  .number()
  .finite()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const artistNameSchema = z.string().max(120);
const assetDescriptorSchema = z
  .object({
    name: z.string().min(1).max(255),
    type: z.string().max(100),
    size: z.number().int().positive(),
  })
  .strict();

const draftSchema = z
  .object({
    name: artistProfileNameSchema,
    defaultArtist: artistNameSchema,
    style: artistProfileStyleSchema,
    assets: z
      .object({
        logo: z.unknown().optional(),
        background: z.unknown().optional(),
        artwork: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const modeNames: VisualMode[] = ["ring", "spectrum", "edges"];

/** Extract only the brand-facing subset; track text and audio response never enter the profile. */
export function artistProfileStyleFromSettings(settings: VisualSettings): ArtistProfileStyle {
  const composition = compositionSchema.parse(settings.composition ?? {});
  return artistProfileStyleSchema.parse({
    palette: {
      primary: settings.primary,
      secondary: settings.secondary,
      background: settings.background,
    },
    typography: {
      font: settings.infoFont,
      weight: settings.infoWeight,
      color: settings.infoColor,
      secondaryColor: settings.infoSecondaryColor,
    },
    composition: {
      logoOpacity: settings.logoOpacity,
      logoAutoFit: Object.fromEntries(modeNames.map((mode) => [mode, settings.logoAutoFit[mode]])),
      logoFitScale: Object.fromEntries(
        modeNames.map((mode) => [mode, settings.logoFitScale[mode]]),
      ),
      logoPlacements: Object.fromEntries(
        modeNames.map((mode) => [mode, { ...settings.logoPlacements[mode] }]),
      ),
      trackInfo: {
        visible: settings.showTrackInfo,
        position: settings.infoPosition,
        align: settings.infoAlign,
        size: settings.infoSize,
        style: settings.infoStyle,
        opacity: settings.infoOpacity,
        background: settings.infoBackground,
        backgroundOpacity: settings.infoBackgroundOpacity,
        radius: settings.infoRadius,
      },
      canvas: {
        layouts: composition.layouts,
        artwork: composition.artwork,
        background: composition.background,
        captions: composition.captions,
        promo: {
          color: composition.promo.color,
          background: composition.promo.background,
          backgroundOpacity: composition.promo.backgroundOpacity,
          font: composition.promo.font,
          weight: composition.promo.weight,
          size: composition.promo.size,
          align: composition.promo.align,
        },
      },
    },
  });
}

/** Merge saved branding into current settings while preserving all unrelated controls and text. */
export function applyArtistProfileStyle(current: VisualSettings, value: unknown): VisualSettings {
  const style = artistProfileStyleSchema.parse(value);
  const currentComposition = compositionSchema.parse(current.composition ?? {});
  const profileComposition = style.composition.canvas;
  return {
    ...current,
    composition: compositionSchema.parse({
      ...currentComposition,
      layouts: profileComposition.layouts,
      artwork: profileComposition.artwork,
      background: profileComposition.background,
      captions: profileComposition.captions,
      // Promo copy and visibility may belong to the current release; only branding style is reusable.
      promo: { ...currentComposition.promo, ...profileComposition.promo },
    }),
    primary: style.palette.primary,
    secondary: style.palette.secondary,
    background: style.palette.background,
    infoFont: style.typography.font,
    infoWeight: style.typography.weight,
    infoColor: style.typography.color,
    infoSecondaryColor: style.typography.secondaryColor,
    logoOpacity: style.composition.logoOpacity,
    logoAutoFit: { ...style.composition.logoAutoFit },
    logoFitScale: { ...style.composition.logoFitScale },
    logoPlacements: Object.fromEntries(
      modeNames.map((mode) => [mode, { ...style.composition.logoPlacements[mode] }]),
    ) as VisualSettings["logoPlacements"],
    showTrackInfo: style.composition.trackInfo.visible,
    infoPosition: style.composition.trackInfo.position,
    infoAlign: style.composition.trackInfo.align,
    infoSize: style.composition.trackInfo.size,
    infoStyle: style.composition.trackInfo.style,
    infoOpacity: style.composition.trackInfo.opacity,
    infoBackground: style.composition.trackInfo.background,
    infoBackgroundOpacity: style.composition.trackInfo.backgroundOpacity,
    infoRadius: style.composition.trackInfo.radius,
  };
}

export function validateArtistProfileDraft(value: unknown): ArtistProfileDraft {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) throw new Error("This artist profile contains invalid branding values.");
  const assets: ArtistProfileAssets = {};
  for (const kind of ["logo", "background", "artwork"] as const) {
    const candidate = parsed.data.assets?.[kind];
    if (candidate !== undefined) assets[kind] = validateArtistProfileAsset(kind, candidate);
  }
  return {
    name: parsed.data.name,
    defaultArtist: parsed.data.defaultArtist,
    style: artistProfileStyleSchema.parse(parsed.data.style),
    assets,
  };
}

export function validateArtistProfileAsset(
  kind: ArtistProfileAssetKind,
  value: unknown,
): ArtistProfileAsset {
  if (!value || typeof value !== "object") throw new Error("This profile image is invalid.");
  const candidate = value as Partial<ArtistProfileAsset>;
  const descriptor = assetDescriptorSchema.safeParse({
    name: candidate.name,
    type: candidate.type,
    size: candidate.size,
  });
  if (!descriptor.success || !(candidate.blob instanceof Blob))
    throw new Error("This profile image is invalid.");
  const maxSize = kind === "logo" ? 8 : 20;
  const allowedTypes =
    kind === "logo"
      ? ["image/png", "image/jpeg", "image/webp"]
      : ["image/png", "image/jpeg", "image/webp", "image/avif"];
  if (
    !allowedTypes.includes(descriptor.data.type) ||
    descriptor.data.size !== candidate.blob.size ||
    descriptor.data.size > maxSize * 1024 * 1024
  ) {
    throw new Error(`Choose a supported ${kind} image under ${maxSize} MB.`);
  }
  return { blob: candidate.blob, ...descriptor.data };
}
