import type { ExportFrameRate, ExportResolution } from "@/lib/export/export-settings";
import type { ExportProgress } from "@/lib/export/export-video";
import type { TimeRange } from "@/lib/export/export-time-estimate";

export type TimeFieldProps = {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  disabled: boolean;
};

export type ExportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  duration: number;
  range: [number, number];
  onRangeChange: (range: [number, number]) => void;
  dimensions: { width: number; height: number; label: string };
  resolution: ExportResolution;
  onResolutionChange: (resolution: ExportResolution) => void;
  videoCompression: boolean;
  onVideoCompressionChange: (enabled: boolean) => void;
  frameRate: ExportFrameRate;
  onFrameRateChange: (rate: ExportFrameRate) => void;
  exporting: boolean;
  progress: ExportProgress | null;
  estimateBeforeExport: TimeRange | null;
  onExport: () => void;
  onCancel: () => void;
  onPreview: () => void;
  exportReady?: boolean;
  exportHint?: string;
};
