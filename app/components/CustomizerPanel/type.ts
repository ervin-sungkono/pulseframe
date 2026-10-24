import type { ReactNode } from "react";
import type { CustomizerSection } from "@/lib/visual/customizer-config";
import type { VisualSettings } from "@/lib/visual/visual-settings-model";

export type CustomizerPanelProps = {
  settings: VisualSettings;
  quickLooks?: ReactNode;
  disabled?: boolean;
  assetsDisabled?: boolean;
  onPatch: (changes: Partial<VisualSettings>) => void;
  onResetSection: (section: CustomizerSection) => void;
  onChange: <K extends keyof VisualSettings>(
    key: K,
    value: VisualSettings[K],
    historyGroup?: string,
  ) => void;
  isVideo: boolean;
  onReset: () => void;
  logoName: string | null;
  logoUrl: string | null;
  onLogoFile: (file: File | null) => void;
  backgroundName: string | null;
  backgroundUrl: string | null;
  onBackgroundFile: (file: File | null) => void;
};
