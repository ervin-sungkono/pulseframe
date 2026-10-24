import { createContext, useContext } from "react";
import type { BuiltinLook, CustomizerSection } from "@/lib/visual/customizer-config";
import type { SavedPreset } from "@/lib/visual/presets";
import type { VisualSettings } from "@/lib/visual/visual-settings-model";

export type EditorActions = {
  updateVisualSetting: <K extends keyof VisualSettings>(
    key: K,
    value: VisualSettings[K],
    historyGroup?: string,
  ) => void;
  patchVisualSettings: (changes: Partial<VisualSettings>) => void;
  resetVisualSection: (section: CustomizerSection) => void;
  resetAppearance: () => void;
  applyBuiltinLook: (look: BuiltinLook) => void;
  applySavedLook: (preset: SavedPreset) => void;
  undo: () => void;
  redo: () => void;
};

export const EditorActionsContext = createContext<EditorActions | undefined>(undefined);

export function useEditorActions() {
  const actions = useContext(EditorActionsContext);
  if (!actions) throw new Error("Editor actions must be used within the editor workspace.");
  return actions;
}
