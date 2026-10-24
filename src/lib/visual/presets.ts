import { z } from "zod";
import { settingsSchema, migrateSettings } from "./visual-settings";
import type { VisualSettings } from "./visual-settings-model";

export type PresetStyle = Omit<VisualSettings, "trackTitle" | "trackArtist">;
export type SavedPreset = {
  id: string;
  name: string;
  settings: PresetStyle;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  quickLookOrder: number;
  revision: number;
};
export const presetIdSchema = z.string().uuid();
export const presetNameSchema = z.string().trim().min(1).max(80);
export const quickLookOrderSchema = z
  .number()
  .finite()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const presetRevisionSchema = z
  .number()
  .finite()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export function presetStyle(value: unknown): PresetStyle {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("This preset has invalid settings.");
  const parsed = settingsSchema.safeParse({ ...value, trackTitle: "", trackArtist: "" });
  if (!parsed.success) throw new Error("This preset has invalid settings.");
  const style = migrateSettings(parsed.data);
  const { trackTitle: _title, trackArtist: _artist, ...settings } = style;
  void _title;
  void _artist;
  return settings;
}
export function applyPreset(current: VisualSettings, style: PresetStyle): VisualSettings {
  return {
    ...presetStyle(style),
    trackTitle: current.trackTitle,
    trackArtist: current.trackArtist,
  };
}
export const visualModeName = (mode: VisualSettings["mode"]) => {
  switch (mode) {
    case "ring":
      return "Pulse Ring";
    case "spectrum":
      return "Spectrum";
    case "edges":
      return "Edge Bars";
    case "radial":
      return "Radial Spectrum";
    case "terrain":
      return "Spectral Terrain";
  }
};
