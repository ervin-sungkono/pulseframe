import type {
  BackdropMode,
  MotionPreset,
  ParticleMode,
  VisualMode,
} from "@/lib/visual/visual-settings-model";

export const modes: { id: VisualMode; name: string; description: string }[] = [
  { id: "ring", name: "Pulse Ring", description: "Layered solid waves" },
  { id: "spectrum", name: "Spectrum", description: "Bars with a soft reflection" },
  { id: "edges", name: "Edge Bars", description: "Opposite frequency directions" },
  { id: "radial", name: "Radial Spectrum", description: "Frequency bars around a center" },
  { id: "terrain", name: "Spectral Terrain", description: "A scrolling sound landscape" },
];

export const fitTargets: Record<VisualMode, string> = {
  ring: "inner circle",
  spectrum: "upper frame",
  edges: "center frame",
  radial: "center aperture",
  terrain: "upper frame",
};

export const particleModes: ParticleMode[] = ["stardust", "sparks", "constellation", "comets"];

export const motionPresets: { id: MotionPreset; label: string }[] = [
  { id: "none", label: "None" },
  { id: "orbit", label: "Orbit" },
  { id: "bounce", label: "Bounce" },
  { id: "drift", label: "Drift" },
  { id: "rotate", label: "Rotate" },
  { id: "zoom", label: "Zoom" },
  { id: "beat", label: "Beat jump" },
];

export const backdrops: { id: BackdropMode; label: string }[] = [
  { id: "nebula", label: "Nebula" },
  { id: "grid", label: "Grid" },
  { id: "clean", label: "Clean" },
];
