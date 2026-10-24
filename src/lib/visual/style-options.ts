export type RadialOptions = {
  barCount: number;
  innerRadius: number;
  maxBarLength: number;
  barWidth: number;
  roundness: number;
  direction: "clockwise" | "mirrored";
  rotationSpeed: number;
  variant: "outward" | "inward" | "both";
};
export type TerrainOptions = {
  height: number;
  historySeconds: number;
  density: "low" | "medium" | "high";
  perspective: "low" | "medium" | "high";
  travelSpeed: number;
  wireOpacity: number;
  surfaceFill: number;
};
export const DEFAULT_RADIAL_OPTIONS: RadialOptions = {
  barCount: 96,
  innerRadius: 25,
  maxBarLength: 20,
  barWidth: 65,
  roundness: 80,
  direction: "clockwise",
  rotationSpeed: 0,
  variant: "outward",
};
export const DEFAULT_TERRAIN_OPTIONS: TerrainOptions = {
  height: 60,
  historySeconds: 5,
  density: "medium",
  perspective: "medium",
  travelSpeed: 100,
  wireOpacity: 75,
  surfaceFill: 20,
};
