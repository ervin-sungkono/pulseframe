import type { ReactNode } from "react";
import type { VisualSettings } from "@/lib/visual/visual-settings-model";

export type CustomizerPanelProps = {
  settings: VisualSettings;
  quickLooks?: ReactNode;
  disabled?: boolean;
  assetsDisabled?: boolean;
  isVideo: boolean;
  logoName: string | null;
  logoUrl: string | null;
  onLogoFile: (file: File | null) => void;
  backgroundName: string | null;
  backgroundUrl: string | null;
  onBackgroundFile: (file: File | null) => void;
};
