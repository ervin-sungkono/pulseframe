import type { VisualMode, VisualSettings } from "../visual-settings-model";

/** Calibrated linear-amplitude bands, sampled at absolute source time. */
export interface FrequencyHistory {
  /** Fills target, returning false when that source time was not measured. */
  read(time: number, target: Float32Array, quietThreshold: number): boolean;
}

export type VisualFrameContext = {
  width: number;
  height: number;
  time: number;
  sampleRate: number;
  settings: Readonly<VisualSettings>;
  reducedMotion: boolean;
  fittedLogo: boolean;
  captionHeight: number;
  audio: {
    activity: number;
    bass: number;
    mid: number;
    treble: number;
    energy: number;
    impact: number;
    bands: readonly Float32Array[];
    bandLayers: Float32Array[][];
    ringMix: number;
  };
  history?: FrequencyHistory;
};

export interface VisualStyleRenderer<Options> {
  readonly id: VisualMode;
  draw(ctx: CanvasRenderingContext2D, frame: VisualFrameContext, options: Options): void;
}
