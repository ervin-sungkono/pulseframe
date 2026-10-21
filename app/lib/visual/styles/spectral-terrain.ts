import { DEFAULT_TERRAIN_OPTIONS, type TerrainOptions } from "../style-options";
import { clamp, finite, rgba } from "./shared";
import type { FrequencyHistory, VisualFrameContext, VisualStyleRenderer } from "./types";

export type TerrainResolution = { columns: number; rows: number };

const RESOLUTIONS: Record<TerrainOptions["density"], TerrainResolution> = {
  low: { columns: 32, rows: 24 },
  medium: { columns: 48, rows: 40 },
  high: { columns: 64, rows: 64 },
};

export function terrainResolution(density: TerrainOptions["density"]): TerrainResolution {
  return RESOLUTIONS[density] ?? RESOLUTIONS.medium;
}

export type TerrainSampleBuffer = {
  columns: number;
  rows: number;
  /** Calibrated linear amplitudes, indexed by row then frequency column. */
  levels: Float32Array;
  /** Absolute source timestamp for each row, oldest to newest. */
  times: Float64Array;
  /** One byte per row: 1 means measured or supplied by the current-frame fallback. */
  knownRows: Uint8Array;
  /** Temporary target passed to the history provider for each row. */
  readTarget: Float32Array;
};

export function createTerrainSampleBuffer(columns: number, rows: number): TerrainSampleBuffer {
  const safeColumns = Math.max(1, Math.min(64, Math.floor(finite(columns, 1))));
  const safeRows = Math.max(1, Math.min(64, Math.floor(finite(rows, 1))));
  return {
    columns: safeColumns,
    rows: safeRows,
    levels: new Float32Array(safeColumns * safeRows),
    times: new Float64Array(safeRows),
    knownRows: new Uint8Array(safeRows),
    readTarget: new Float32Array(safeColumns),
  };
}

function validSampleBuffer(buffer: TerrainSampleBuffer | undefined, columns: number, rows: number) {
  return (
    buffer &&
    buffer.columns === columns &&
    buffer.rows === rows &&
    buffer.levels.length === columns * rows &&
    buffer.times.length === rows &&
    buffer.knownRows.length === rows &&
    buffer.readTarget.length === columns
  );
}

function currentBandSample(bands: readonly Float32Array[], position: number) {
  let sum = 0;
  for (const channel of bands) {
    if (!channel.length) continue;
    const index = clamp(position) * (channel.length - 1);
    const first = Math.floor(index);
    const mix = index - first;
    const a = clamp(channel[first]);
    const b = clamp(channel[Math.min(channel.length - 1, first + 1)]);
    const value = a * (1 - mix) + b * mix;
    sum += value * value;
  }
  return clamp(Math.sqrt(sum / Math.max(1, bands.length)));
}

/**
 * Fill a fixed, oldest-to-newest history window using absolute source times.
 * Missing rows are cleared rather than carrying values from a previous draw;
 * only the newest row can fall back to the live frame's current bands.
 */
export function sampleTerrain(
  history: FrequencyHistory | undefined,
  currentBands: readonly Float32Array[],
  time: number,
  historySeconds: number,
  columns: number,
  rows: number,
  quietThreshold: number,
  reusable?: TerrainSampleBuffer,
): TerrainSampleBuffer {
  const safeColumns = Math.max(1, Math.min(64, Math.floor(finite(columns, 1))));
  const safeRows = Math.max(1, Math.min(64, Math.floor(finite(rows, 1))));
  const out = validSampleBuffer(reusable, safeColumns, safeRows)
    ? reusable!
    : createTerrainSampleBuffer(safeColumns, safeRows);
  const frameTime = finite(time, 0);
  const windowSeconds = clamp(historySeconds, 2, 10);
  const threshold = clamp(quietThreshold, 0, 0.1);
  out.levels.fill(0);
  out.times.fill(0);
  out.knownRows.fill(0);
  for (let row = 0; row < out.rows; row++) {
    const depth = out.rows > 1 ? row / (out.rows - 1) : 1;
    const sourceTime = frameTime - windowSeconds * (1 - depth);
    const offset = row * out.columns;
    out.times[row] = sourceTime;

    out.readTarget.fill(0);
    let measured = false;
    if (history) {
      try {
        measured = history.read(sourceTime, out.readTarget, threshold) === true;
      } catch {
        // An unavailable history source behaves like an unavailable timestamp.
      }
    }
    if (measured) {
      // A small frequency-domain filter keeps narrow measurements readable as
      // ridges while preserving separate bass, midrange and treble locations.
      for (let column = 0; column < out.columns; column++)
        out.levels[offset + column] =
          clamp(out.readTarget[Math.max(0, column - 1)]) * 0.25 +
          clamp(out.readTarget[column]) * 0.5 +
          clamp(out.readTarget[Math.min(out.columns - 1, column + 1)]) * 0.25;
      out.knownRows[row] = 1;
    } else if (row === out.rows - 1) {
      for (let column = 0; column < out.columns; column++) {
        const position = out.columns > 1 ? column / (out.columns - 1) : 0.5;
        out.levels[offset + column] = currentBandSample(currentBands, position);
      }
      out.knownRows[row] = currentBands.some((channel) => channel.length > 0) ? 1 : 0;
    }
  }
  return out;
}

export type TerrainProjectionOptions = {
  height: number;
  visualScale: number;
  sensitivity: number;
  perspective: TerrainOptions["perspective"];
  captionHeight?: number;
};

const perspectiveAmount: Record<TerrainOptions["perspective"], number> = {
  low: 0.12,
  medium: 0.42,
  high: 0.78,
};

function terrainWarp(depth: number, perspective: TerrainOptions["perspective"]) {
  const strength = perspectiveAmount[perspective] ?? perspectiveAmount.medium;
  return depth / (1 + strength * (1 - depth) * 2.2);
}

/** Project the sampled surface into reusable screen-space x/y pairs. */
export function projectTerrain(
  levels: Float32Array,
  columns: number,
  rows: number,
  width: number,
  height: number,
  options: TerrainProjectionOptions,
  reusable?: Float32Array,
): Float32Array {
  const safeColumns = Math.max(1, Math.min(64, Math.floor(finite(columns, 1))));
  const safeRows = Math.max(1, Math.min(64, Math.floor(finite(rows, 1))));
  const required = safeColumns * safeRows * 2;
  const points = reusable?.length === required ? reusable : new Float32Array(required);
  const w = Math.max(1, finite(width, 1));
  const h = Math.max(1, finite(height, 1));
  const short = Math.min(w, h);
  const displayHeight = clamp(options.height, 0, 100) / 100;
  const visualScale = clamp(options.visualScale, 0.5, 1.5);
  const sensitivity = clamp(options.sensitivity, 0, 4);
  const horizon = h * 0.29;
  const caption = Math.min(h * 0.25, Math.max(0, finite(options.captionHeight ?? 0)));
  const floor = Math.max(horizon + 1, h - Math.max(h * 0.035, caption));
  const verticalSpan = Math.max(1, floor - horizon);
  // Height is a world-space terrain displacement. It must not shrink as row
  // count rises: screen-space depth rows can naturally overlap where a ridge
  // occludes a farther valley, while the underlying frequency/time lattice
  // remains regular and unfolded.
  const baseLift = Math.min(short * 0.22 * displayHeight * visualScale, short * 0.2);
  const viewWidth = w * (0.78 + (visualScale - 1) * 0.12);
  for (let row = 0; row < safeRows; row++) {
    const depth = safeRows > 1 ? row / (safeRows - 1) : 1;
    const warped = terrainWarp(depth, options.perspective);
    const baseline = horizon + warped * verticalSpan;
    const lift = baseLift * (0.7 + warped * 0.3);
    for (let column = 0; column < safeColumns; column++) {
      const index = row * safeColumns + column;
      const frequency = safeColumns > 1 ? column / (safeColumns - 1) : 0.5;
      const amplitude = clamp(levels[index]);
      const response = 1 - Math.exp(-amplitude * sensitivity * 4);
      const x = w * 0.5 + (frequency - 0.5) * viewWidth * (0.2 + warped * 0.8);
      let y = baseline - response * lift;
      y = clamp(y, -h * 0.05, h * 1.05);
      points[index * 2] = finite(x, w / 2);
      points[index * 2 + 1] = finite(y, baseline);
    }
  }
  return points;
}

/** A smooth, source-time-based ping-pong phase with no frame-clock drift. */
export function terrainTravelPosition(time: number, historySeconds: number, travelSpeed: number) {
  const speed = clamp(travelSpeed, 0, 200) / 100;
  if (speed <= 0) return 0;
  const history = clamp(historySeconds, 2, 10);
  const period = (2 * history) / speed;
  const cycle = (((finite(time, 0) / period) % 1) + 1) % 1;
  return (1 - Math.cos(cycle * Math.PI * 2)) / 2;
}

type TerrainBuffers = TerrainSampleBuffer & { points: Float32Array };
const contextBuffers = new WeakMap<CanvasRenderingContext2D, TerrainBuffers>();

function getBuffers(ctx: CanvasRenderingContext2D, columns: number, rows: number) {
  let buffers = contextBuffers.get(ctx);
  if (!buffers || buffers.columns !== columns || buffers.rows !== rows) {
    const sample = createTerrainSampleBuffer(columns, rows);
    buffers = { ...sample, points: new Float32Array(columns * rows * 2) };
    contextBuffers.set(ctx, buffers);
  }
  return buffers;
}

function vertex(points: Float32Array, columns: number, row: number, column: number) {
  return (row * columns + column) * 2;
}

function drawSurfaceFill(
  ctx: CanvasRenderingContext2D,
  points: Float32Array,
  columns: number,
  rows: number,
  color: string,
  opacity: number,
) {
  if (opacity <= 0 || columns < 2 || rows < 2) return;
  for (let row = 0; row < rows - 1; row++) {
    // Each depth ribbon is filled back-to-front. A nearer ridge can then cover
    // a farther strip instead of having all overlapping strips merged at once.
    ctx.beginPath();
    for (let column = 0; column < columns - 1; column++) {
      const a = vertex(points, columns, row, column);
      const b = vertex(points, columns, row, column + 1);
      const c = vertex(points, columns, row + 1, column + 1);
      const d = vertex(points, columns, row + 1, column);
      ctx.moveTo(points[a], points[a + 1]);
      ctx.lineTo(points[b], points[b + 1]);
      ctx.lineTo(points[c], points[c + 1]);
      ctx.lineTo(points[d], points[d + 1]);
      ctx.closePath();
    }
    ctx.fillStyle = rgba(color, opacity);
    ctx.fill();
  }
}

function addSurfaceLines(
  ctx: CanvasRenderingContext2D,
  points: Float32Array,
  columns: number,
  rows: number,
) {
  ctx.beginPath();
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = vertex(points, columns, row, column);
      if (column === 0) ctx.moveTo(points[index], points[index + 1]);
      else ctx.lineTo(points[index], points[index + 1]);
    }
  }
}

function addDepthLines(
  ctx: CanvasRenderingContext2D,
  points: Float32Array,
  columns: number,
  rows: number,
) {
  const stride = columns >= 64 ? 4 : columns >= 48 ? 3 : 2;
  ctx.beginPath();
  for (let column = 0; column < columns; column += stride) {
    for (let row = 0; row < rows; row++) {
      const index = vertex(points, columns, row, column);
      if (row === 0) ctx.moveTo(points[index], points[index + 1]);
      else ctx.lineTo(points[index], points[index + 1]);
    }
  }
  const last = columns - 1;
  for (let row = 0; row < rows; row++) {
    const index = vertex(points, columns, row, last);
    if (row === 0) ctx.moveTo(points[index], points[index + 1]);
    else ctx.lineTo(points[index], points[index + 1]);
  }
}

function drawTravelContour(
  ctx: CanvasRenderingContext2D,
  points: Float32Array,
  columns: number,
  rows: number,
  position: number,
  color: string,
  opacity: number,
  glow: number,
  short: number,
) {
  if (opacity <= 0 || columns < 2 || rows < 2) return;
  const rowPosition = clamp(position) * (rows - 1);
  const row = Math.min(rows - 2, Math.floor(rowPosition));
  const mix = rowPosition - row;
  ctx.beginPath();
  for (let column = 0; column < columns; column++) {
    const a = vertex(points, columns, row, column);
    const b = vertex(points, columns, row + 1, column);
    const x = points[a] + (points[b] - points[a]) * mix;
    const y = points[a + 1] + (points[b + 1] - points[a + 1]) * mix;
    if (column === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = rgba(color, opacity);
  ctx.lineWidth = Math.max(0.7, short / 800);
  ctx.shadowColor = color;
  ctx.shadowBlur = Math.min(short * 0.016, glow * short * 0.015);
  ctx.stroke();
}

export const spectralTerrain: VisualStyleRenderer<TerrainOptions> = {
  id: "terrain",
  draw(ctx, frame: VisualFrameContext, options) {
    const { width, height } = frame;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const normalized = { ...DEFAULT_TERRAIN_OPTIONS, ...options };
    const { columns, rows } = terrainResolution(normalized.density);
    const buffers = getBuffers(ctx, columns, rows);
    const time = finite(frame.time, 0);
    const historySeconds = clamp(normalized.historySeconds, 2, 10);
    sampleTerrain(
      frame.history,
      frame.audio.bands,
      time,
      historySeconds,
      columns,
      rows,
      frame.settings.quietThreshold,
      buffers,
    );
    projectTerrain(
      buffers.levels,
      columns,
      rows,
      width,
      height,
      {
        height: normalized.height,
        visualScale: frame.settings.visualScale,
        sensitivity: frame.settings.sensitivity,
        perspective: normalized.perspective,
        captionHeight: frame.captionHeight,
      },
      buffers.points,
    );

    const short = Math.min(width, height);
    const wireOpacity = clamp(normalized.wireOpacity / 100);
    const fillOpacity = clamp(normalized.surfaceFill / 100) * 0.32;
    const glow = clamp(frame.settings.glow, 0, 2.5);
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    drawSurfaceFill(ctx, buffers.points, columns, rows, frame.settings.primary, fillOpacity);

    const horizontal = () => addSurfaceLines(ctx, buffers.points, columns, rows);
    horizontal();
    ctx.strokeStyle = rgba(frame.settings.primary, wireOpacity);
    ctx.lineWidth = Math.max(0.65, short / 1100);
    ctx.globalAlpha = 0.46;
    ctx.shadowColor = frame.settings.primary;
    ctx.shadowBlur = Math.min(short * 0.02, glow * short * 0.018);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.stroke();

    addDepthLines(ctx, buffers.points, columns, rows);
    ctx.strokeStyle = rgba(frame.settings.secondary, wireOpacity * 0.72);
    ctx.lineWidth = Math.max(0.55, short / 1400);
    ctx.globalAlpha = 0.42;
    ctx.shadowColor = frame.settings.secondary;
    ctx.shadowBlur = Math.min(short * 0.018, glow * short * 0.015);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.stroke();

    if (!frame.reducedMotion && normalized.travelSpeed > 0) {
      drawTravelContour(
        ctx,
        buffers.points,
        columns,
        rows,
        terrainTravelPosition(time, historySeconds, normalized.travelSpeed),
        frame.settings.secondary,
        wireOpacity * 0.48,
        glow,
        short,
      );
    }
    ctx.restore();
  },
};
