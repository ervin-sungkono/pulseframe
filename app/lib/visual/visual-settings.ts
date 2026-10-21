import { z } from "zod";
import {
  DEFAULT_LOGO_AUTO_FIT,
  DEFAULT_LOGO_FIT_SCALE,
  DEFAULT_LOGO_PLACEMENTS,
  VISUAL_MODES,
  type VisualSettings,
  type VisualMode,
} from "./visual-settings-model";
import {
  DEFAULT_BLOB_OPTIONS,
  DEFAULT_RADIAL_OPTIONS,
  DEFAULT_TERRAIN_OPTIONS,
} from "./style-options";

const retiredVisualModes = ["halo", "wave", "tunnel", "aurora", "bloom"] as const;
const visualModes = [...VISUAL_MODES, ...retiredVisualModes] as const;

const percent = z.number().finite();
const color = z.string().regex(/^#[\da-fA-F]{6}$/);
// Placement values are percentages. The full 0–100 range also preserves older
// custom layouts that were valid in the old UI's wider-than-default controls.
const placement = z.object({
  x: percent.min(0).max(100),
  y: percent.min(0).max(100),
  size: percent.min(0).max(100),
});
export const settingsSchema = z.object({
  mode: z.enum(visualModes),
  radialOptions: z
    .object({
      barCount: z.number().int().min(32).max(160).default(DEFAULT_RADIAL_OPTIONS.barCount),
      innerRadius: percent.min(10).max(40).default(DEFAULT_RADIAL_OPTIONS.innerRadius),
      maxBarLength: percent.min(5).max(35).default(DEFAULT_RADIAL_OPTIONS.maxBarLength),
      barWidth: percent.min(20).max(100).default(DEFAULT_RADIAL_OPTIONS.barWidth),
      roundness: percent.min(0).max(100).default(DEFAULT_RADIAL_OPTIONS.roundness),
      direction: z.enum(["clockwise", "mirrored"]).default(DEFAULT_RADIAL_OPTIONS.direction),
      rotationSpeed: percent.min(-100).max(100).default(DEFAULT_RADIAL_OPTIONS.rotationSpeed),
      variant: z.enum(["outward", "inward", "both"]).default(DEFAULT_RADIAL_OPTIONS.variant),
    })
    .default({}),
  blobOptions: z
    .object({
      size: percent.min(50).max(150).default(DEFAULT_BLOB_OPTIONS.size),
      deformation: percent.min(0).max(100).default(DEFAULT_BLOB_OPTIONS.deformation),
      fluidity: percent.min(0).max(100).default(DEFAULT_BLOB_OPTIONS.fluidity),
      detail: z.enum(["low", "medium", "high"]).default(DEFAULT_BLOB_OPTIONS.detail),
      bassExpansion: percent.min(0).max(100).default(DEFAULT_BLOB_OPTIONS.bassExpansion),
      internalGlow: percent.min(0).max(100).default(DEFAULT_BLOB_OPTIONS.internalGlow),
      idleMotion: z.enum(["off", "subtle", "active"]).default(DEFAULT_BLOB_OPTIONS.idleMotion),
    })
    .default({}),
  terrainOptions: z
    .object({
      height: percent.min(0).max(100).default(DEFAULT_TERRAIN_OPTIONS.height),
      historySeconds: percent.min(2).max(10).default(DEFAULT_TERRAIN_OPTIONS.historySeconds),
      density: z.enum(["low", "medium", "high"]).default(DEFAULT_TERRAIN_OPTIONS.density),
      perspective: z.enum(["low", "medium", "high"]).default(DEFAULT_TERRAIN_OPTIONS.perspective),
      travelSpeed: percent.min(0).max(200).default(DEFAULT_TERRAIN_OPTIONS.travelSpeed),
      wireOpacity: percent.min(0).max(100).default(DEFAULT_TERRAIN_OPTIONS.wireOpacity),
      surfaceFill: percent.min(0).max(100).default(DEFAULT_TERRAIN_OPTIONS.surfaceFill),
    })
    .default({}),
  spectrumRoundness: percent.min(0).max(100).default(100),
  spectrumReflection: percent.min(0).max(100).default(45),
  ringLayers: z.number().int().min(1).max(4).default(3),
  ringRearOpacity: percent.min(0).max(100).default(30),
  ringMirror: z.boolean().default(false),
  ringFocus: z.enum(["auto", "bass", "full"]).default("bass"),
  particleMode: z.enum(["stardust", "sparks", "constellation", "comets"]),
  particleFlow: z.enum(["drift", "rise", "orbit"]),
  backdrop: z.enum(["nebula", "grid", "clean"]),
  primary: color,
  secondary: color,
  background: color,
  sensitivity: percent.min(0.2).max(3),
  quietThreshold: percent.min(0).max(0.1),
  bassBoost: percent.min(0.2).max(3),
  responseStyle: z.enum(["punchy", "balanced", "smooth"]),
  atmosphere: percent.min(0).max(2),
  particleCount: z.number().int().min(0).max(300),
  glow: percent.min(0).max(2.5),
  visualScale: percent.min(0.5).max(1.5),
  motionSpeed: percent.min(0.1).max(3),
  particleSize: percent.min(0.25).max(3),
  beatRays: z.boolean(),
  beatLighting: z.enum(["rays", "aura", "beams", "edges"]).default("rays"),
  beatLightingIntensity: percent.min(0).max(100).default(65),
  trails: z.boolean(),
  particles: z.boolean(),
  videoOpacity: percent.min(0).max(100),
  backgroundOpacity: percent.min(0).max(100).default(25),
  dropEffects: z.boolean().default(false),
  glitch: z.boolean().default(false),
  glitchStrength: percent.min(0.1).max(1).default(0.35),
  logoOpacity: percent.min(0).max(100),
  logoAutoFit: z.record(z.enum(visualModes), z.boolean()).default({}),
  logoFitScale: z.record(z.enum(visualModes), percent.min(50).max(100)).default({}),
  logoPlacements: z.record(z.enum(visualModes), placement).default({}),
  showTrackInfo: z.boolean(),
  trackTitle: z.string().max(120),
  trackArtist: z.string().max(120),
  infoPosition: z.enum(["top", "center", "bottom"]),
  infoAlign: z.enum(["left", "center", "right"]),
  infoStyle: z.enum(["shade", "card", "accent", "plain"]).default("shade"),
  infoFont: z.enum(["sans", "serif", "mono"]).default("sans"),
  infoWeight: z.union([z.literal(500), z.literal(700)]).default(700),
  infoColor: color.default("#ffffff"),
  infoSecondaryColor: color.default("#c8d0e5"),
  infoOpacity: percent.min(0).max(100).default(100),
  infoBackground: color.default("#040816"),
  infoBackgroundOpacity: percent.min(0).max(100).default(55),
  infoRadius: percent.min(0).max(36).default(16),
  infoSize: percent.min(0.5).max(2),
  showTimer: z.boolean(),
});
// Older projects keep their selected logo layout when a retired style is mapped.
export function migrateSettings(settings: z.infer<typeof settingsSchema>): VisualSettings {
  const oldMode = settings.mode;
  const legacyModeMap = {
    halo: "ring",
    tunnel: "ring",
    bloom: "ring",
    wave: "spectrum",
    aurora: "spectrum",
  } as const satisfies Record<(typeof retiredVisualModes)[number], VisualMode>;
  const mode: VisualMode = VISUAL_MODES.includes(oldMode as VisualMode)
    ? (oldMode as VisualMode)
    : legacyModeMap[oldMode as keyof typeof legacyModeMap];
  const layouts = <T>(
    stored: Partial<Record<(typeof visualModes)[number], T>>,
    defaults: Record<VisualMode, T>,
  ) => {
    const result = Object.fromEntries(
      VISUAL_MODES.map((visualMode) => [visualMode, stored[visualMode] ?? defaults[visualMode]]),
    ) as Record<VisualMode, T>;
    result[mode] = stored[oldMode] ?? result[mode] ?? defaults[mode];
    return result;
  };
  return {
    ...settings,
    mode,
    logoAutoFit: layouts(settings.logoAutoFit, DEFAULT_LOGO_AUTO_FIT),
    logoFitScale: layouts(settings.logoFitScale, DEFAULT_LOGO_FIT_SCALE),
    logoPlacements: layouts(settings.logoPlacements, DEFAULT_LOGO_PLACEMENTS),
  };
}
