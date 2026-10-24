import type { PresetLibrary } from "@/lib/hooks/use-presets";
import type { PresetStyle, SavedPreset } from "@/lib/visual/presets";
import type { VisualSettings } from "@/lib/visual/visual-settings-model";

export type SaveDraft = {
  id: string;
  settings: PresetStyle;
  target: SavedPreset | null;
};

export type PresetSaveDialogProps = {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  settings: VisualSettings;
  library: PresetLibrary;
  pinned?: boolean;
  target?: SavedPreset | null;
  onSaved?: (preset: SavedPreset) => void;
};
