import type { PresetStyle } from "./presets";
import {
  DEFAULT_LOGO_AUTO_FIT,
  DEFAULT_LOGO_FIT_SCALE,
  DEFAULT_LOGO_PLACEMENTS,
  type VisualSettings,
} from "./visualizer";

export type CustomizerSection = "visual" | "colors" | "motion" | "audio" | "logo" | "track";

export const SECTION_KEYS: Record<CustomizerSection, readonly (keyof VisualSettings)[]> = {
  visual: ["mode", "spectrumRoundness", "spectrumReflection", "ringLayers", "ringRearOpacity", "ringMirror", "ringFocus", "visualScale"],
  colors: ["primary", "secondary", "background", "backdrop", "atmosphere", "backgroundOpacity", "videoOpacity"],
  motion: ["motionSpeed", "particleMode", "particleFlow", "particleSize", "particleCount", "particles", "trails", "beatRays", "beatLighting", "beatLightingIntensity", "glow", "glitch", "glitchStrength"],
  audio: ["sensitivity", "quietThreshold", "bassBoost", "responseStyle", "dropEffects"],
  logo: ["logoOpacity", "logoAutoFit", "logoFitScale", "logoPlacements"],
  track: ["showTrackInfo", "trackTitle", "trackArtist", "infoPosition", "infoAlign", "infoSize", "infoStyle", "infoFont", "infoWeight", "infoColor", "infoSecondaryColor", "infoOpacity", "infoBackground", "infoBackgroundOpacity", "infoRadius", "showTimer"],
};

export function sectionResetChanges(section: CustomizerSection): Partial<VisualSettings> {
  const changes: Partial<VisualSettings> = {};
  const keys = SECTION_KEYS[section].filter(key => section !== "track" || (key !== "trackTitle" && key !== "trackArtist"));
  for (const key of keys) {
    (changes as Record<keyof VisualSettings, VisualSettings[keyof VisualSettings]>)[key] = DEFAULT_SETTINGS[key];
  }
  return changes;
}

export const palettes = [
  { name: "Electric", primary: "#9b72ff", secondary: "#61e5ff", background: "#080c20" },
  { name: "Afterglow", primary: "#ff688e", secondary: "#ffbd6a", background: "#190c21" },
  { name: "Aqua", primary: "#36e7d2", secondary: "#79a8ff", background: "#061921" },
  { name: "Solar", primary: "#ffc85c", secondary: "#fc728a", background: "#1b1020" },
  { name: "Violet", primary: "#d875ff", secondary: "#83ffdd", background: "#110a24" },
  { name: "Monochrome", primary: "#e3e7ff", secondary: "#7e8bc0", background: "#070a13" },
] as const;

export const DEFAULT_SETTINGS: VisualSettings = {
  mode: "ring", spectrumRoundness: 100, spectrumReflection: 45, ringLayers: 3, ringRearOpacity: 30, ringMirror: true, ringFocus: "full", particleMode: "stardust", particleFlow: "drift", primary: palettes[0].primary,
  secondary: palettes[0].secondary, background: palettes[0].background,
  backdrop: "nebula", sensitivity: 1.3, quietThreshold: .006, bassBoost: 1, responseStyle: "balanced", atmosphere: 1, particleCount: 120, glow: .95,
  visualScale: 1.1, motionSpeed: 1, particleSize: 1,
  trails: true, beatRays: true, beatLighting: "rays", beatLightingIntensity: 65, particles: true, videoOpacity: 55,
  backgroundOpacity: 25, dropEffects: true,
  glitch: false, glitchStrength: .35,
  logoOpacity: 100, logoAutoFit: DEFAULT_LOGO_AUTO_FIT, logoFitScale: DEFAULT_LOGO_FIT_SCALE, logoPlacements: DEFAULT_LOGO_PLACEMENTS,
  showTrackInfo: false, trackTitle: "", trackArtist: "", infoPosition: "top", infoAlign: "left", infoSize: 1, infoStyle: "shade", infoFont: "sans", infoWeight: 700, infoColor: "#ffffff", infoSecondaryColor: "#c8d0e5", infoOpacity: 100, infoBackground: "#040816", infoBackgroundOpacity: 55, infoRadius: 16, showTimer: false,
};

export type BuiltinLook = { id: string; name: string; caption: string; settings: PresetStyle };

function makeStyle(changes: Partial<VisualSettings>): PresetStyle {
  const normalized: VisualSettings = {
    ...DEFAULT_SETTINGS,
    ...changes,
    logoAutoFit: { ...DEFAULT_SETTINGS.logoAutoFit, ...changes.logoAutoFit },
    logoFitScale: { ...DEFAULT_SETTINGS.logoFitScale, ...changes.logoFitScale },
    logoPlacements: {
      ring: { ...DEFAULT_SETTINGS.logoPlacements.ring, ...changes.logoPlacements?.ring },
      spectrum: { ...DEFAULT_SETTINGS.logoPlacements.spectrum, ...changes.logoPlacements?.spectrum },
      edges: { ...DEFAULT_SETTINGS.logoPlacements.edges, ...changes.logoPlacements?.edges },
    },
  };
  const { trackTitle: _trackTitle, trackArtist: _trackArtist, ...style } = normalized;
  void _trackTitle;
  void _trackArtist;
  return style;
}

const lookDefinitions: Array<Omit<BuiltinLook, "settings"> & { changes: Partial<VisualSettings> }> = [
  { id: "contour", name: "Contour", caption: "Layered pulse ring", changes: { mode: "ring", primary: palettes[0].primary, secondary: palettes[0].secondary, background: palettes[0].background, backdrop: "clean", particleMode: "stardust", trails: false, beatRays: true, beatLighting: "rays", beatLightingIntensity: 65, glow: .95 } },
  { id: "pulse", name: "Pulse", caption: "Electric waves", changes: { mode: "ring", primary: palettes[0].primary, secondary: palettes[0].secondary, background: palettes[0].background, backdrop: "nebula", particleMode: "stardust", trails: true, beatRays: true, beatLighting: "aura", beatLightingIntensity: 65, glow: .95 } },
  { id: "after-hours", name: "After Hours", caption: "Neon bars", changes: { mode: "spectrum", primary: palettes[1].primary, secondary: palettes[1].secondary, background: palettes[1].background, backdrop: "grid", particleMode: "sparks", trails: false, beatRays: true, beatLighting: "beams", beatLightingIntensity: 65, glow: 1.2 } },
  { id: "tidal", name: "Tidal", caption: "Aqua waves", changes: { mode: "ring", primary: palettes[2].primary, secondary: palettes[2].secondary, background: palettes[2].background, backdrop: "nebula", particleMode: "constellation", trails: false, beatRays: false, beatLighting: "aura", beatLightingIntensity: 65, glow: 1.05 } },
  { id: "solar-flare", name: "Solar Flare", caption: "Warm pulse ring", changes: { mode: "ring", primary: palettes[3].primary, secondary: palettes[3].secondary, background: palettes[3].background, backdrop: "nebula", particleMode: "comets", trails: true, beatRays: true, beatLighting: "edges", beatLightingIntensity: 65, glow: 1.15 } },
  { id: "prism", name: "Prism", caption: "Violet bars", changes: { mode: "spectrum", primary: palettes[4].primary, secondary: palettes[4].secondary, background: palettes[4].background, backdrop: "clean", particleMode: "sparks", trails: false, beatRays: false, beatLighting: "aura", beatLightingIntensity: 65, glow: 1.25 } },
  { id: "eclipse", name: "Eclipse", caption: "Minimal bars", changes: { mode: "spectrum", primary: palettes[5].primary, secondary: palettes[5].secondary, background: palettes[5].background, backdrop: "clean", particleMode: "comets", trails: false, beatRays: true, beatLighting: "edges", beatLightingIntensity: 65, glow: .85 } },
  { id: "counterflow", name: "Counterflow", caption: "Opposing frequency bars", changes: { mode: "edges", primary: palettes[2].primary, secondary: palettes[1].secondary, background: palettes[2].background, backdrop: "grid", particleMode: "comets", trails: true, beatRays: false, glow: 1.1 } },
];

export const BUILTIN_LOOKS: BuiltinLook[] = lookDefinitions.map(({ changes, ...look }) => ({ ...look, settings: makeStyle(changes) }));
