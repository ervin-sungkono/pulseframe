export const EXPORT_RESOLUTIONS = [480, 720, 1080, 1440] as const;
export type ExportResolution = typeof EXPORT_RESOLUTIONS[number];
export type ExportAspect = "landscape" | "portrait" | "square";

/** The selected resolution is the short edge, or either edge for square video. */
export function exportDimensions(format: ExportAspect, resolution: ExportResolution) {
  if (!EXPORT_RESOLUTIONS.includes(resolution)) throw new Error("Unsupported export resolution.");
  const longEdge = Math.round(resolution * 16 / 9 / 2) * 2;
  if (format === "landscape") return { width: longEdge, height: resolution, label: "16:9" };
  if (format === "portrait") return { width: resolution, height: longEdge, label: "9:16" };
  return { width: resolution, height: resolution, label: "1:1" };
}

// A small reduction from Mediabunny's high (0.75) quality level. Constant
// quality uses quantizers where supported and a variable-bitrate fallback.
export const COMPRESSED_VIDEO_QUALITY = 0.68;
