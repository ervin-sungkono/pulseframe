export type VisualMode = "ring" | "spectrum" | "edges";
export type ParticleMode = "stardust" | "sparks" | "constellation" | "comets";
export type BackdropMode = "nebula" | "grid" | "clean";
export type ParticleFlow = "drift" | "rise" | "orbit";
export type ResponseStyle = "punchy" | "balanced" | "smooth";
export type BeatLighting = "rays" | "aura" | "beams" | "edges";
export type LogoPlacement = { x: number; y: number; size: number };

export type VisualSettings = {
  mode: VisualMode;
  spectrumRoundness: number;
  spectrumReflection: number;
  ringLayers: number;
  ringRearOpacity: number;
  ringMirror: boolean;
  ringFocus: "auto" | "bass" | "full";
  particleMode: ParticleMode;
  particleFlow: ParticleFlow;
  backdrop: BackdropMode;
  primary: string;
  secondary: string;
  background: string;
  sensitivity: number;
  quietThreshold: number;
  bassBoost: number;
  responseStyle: ResponseStyle;
  atmosphere: number;
  particleCount: number;
  glow: number;
  visualScale: number;
  motionSpeed: number;
  particleSize: number;
  beatRays: boolean;
  beatLighting: BeatLighting;
  beatLightingIntensity: number;
  trails: boolean;
  particles: boolean;
  videoOpacity: number;
  backgroundOpacity: number;
  dropEffects: boolean;
  glitch: boolean;
  glitchStrength: number;
  logoOpacity: number;
  logoAutoFit: Record<VisualMode, boolean>;
  logoFitScale: Record<VisualMode, number>;
  logoPlacements: Record<VisualMode, LogoPlacement>;
  showTrackInfo: boolean;
  trackTitle: string;
  trackArtist: string;
  infoPosition: "top" | "center" | "bottom";
  infoAlign: "left" | "center" | "right";
  infoSize: number;
  infoStyle: "shade" | "card" | "accent" | "plain";
  infoFont: "sans" | "serif" | "mono";
  infoWeight: 500 | 700;
  infoColor: string;
  infoSecondaryColor: string;
  infoOpacity: number;
  infoBackground: string;
  infoBackgroundOpacity: number;
  infoRadius: number;
  showTimer: boolean;
};

export const DEFAULT_LOGO_PLACEMENTS: Record<VisualMode, LogoPlacement> = {
  ring: { x: 50, y: 50, size: 26 },
  spectrum: { x: 50, y: 25, size: 17 },
  edges: { x: 50, y: 50, size: 20 },
};

export const DEFAULT_LOGO_AUTO_FIT: Record<VisualMode, boolean> = {
  ring: true,
  spectrum: true,
  edges: true,
};

export const DEFAULT_LOGO_FIT_SCALE: Record<VisualMode, number> = {
  ring: 100,
  spectrum: 100,
  edges: 100,
};
