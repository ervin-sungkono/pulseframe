import type { PresetLibrary } from "@/lib/hooks/use-presets";
import type { SavedPreset } from "@/lib/visual/presets";
import type { VisualSettings } from "@/lib/visual/visual-settings-model";

export type PresetDialogProps = {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  settings: VisualSettings;
  library: PresetLibrary;
  currentPreset?: SavedPreset | null;
  onSaved?: (preset: SavedPreset) => void;
  onMetadataChanged?: (preset: SavedPreset) => void;
  onDeleted?: (id: string) => void;
  onHelp: () => void;
};
