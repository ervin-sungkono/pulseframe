export const EXPORT_ASPECTS = ["landscape", "portrait", "square"] as const;
export type ExportAspect = (typeof EXPORT_ASPECTS)[number];

export const EXPORT_RESOLUTIONS = [480, 720, 1080, 1440, 2160] as const;
export type ExportResolution = (typeof EXPORT_RESOLUTIONS)[number];
export const DEFAULT_EXPORT_RESOLUTION = 720 satisfies ExportResolution;

export const EXPORT_FRAME_RATES = [24, 30, 60] as const;
export type ExportFrameRate = (typeof EXPORT_FRAME_RATES)[number];
export const DEFAULT_EXPORT_FRAME_RATE = 30 satisfies ExportFrameRate;

/** The selected resolution is the short edge, or either edge for square video. */
export function exportDimensions(format: ExportAspect, resolution: ExportResolution) {
  if (!EXPORT_RESOLUTIONS.includes(resolution)) throw new Error("Unsupported export resolution.");
  if (format !== "landscape" && format !== "portrait" && format !== "square")
    throw new Error("Unsupported export format.");
  const longEdge = Math.round((resolution * 16) / 9 / 2) * 2;
  if (format === "landscape") return { width: longEdge, height: resolution, label: "16:9" };
  if (format === "portrait") return { width: resolution, height: longEdge, label: "9:16" };
  return { width: resolution, height: resolution, label: "1:1" };
}

export function isSupportedExportDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  return EXPORT_RESOLUTIONS.some((resolution) =>
    (EXPORT_ASPECTS as readonly ExportAspect[]).some((format) => {
      const dimensions = exportDimensions(format, resolution);
      return dimensions.width === width && dimensions.height === height;
    }),
  );
}

// A small reduction from Mediabunny's high (0.75) quality level. Constant
// quality uses quantizers where supported and a variable-bitrate fallback.
export const COMPRESSED_VIDEO_QUALITY = 0.68;
