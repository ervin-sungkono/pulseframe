import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const {
  createTerrainSampleBuffer,
  projectTerrain,
  sampleTerrain,
  spectralTerrain,
  terrainResolution,
  terrainTravelPosition,
} = modules["spectral-terrain"];

const projection = {
  height: 70,
  visualScale: 1,
  sensitivity: 1.2,
  perspective: "medium",
};

function row(samples, columns, index) {
  return samples.levels.subarray(index * columns, (index + 1) * columns);
}

function recordingContext() {
  let path = [];
  const strokes = [];
  return {
    strokes,
    save() {},
    restore() {},
    beginPath() {
      path = [];
    },
    moveTo(x, y) {
      path.push([x, y]);
    },
    lineTo(x, y) {
      path.push([x, y]);
    },
    closePath() {
      path.push(["close"]);
    },
    fill() {},
    stroke() {
      strokes.push({
        path: path.map((point) => [...point]),
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        globalAlpha: this.globalAlpha,
        shadowBlur: this.shadowBlur,
      });
    },
  };
}

function frameAt(time, history, reducedMotion = false) {
  return {
    width: 640,
    height: 360,
    time,
    sampleRate: 48000,
    settings: {
      quietThreshold: 0.006,
      sensitivity: 1.2,
      visualScale: 1,
      glow: 0.8,
      primary: "#9b72ff",
      secondary: "#61e5ff",
    },
    reducedMotion,
    fittedLogo: false,
    captionHeight: 0,
    audio: {
      activity: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      energy: 0,
      impact: 0,
      bands: [Float32Array.from({ length: 32 }, (_, i) => i / 64)],
      bandLayers: [],
      ringMix: 0,
    },
    history,
  };
}

test("terrain density maps to bounded, exact grid sizes", () => {
  assert.deepEqual(terrainResolution("low"), { columns: 32, rows: 24 });
  assert.deepEqual(terrainResolution("medium"), { columns: 48, rows: 40 });
  assert.deepEqual(terrainResolution("high"), { columns: 64, rows: 64 });
  assert.ok(terrainResolution("high").columns <= 64);
  assert.ok(terrainResolution("high").rows <= 64);
});

test("sampling reads each absolute history row once and keeps the requested window on seeks", () => {
  const calls = [];
  const history = {
    read(time, target, threshold) {
      calls.push({ time, width: target.length, threshold });
      target.fill(Math.max(0, Math.min(1, (time + 1) / 30)));
      for (let column = 0; column < target.length; column++)
        target[column] = Math.max(0, Math.min(1, target[column] + column / target.length / 3));
      return time >= 0;
    },
  };
  const reusable = createTerrainSampleBuffer(64, 5);
  const emptyCurrent = [];
  const first = sampleTerrain(history, emptyCurrent, 20, 4, 64, 5, 0.02, reusable);
  assert.equal(first, reusable);
  assert.deepEqual(
    calls.map((call) => call.time),
    [16, 17, 18, 19, 20],
  );
  assert.ok(calls.every((call) => call.width === 64 && call.threshold === 0.02));
  assert.deepEqual(Array.from(first.times), [16, 17, 18, 19, 20]);
  assert.ok(row(first, 64, 0)[0] < row(first, 64, 4)[0]);

  calls.length = 0;
  const seek = sampleTerrain(history, emptyCurrent, 3.25, 4, 64, 5, 0.02, reusable);
  assert.equal(seek, reusable);
  assert.deepEqual(
    calls.map((call) => call.time),
    [-0.75, 0.25, 1.25, 2.25, 3.25],
  );
  assert.deepEqual(Array.from(seek.times), [-0.75, 0.25, 1.25, 2.25, 3.25]);
  assert.ok(row(seek, 64, 0).every((value) => value === 0));
});

test("unavailable history is flat and only the current row can use live bands", () => {
  const history = {
    read(_time, target) {
      target.fill(0.95);
      return false;
    },
  };
  const current = [Float32Array.from([0, 0.25, 0.5, 1])];
  const samples = sampleTerrain(history, current, 8, 3, 4, 4, 0, createTerrainSampleBuffer(4, 4));
  assert.deepEqual(Array.from(samples.knownRows), [0, 0, 0, 1]);
  assert.ok(row(samples, 4, 0).every((value) => value === 0));
  assert.ok(row(samples, 4, 1).every((value) => value === 0));
  assert.ok(row(samples, 4, 2).every((value) => value === 0));
  assert.deepEqual(Array.from(row(samples, 4, 3)), Array.from(current[0]));

  const silent = sampleTerrain(undefined, [], 8, 3, 4, 4, 0);
  assert.ok(silent.levels.every((value) => value === 0));
  assert.ok(silent.knownRows.every((value) => value === 0));
});

test("calibrated frequency peaks remain distinct without folding the frequency axis", () => {
  const columns = 64;
  const history = {
    read(_time, target) {
      target.fill(0);
      target[5] = 0.9;
      target[42] = 0.65;
      return true;
    },
  };
  const samples = sampleTerrain(history, [], 5, 2, columns, 24, 0);
  const points = projectTerrain(samples.levels, columns, 24, 1080, 1920, projection);
  const rowIndex = 12;
  const y = (column) => points[(rowIndex * columns + column) * 2 + 1];
  assert.ok(y(5) < y(4));
  assert.ok(y(42) < y(41));
  assert.notEqual(y(5), y(42));
  for (let rowIndex = 0; rowIndex < 24; rowIndex++) {
    for (let column = 1; column < columns; column++) {
      const previousX = points[(rowIndex * columns + column - 1) * 2];
      const currentX = points[(rowIndex * columns + column) * 2];
      assert.ok(currentX > previousX);
    }
  }
  assert.ok(points.every(Number.isFinite));
});

test("terrain height creates visible peaks independent of grid density", () => {
  const rises = [];
  for (const density of ["low", "medium", "high"]) {
    const { columns, rows } = terrainResolution(density);
    const flat = new Float32Array(columns * rows);
    const full = new Float32Array(columns * rows).fill(1);
    const flatPoints = projectTerrain(flat, columns, rows, 1280, 720, {
      ...projection,
      height: 100,
    });
    const atSixty = projectTerrain(full, columns, rows, 1280, 720, {
      ...projection,
      height: 60,
    });
    const atOneHundred = projectTerrain(full, columns, rows, 1280, 720, {
      ...projection,
      height: 100,
    });
    const sixtyRise =
      flatPoints[(rows - 1) * columns * 2 + 1] - atSixty[(rows - 1) * columns * 2 + 1];
    const fullRise =
      flatPoints[(rows - 1) * columns * 2 + 1] - atOneHundred[(rows - 1) * columns * 2 + 1];
    assert.ok(sixtyRise >= 720 * 0.12 && sixtyRise <= 720 * 0.14, `${density}: ${sixtyRise}`);
    assert.ok(fullRise >= 720 * 0.18 && fullRise <= 720 * 0.2, `${density}: ${fullRise}`);
    rises.push([sixtyRise, fullRise]);
  }
  assert.deepEqual(rises[1], rises[0]);
  assert.deepEqual(rises[2], rises[0]);
});

test("flat unknown and silent surfaces stay finite across portrait, square, and landscape frames", () => {
  for (const [width, height] of [
    [300, 700],
    [600, 600],
    [1280, 720],
  ]) {
    const levels = new Float32Array(64 * 64);
    const points = projectTerrain(levels, 64, 64, width, height, projection);
    assert.ok(points.every(Number.isFinite));
    for (let rowIndex = 1; rowIndex < 64; rowIndex++) {
      assert.ok(points[rowIndex * 64 * 2 + 1] > points[(rowIndex - 1) * 64 * 2 + 1]);
    }
    for (let rowIndex = 0; rowIndex < 64; rowIndex++) {
      const base = points[rowIndex * 64 * 2 + 1];
      for (let column = 1; column < 64; column++)
        assert.equal(points[(rowIndex * 64 + column) * 2 + 1], base);
    }
  }
});

test("poses and travel are source-time based at 24, 30, and 60 fps and remain fixed while paused", () => {
  const history = {
    read(time, target) {
      target.forEach((_value, index) => {
        target[index] = 0.35 + 0.2 * Math.sin(index * 0.17 + time * 0.11);
      });
      return true;
    },
  };
  const poses = [24, 30, 60].map((fps) => {
    const time = Math.round(fps * 2.5) / fps;
    const samples = sampleTerrain(history, [], time, 5, 32, 24, 0.006);
    return {
      points: projectTerrain(samples.levels, 32, 24, 640, 360, projection),
      travel: terrainTravelPosition(time, 5, 100),
      times: samples.times,
    };
  });
  assert.deepEqual(poses[1], poses[0]);
  assert.deepEqual(poses[2], poses[0]);

  const firstPause = terrainTravelPosition(3.125, 5, 100);
  const secondPause = terrainTravelPosition(3.125, 5, 100);
  assert.equal(firstPause, secondPause);
  assert.equal(terrainTravelPosition(3.125, 5, 0), 0);
  assert.notEqual(terrainTravelPosition(1, 5, 200), terrainTravelPosition(1, 5, 100));
});

test("renderer draws a deterministic wire surface and sanitizes NaN history values", () => {
  const history = {
    read(_time, target) {
      target.fill(Number.NaN);
      return true;
    },
  };
  const options = {
    height: 60,
    historySeconds: 5,
    density: "low",
    perspective: "medium",
    travelSpeed: 100,
    wireOpacity: 75,
    surfaceFill: 10,
  };
  const snapshot = (reducedMotion = false) => {
    const ctx = recordingContext();
    spectralTerrain.draw(ctx, frameAt(2.5, history, reducedMotion), options);
    assert.ok(
      ctx.strokes.every(({ path }) =>
        path.every(([x, y]) => x === "close" || (Number.isFinite(x) && Number.isFinite(y))),
      ),
    );
    return ctx.strokes;
  };
  const first = snapshot();
  const repeated = snapshot();
  assert.deepEqual(repeated, first);
  assert.equal(first.length, 5);
  const reduced = snapshot(true);
  assert.equal(reduced.length, 4);
});

test("NaN inputs are bounded and reusable helper buffers are honored", () => {
  const reusable = createTerrainSampleBuffer(1, 1);
  const samples = sampleTerrain(
    {
      read(_time, target) {
        target.fill(Number.NaN);
        return true;
      },
    },
    [],
    Number.NaN,
    Number.NaN,
    1,
    1,
    Number.NaN,
    reusable,
  );
  assert.equal(samples, reusable);
  assert.deepEqual(Array.from(samples.times), [0]);
  assert.deepEqual(Array.from(samples.levels), [0]);
  const points = new Float32Array(2);
  assert.equal(
    projectTerrain(
      samples.levels,
      1,
      1,
      Number.NaN,
      Number.NaN,
      {
        height: Number.NaN,
        visualScale: Number.NaN,
        sensitivity: Number.NaN,
        perspective: "medium",
      },
      points,
    ),
    points,
  );
  assert.ok(points.every(Number.isFinite));
  assert.ok(Number.isFinite(terrainTravelPosition(Number.NaN, Number.NaN, Number.NaN)));
});
