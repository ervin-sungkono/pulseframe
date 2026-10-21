import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const {
  createTerrainSampleBuffer,
  projectTerrain,
  sampleTerrain,
  spectralTerrain,
  terrainDepthOpacity,
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

function splitSubpaths(path) {
  const subpaths = [];
  for (const command of path) {
    if (command[0] === "move") subpaths.push([command]);
    else subpaths.at(-1).push(command);
  }
  return subpaths;
}

function assertPathsClose(actual, expected, tolerance, message) {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((command, index) => {
    assert.equal(command[0], expected[index][0], message);
    command.slice(1).forEach((value, pointIndex) => {
      assert.ok(Math.abs(value - expected[index][pointIndex + 1]) < tolerance, message);
    });
  });
}

function recordingContext() {
  let path = [];
  const strokes = [];
  const fills = [];
  return {
    strokes,
    fills,
    save() {},
    restore() {},
    beginPath() {
      path = [];
    },
    moveTo(x, y) {
      path.push(["move", x, y]);
    },
    lineTo(x, y) {
      path.push(["line", x, y]);
    },
    bezierCurveTo(...points) {
      path.push(["curve", ...points]);
    },
    closePath() {
      path.push(["close"]);
    },
    fill() {
      fills.push({
        path: path.map((point) => [...point]),
        fillStyle: this.fillStyle,
        globalAlpha: this.globalAlpha,
      });
    },
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

test("depth opacity changes continuously from faint distance to a clear foreground", () => {
  const values = Array.from({ length: 1001 }, (_, index) => terrainDepthOpacity(index / 1000));
  assert.ok(values.every(Number.isFinite));
  assert.ok(values.every((value, index) => index === 0 || value >= values[index - 1]));
  assert.ok(values[0] > 0 && values[0] < 0.25);
  assert.equal(values.at(-1), 1);
  assert.ok(values.every((value, index) => index === 0 || value - values[index - 1] < 0.002));
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
    Array.from(first.times),
  );
  assert.ok(calls.every((call) => call.width === 64 && call.threshold === 0.02));
  assert.deepEqual(Array.from(first.times), [16, 17.333333333333332, 18.666666666666664, 20, 20]);
  assert.deepEqual(first.depths, Float32Array.from([0, 1 / 3, 2 / 3, 1, 1]));
  assert.ok(row(first, 64, 0)[0] < row(first, 64, 4)[0]);

  calls.length = 0;
  const seek = sampleTerrain(history, emptyCurrent, 3.25, 4, 64, 5, 0.02, reusable);
  assert.equal(seek, reusable);
  assert.deepEqual(
    calls.map((call) => call.time),
    Array.from(seek.times),
  );
  assert.deepEqual(Array.from(seek.times), [-0.75, 0, 4 / 3, 8 / 3, 3.25]);
  assert.ok(row(seek, 64, 0).every((value) => value === 0));
});

test("terrain interior rows hold source-time samples while their depths advance", () => {
  const columns = 8;
  const rows = 8;
  const historySeconds = 5;
  const history = {
    read(time, target) {
      const ridge = Math.exp(-(((time - 8) / 0.6) ** 2));
      target.forEach((_value, column) => {
        target[column] = ridge * (0.2 + 0.8 * Math.sin((column + 1) * 0.4) ** 2);
      });
      return true;
    },
  };
  const first = sampleTerrain(history, [], 10.005, historySeconds, columns, rows, 0);
  const firstLevels = first.levels.slice();
  const firstTimes = first.times.slice();
  const firstDepths = first.depths.slice();
  const nextTime = 10.025;
  const next = sampleTerrain(history, [], nextTime, historySeconds, columns, rows, 0, first);
  const deltaTime = nextTime - 10.005;

  assert.equal(next, first);
  assert.ok(Math.abs(next.times[0] - firstTimes[0] - deltaTime) < 1e-12);
  assert.ok(Math.abs(next.times[rows - 1] - firstTimes[rows - 1] - deltaTime) < 1e-12);
  for (let rowIndex = 1; rowIndex < rows - 1; rowIndex++) {
    assert.equal(next.times[rowIndex], firstTimes[rowIndex]);
    assert.deepEqual(
      Array.from(row(next, columns, rowIndex)),
      Array.from(firstLevels.subarray(rowIndex * columns, (rowIndex + 1) * columns)),
    );
    assert.ok(
      Math.abs(next.depths[rowIndex] - (firstDepths[rowIndex] - deltaTime / historySeconds)) < 1e-7,
    );
  }
});

test("source-time anchored rows keep their geometry continuous when the row buffer rolls", () => {
  const columns = 8;
  const rows = 8;
  const historySeconds = 5;
  const rowStep = historySeconds / (rows - 2);
  const rollover = 11 * rowStep;
  const epsilon = 1e-5;
  const history = {
    read(time, target) {
      target.forEach((_value, column) => {
        target[column] = 0.75 * Math.exp(-(((time - 5) / 0.4) ** 2)) * (0.25 + column / 16);
      });
      return true;
    },
  };
  const before = sampleTerrain(history, [], rollover - epsilon, historySeconds, columns, rows, 0);
  const after = sampleTerrain(history, [], rollover + epsilon, historySeconds, columns, rows, 0);
  const beforePoints = projectTerrain(
    before.levels,
    columns,
    rows,
    640,
    360,
    projection,
    undefined,
    before.depths,
  );
  const afterPoints = projectTerrain(
    after.levels,
    columns,
    rows,
    640,
    360,
    projection,
    undefined,
    after.depths,
  );

  for (let beforeRow = 2; beforeRow < rows - 1; beforeRow++) {
    const sourceTime = before.times[beforeRow];
    const afterRow = Array.from(after.times).findIndex(
      (time) => Math.abs(time - sourceTime) < 1e-9,
    );
    assert.equal(afterRow, beforeRow - 1);
    assert.deepEqual(
      Array.from(row(after, columns, afterRow)),
      Array.from(row(before, columns, beforeRow)),
    );
    assert.ok(
      Math.abs(
        afterPoints[afterRow * columns * 2 + 1] - beforePoints[beforeRow * columns * 2 + 1],
      ) < 0.01,
    );
  }
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

test("smoothed terrain contours stay finite, bounded, and preserve separate measured peaks", () => {
  const columns = 64;
  const rows = 64;
  const history = {
    read(_time, target) {
      target.fill(0.025);
      target[Math.round((8 / 63) * (target.length - 1))] = 0.95;
      target[Math.round((42 / 63) * (target.length - 1))] = 0.65;
      return true;
    },
  };
  const samples = sampleTerrain(history, [], 5, 4, columns, rows, 0);
  const points = projectTerrain(
    samples.levels,
    columns,
    rows,
    640,
    360,
    {
      ...projection,
      height: 60,
    },
    undefined,
    samples.depths,
  );
  const rowIndex = 24;
  const ctx = recordingContext();
  spectralTerrain.draw(ctx, frameAt(5, history), {
    height: 60,
    historySeconds: 4,
    density: "high",
    perspective: "medium",
    travelSpeed: 0,
    wireOpacity: 75,
    surfaceFill: 0,
  });
  const path = ctx.strokes[0].path;
  const startX = points[rowIndex * columns * 2];
  const startIndex = path.findIndex(
    (command) => command[0] === "move" && Math.abs(command[1] - startX) < 1e-5,
  );
  assert.ok(startIndex >= 0, "recorded smooth contour row");
  const y = (column) => (column === 0 ? path[startIndex][2] : path[startIndex + column][6]);
  let previousY = path[startIndex][2];
  for (let column = 0; column < columns - 1; column++) {
    const command = path[startIndex + column + 1];
    assert.equal(command[0], "curve");
    assert.ok(command.slice(1).every(Number.isFinite));
    const control1Y = command[2];
    const control2Y = command[4];
    const endY = command[6];
    const lower = Math.min(previousY, endY) - 1e-4;
    const upper = Math.max(previousY, endY) + 1e-4;
    assert.ok(control1Y >= lower && control1Y <= upper);
    assert.ok(control2Y >= lower && control2Y <= upper);
    previousY = endY;
  }
  assert.ok(y(8) < y(7) && y(8) < y(9));
  assert.ok(y(42) < y(41) && y(42) < y(43));
  assert.notEqual(y(8), y(42));
});

test("filled terrain ribbons share the wire curve and gain opacity toward the viewer", () => {
  const history = {
    read(_time, target) {
      target.fill(0.5);
      return true;
    },
  };
  const ctx = recordingContext();
  spectralTerrain.draw(ctx, frameAt(5, history), {
    height: 60,
    historySeconds: 5,
    density: "low",
    perspective: "medium",
    travelSpeed: 0,
    wireOpacity: 75,
    surfaceFill: 20,
  });
  const columns = terrainResolution("low").columns;
  assert.deepEqual(ctx.fills[0].path.slice(0, columns), ctx.strokes[0].path.slice(0, columns));

  const fillAlpha = (fill) => Number(fill.fillStyle.match(/,([\d.]+)\)$/)[1]);
  const fillValues = ctx.fills.map(fillAlpha);
  assert.ok(fillValues.every((value, index) => index === 0 || value >= fillValues[index - 1]));
  const rowValues = ctx.strokes.slice(4, -4).map((stroke) => stroke.globalAlpha);
  assert.ok(rowValues.every((value, index) => index === 0 || value >= rowValues[index - 1]));
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
        path.every(([kind, ...values]) => kind === "close" || values.every(Number.isFinite)),
      ),
    );
    return ctx.strokes;
  };
  const first = snapshot();
  const repeated = snapshot();
  assert.deepEqual(repeated, first);
  assert.equal(first.length, 29);
  const reduced = snapshot(true);
  assert.equal(reduced.length, 28);
});

test("zero terrain fill and wire opacity suppress their canvas operations", () => {
  const ctx = recordingContext();
  spectralTerrain.draw(ctx, frameAt(2.5, undefined), {
    height: 60,
    historySeconds: 5,
    density: "low",
    perspective: "medium",
    travelSpeed: 100,
    wireOpacity: 0,
    surfaceFill: 0,
  });
  assert.equal(ctx.strokes.length, 0);
  assert.equal(ctx.fills.length, 0);
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

test("travel highlight remains continuous as anchored rows roll over", () => {
  const history = {
    read(time, target) {
      target.forEach((_value, column) => {
        target[column] = 0.3 + 0.2 * Math.sin(time * 4 + column * 0.1);
      });
      return true;
    },
  };
  for (const density of ["low", "medium", "high"]) {
    const { rows } = terrainResolution(density);
    const rollover = 11 * (5 / (rows - 2));
    const contexts = [-1e-7, 1e-7].map((offset) => {
      const ctx = recordingContext();
      spectralTerrain.draw(ctx, frameAt(rollover + offset, history), {
        height: 60,
        historySeconds: 5,
        density,
        perspective: "medium",
        travelSpeed: 100,
        wireOpacity: 75,
        surfaceFill: 10,
      });
      return ctx;
    });
    const paths = contexts.map((ctx) => ctx.strokes.at(-1).path);
    const columns = terrainResolution(density).columns;
    for (const path of paths) {
      assert.equal(path.length, columns, density);
      assert.equal(path[0][0], "move", density);
      let previousY = path[0][2];
      for (let column = 0; column < columns - 1; column++) {
        const command = path[column + 1];
        assert.equal(command[0], "curve", density);
        assert.ok(command.slice(1).every(Number.isFinite), density);
        const endY = command[6];
        const lower = Math.min(previousY, endY) - 1e-4;
        const upper = Math.max(previousY, endY) + 1e-4;
        assert.ok(command[2] >= lower && command[2] <= upper, density);
        assert.ok(command[4] >= lower && command[4] <= upper, density);
        previousY = endY;
      }
    }
    paths[0].forEach((command, index) => {
      assert.equal(command[0], paths[1][index][0], density);
      command.slice(1).forEach((value, pointIndex) => {
        assert.ok(Math.abs(value - paths[1][index][pointIndex + 1]) < 0.01, density);
      });
    });

    const [beforeGlow, afterGlow] = contexts;
    const beforeGroups = splitSubpaths(beforeGlow.strokes[0].path);
    const afterGroups = splitSubpaths(afterGlow.strokes[0].path);
    // At the near edge, the same source row moves from the aggregate path to
    // the first faded edge glow stroke; the far edge does the reverse.
    assertPathsClose(beforeGroups[1], afterGlow.strokes[1].path, 0.01, `${density} near glow`);
    assertPathsClose(
      beforeGlow.strokes[2].path,
      afterGroups[rows - 4],
      0.01,
      `${density} far glow`,
    );
    assert.ok(
      Math.abs(beforeGlow.strokes[0].globalAlpha - afterGlow.strokes[1].globalAlpha) < 1e-5,
    );
    assert.ok(
      Math.abs(beforeGlow.strokes[2].globalAlpha - afterGlow.strokes[0].globalAlpha) < 1e-5,
    );
  }
});

test("travel highlight opacity follows its interpolated depth continuously", () => {
  const history = {
    read(_time, target) {
      target.fill(0.4);
      return true;
    },
  };
  const timeSamples = [0, 2.5, 5];
  const alphaValues = timeSamples.map((time) => {
    const ctx = recordingContext();
    spectralTerrain.draw(ctx, frameAt(time, history), {
      height: 60,
      historySeconds: 5,
      density: "low",
      perspective: "medium",
      travelSpeed: 100,
      wireOpacity: 75,
      surfaceFill: 0,
    });
    const stroke = ctx.strokes.at(-1);
    const alpha = Number(stroke.strokeStyle.match(/,([\d.]+)\)$/)[1]);
    const depth = terrainTravelPosition(time, 5, 100);
    assert.ok(Math.abs(alpha - 0.75 * 0.48 * terrainDepthOpacity(depth)) < 1e-6);
    return alpha;
  });
  assert.ok(alphaValues[0] < alphaValues[1] && alphaValues[1] < alphaValues[2]);
});

test("entering and leaving terrain rows fade before coinciding with boundary lines", () => {
  const history = {
    read(_time, target) {
      target.fill(0.5);
      return true;
    },
  };
  for (const density of ["low", "medium", "high"]) {
    const { rows } = terrainResolution(density);
    const rollover = 11 * (5 / (rows - 2));
    const contexts = [-1e-7, 1e-7].map((offset) => {
      const ctx = recordingContext();
      spectralTerrain.draw(ctx, frameAt(rollover + offset, history), {
        height: 60,
        historySeconds: 5,
        density,
        perspective: "medium",
        travelSpeed: 100,
        wireOpacity: 75,
        surfaceFill: 10,
      });
      return ctx;
    });
    assert.ok(contexts[0].strokes[4].globalAlpha < 1e-5, "entering row begins faded");
    assert.ok(
      contexts[1].strokes[rows + 1].globalAlpha < 1e-5,
      "leaving row fades at the opposite boundary",
    );
    assert.ok(contexts[0].strokes[rows + 1].globalAlpha > 0.45);
    assert.ok(contexts[1].strokes[4].globalAlpha > 0.15);
    assert.ok(contexts[1].strokes[4].globalAlpha < 0.25);
    assert.ok(contexts[0].strokes[1].globalAlpha < 1e-5, "near edge glow fades to zero");
    assert.ok(Math.abs(contexts[1].strokes[1].globalAlpha - 0.2) < 1e-5);
    assert.ok(Math.abs(contexts[0].strokes[2].globalAlpha - 0.2) < 1e-5);
    assert.ok(contexts[1].strokes[2].globalAlpha < 1e-5, "far edge glow fades to zero");
  }
});

test("renderer reconstructs the same paused and sought pose from absolute source time", () => {
  const history = {
    read(time, target) {
      target.forEach((_value, column) => {
        target[column] =
          0.2 + 0.45 * Math.exp(-(((time - 6) / 1.1) ** 2)) * Math.sin(column * 0.12) ** 2;
      });
      return true;
    },
  };
  const ctx = recordingContext();
  const options = {
    height: 60,
    historySeconds: 5,
    density: "medium",
    perspective: "high",
    travelSpeed: 100,
    wireOpacity: 75,
    surfaceFill: 18,
  };
  const drawAt = (time) => {
    spectralTerrain.draw(ctx, frameAt(time, history), options);
    return structuredClone(ctx.strokes);
  };
  const first = drawAt(6.25);
  ctx.strokes.length = 0;
  const paused = drawAt(6.25);
  assert.deepEqual(paused, first);
  ctx.strokes.length = 0;
  drawAt(2.75);
  ctx.strokes.length = 0;
  const soughtBack = drawAt(6.25);
  assert.deepEqual(soughtBack, first);
});
