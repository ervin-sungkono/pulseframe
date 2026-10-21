import { pulseRing } from "./pulse-ring";
import { spectrum } from "./spectrum";
import { edgeBars } from "./edge-bars";
import { radialSpectrum } from "./radial-spectrum";
import { liquidBlob } from "./liquid-blob";
import { spectralTerrain } from "./spectral-terrain";
import {
  DEFAULT_RADIAL_OPTIONS,
  DEFAULT_BLOB_OPTIONS,
  DEFAULT_TERRAIN_OPTIONS,
} from "../style-options";
import type { VisualMode } from "../visual-settings-model";
import type { VisualFrameContext } from "./types";

type Draw = (ctx: CanvasRenderingContext2D, frame: VisualFrameContext) => void;
export const VISUAL_STYLE_RENDERERS: Record<VisualMode, Draw> = {
  ring: (ctx, frame) => pulseRing.draw(ctx, frame, frame.settings),
  spectrum: (ctx, frame) => spectrum.draw(ctx, frame, frame.settings),
  edges: (ctx, frame) => edgeBars.draw(ctx, frame, frame.settings),
  radial: (ctx, frame) =>
    radialSpectrum.draw(ctx, frame, frame.settings.radialOptions ?? DEFAULT_RADIAL_OPTIONS),
  blob: (ctx, frame) =>
    liquidBlob.draw(ctx, frame, frame.settings.blobOptions ?? DEFAULT_BLOB_OPTIONS),
  terrain: (ctx, frame) =>
    spectralTerrain.draw(ctx, frame, frame.settings.terrainOptions ?? DEFAULT_TERRAIN_OPTIONS),
};

export function drawVisualStyle(ctx: CanvasRenderingContext2D, frame: VisualFrameContext) {
  VISUAL_STYLE_RENDERERS[frame.settings.mode](ctx, frame);
}
