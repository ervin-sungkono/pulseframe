import { BUILTIN_LOOKS } from "@/lib/visual/customizer-config";
import type { PresetLibrary } from "@/lib/hooks/use-presets";
import type { PresetStyle, SavedPreset } from "@/lib/visual/presets";
import type { VisualSettings } from "@/lib/visual/visual-settings-model";

export type ActiveLook = {
  id: string;
  name: string;
  settings: PresetStyle;
  preset?: SavedPreset;
};

export type BuiltinLook = (typeof BUILTIN_LOOKS)[number];

export type QuickLookStripProps = {
  settings: VisualSettings;
  library: PresetLibrary;
  active: ActiveLook | null;
  modified: boolean;
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onApplyBuiltin: (look: BuiltinLook) => void;
  onApplyPreset: (preset: SavedPreset) => void;
  onSave: () => void;
  onUpdate: (preset: SavedPreset) => void;
  onManage: () => void;
  onPresetChanged: (preset: SavedPreset) => void;
};
