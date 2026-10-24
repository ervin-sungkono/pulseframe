import type { Composition, CreativeElement } from "@/lib/composition/model";
import type { VisualSettings } from "@/lib/visual/visual-settings-model";

export type CompositionPanelProps = {
  composition: Composition;
  settings: VisualSettings;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onEditSubtitles?: () => void;
  onChange(composition: Composition, group?: string): void;
  onAddImage(file: File): void;
  onTemplate(id: "cover" | "portrait" | "square" | "dual"): void;
  variant: "layers" | "inspector";
  disabled?: boolean;
  assetsDisabled?: boolean;
};

export type EditableElement = Extract<CreativeElement, { type: "text" | "shape" | "image" }>;
export type ElementKind = "text" | "rectangle" | "ellipse";
