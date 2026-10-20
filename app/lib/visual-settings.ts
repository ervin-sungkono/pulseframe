import { z } from "zod";
import {
  DEFAULT_LOGO_AUTO_FIT,
  DEFAULT_LOGO_FIT_SCALE,
  DEFAULT_LOGO_PLACEMENTS,
  type VisualSettings,
} from "./visual-settings-model";

const visualModes = [
  "halo",
  "ring",
  "spectrum",
  "wave",
  "tunnel",
  "aurora",
  "bloom",
  "edges",
] as const;

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
  const mode =
    settings.mode === "edges"
      ? "edges"
      : ["wave", "aurora", "spectrum"].includes(settings.mode)
        ? "spectrum"
        : "ring";
  const oldMode = settings.mode;
  const layouts = <T>(
    stored: Partial<Record<(typeof visualModes)[number], T>>,
    defaults: Record<"ring" | "spectrum" | "edges", T>,
  ) => ({
    ring: stored.ring ?? defaults.ring,
    spectrum: stored.spectrum ?? defaults.spectrum,
    edges: stored.edges ?? defaults.edges,
    [mode]: stored[oldMode] ?? stored[mode] ?? defaults[mode],
  });
  return {
    ...settings,
    mode,
    logoAutoFit: layouts(settings.logoAutoFit, DEFAULT_LOGO_AUTO_FIT),
    logoFitScale: layouts(settings.logoFitScale, DEFAULT_LOGO_FIT_SCALE),
    logoPlacements: layouts(settings.logoPlacements, DEFAULT_LOGO_PLACEMENTS),
  };
}
