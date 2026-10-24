import { defaultComposition, newElement } from "./model";
import { BUILTIN_LOOKS } from "../visual/customizer-config";
import { applyPreset } from "../visual/presets";
import type { VisualSettings } from "../visual/visual-settings-model";
import type { ExportAspect } from "../export/export-settings";
export function applyCreatorTemplate(
  id: "cover" | "portrait" | "square" | "dual",
  current: VisualSettings,
) {
  const mode = id === "dual" ? "radial" : id === "square" ? "spectrum" : "ring";
  const look = BUILTIN_LOOKS.find((item) => item.settings.mode === mode)!;
  const settings = { ...applyPreset(current, look.settings), showTrackInfo: false };
  const composition = defaultComposition();
  composition.visualizers[0].transform = {
    x: 0.5,
    y: id === "portrait" ? 0.31 : 0.44,
    width: 0.9,
    height: id === "portrait" ? 0.5 : 0.84,
    rotation: 0,
  };
  const title = newElement("text");
  if (title.type === "text") {
    title.binding = "title";
    title.name = "Track title";
    title.fontSize = 0.045;
    title.transform = {
      x: 0.5,
      y: id === "portrait" ? 0.64 : 0.12,
      width: 0.84,
      height: 0.1,
      rotation: 0,
    };
  }
  composition.elements.push(title);
  if (id === "dual") {
    composition.visualizers[0].transform = {
      x: 0.26,
      y: 0.48,
      width: 0.48,
      height: 0.8,
      rotation: 0,
    };
    composition.visualizers.push({
      ...composition.visualizers[0],
      id: "visualizer-2",
      name: "Visualizer 2",
      transform: { ...composition.visualizers[0].transform, x: 0.74 },
      palette: { primary: settings.secondary, secondary: settings.primary },
    });
  }
  composition.lyrics.animation = "fade";
  return {
    settings,
    composition,
    format: (id === "portrait"
      ? "portrait"
      : id === "square"
        ? "square"
        : "landscape") as ExportAspect,
  };
}
