import assert from "node:assert/strict";
import test from "node:test";

import { loadSources } from "./load-source.mjs";

const {
  "frequency-history": frequencyHistory,
  "liquid-blob": blob,
  "style-options": styleOptions,
} = await loadSources();
const DEFAULT_OPTIONS = styleOptions.DEFAULT_BLOB_OPTIONS;
const FLUID_OPTIONS = { ...DEFAULT_OPTIONS, deformation: 85 };

function makeFrame(changes = {}) {
  const bands = changes.bands ?? [new Float32Array(256)];
  return {
    width: 320,
    height: 240,
    time: 1.25,
    sampleRate: 48_000,
    settings: {
      sensitivity: 1.3,
      bassBoost: 1,
      quietThreshold: 0.006,
      visualScale: 1.1,
      glow: 0.95,
      primary: "#9b72ff",
      secondary: "#61e5ff",
    },
    reducedMotion: false,
    fittedLogo: false,
    captionHeight: 0,
    audio: {
      activity: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      energy: 0,
      impact: 0,
      bands,
      bandLayers: [],
      ringMix: 0,
    },
    ...changes,
  };
}

function toneBands(position, length = 256, level = 0.82, width = 0.045) {
  const bands = new Float32Array(length);
  for (let index = 0; index < bands.length; index++) {
    const distance = (index / (bands.length - 1) - position) / width;
    bands[index] = level * Math.exp(-0.5 * distance * distance);
  }
  return bands;
}

function makeToneFrame(position, field = "mid", changes = {}) {
  const spectrum = toneBands(position);
  const audio = {
    activity: 0.7,
    bass: field === "bass" ? 0.7 : 0,
    mid: field === "mid" ? 0.7 : 0,
    treble: field === "treble" ? 0.7 : 0,
    energy: 0.7,
    impact: 0,
    bands: [spectrum],
    bandLayers: [],
    ringMix: 0,
  };
  return makeFrame({
    ...changes,
    audio: changes.audio ?? audio,
    bands: changes.bands ?? [spectrum],
  });
}

function makeLevelFrame(level, changes = {}) {
  const spectrum = new Float32Array(96).fill(level);
  const broad = level > 0 ? 1 - Math.exp(-level * 1.3 * 8) : 0;
  return makeFrame({
    ...changes,
    bands: [spectrum],
    audio: {
      activity: broad,
      bass: broad,
      mid: broad,
      treble: broad,
      energy: broad,
      impact: 0,
      bands: [spectrum],
      bandLayers: [],
      ringMix: 0,
    },
  });
}

function makeQuietToneFrame(level, changes = {}) {
  const spectrum = toneBands(0.18, 256, level);
  const broad = level > 0 ? 1 - Math.exp(-level * 1.3 * 8) : 0;
  return makeFrame({
    ...changes,
    bands: [spectrum],
    audio: {
      activity: broad,
      bass: broad,
      mid: broad,
      treble: broad,
      energy: broad,
      impact: 0,
      bands: [spectrum],
      bandLayers: [],
      ringMix: 0,
    },
  });
}

function makeBroadMusicFrame(changes = {}) {
  const spectrum = new Float32Array(256);
  for (let index = 0; index < spectrum.length; index++) {
    const position = index / (spectrum.length - 1);
    const bump = (center, width, amplitude) => {
      const distance = (position - center) / width;
      return amplitude * Math.exp(-0.5 * distance * distance);
    };
    spectrum[index] =
      0.035 + bump(0.14, 0.085, 0.38) + bump(0.47, 0.14, 0.66) + bump(0.82, 0.095, 0.34);
  }
  return makeFrame({
    ...changes,
    bands: [spectrum],
    audio: {
      activity: 0.82,
      bass: 0.68,
      mid: 0.82,
      treble: 0.57,
      energy: 0.82,
      impact: 0.12,
      bands: [spectrum],
      bandLayers: [],
      ringMix: 0,
    },
  });
}

function geometry(frame, options = DEFAULT_OPTIONS) {
  const points = new Float32Array(320);
  const count = blob.writeLiquidBlobGeometry(points, frame, options);
  return { points, count };
}

function directedContourMetrics(source, target, count) {
  let total = 0;
  let maximum = 0;
  for (let point = 0; point < count; point++) {
    const x = source[point * 2];
    const y = source[point * 2 + 1];
    let nearest = Infinity;
    for (let edge = 0; edge < count; edge++) {
      const next = (edge + 1) % count;
      const ax = target[edge * 2];
      const ay = target[edge * 2 + 1];
      const dx = target[next * 2] - ax;
      const dy = target[next * 2 + 1] - ay;
      const lengthSquared = dx * dx + dy * dy;
      const mix =
        lengthSquared > 0
          ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared))
          : 0;
      nearest = Math.min(nearest, Math.hypot(x - (ax + dx * mix), y - (ay + dy * mix)));
    }
    total += nearest;
    maximum = Math.max(maximum, nearest);
  }
  return { mean: total / count, maximum };
}

function directedContourDistance(source, target, count) {
  return directedContourMetrics(source, target, count).mean;
}

function contourDistance(a, b, count) {
  return (directedContourDistance(a, b, count) + directedContourDistance(b, a, count)) / 2;
}

function contourMaxDistance(a, b, count) {
  return Math.max(
    directedContourMetrics(a, b, count).maximum,
    directedContourMetrics(b, a, count).maximum,
  );
}

function polygonMetrics(points, count, frame) {
  let twiceArea = 0;
  let centroidX = 0;
  let centroidY = 0;
  let maxRadius = 0;
  let meanRadius = 0;
  let minRadius = Infinity;
  let positiveTurns = 0;
  let negativeTurns = 0;
  const centerX = frame.width / 2;
  const centerY = frame.height / 2;

  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    const x = points[index * 2];
    const y = points[index * 2 + 1];
    const nextX = points[next * 2];
    const nextY = points[next * 2 + 1];
    const cross = x * nextY - nextX * y;
    twiceArea += cross;
    centroidX += (x + nextX) * cross;
    centroidY += (y + nextY) * cross;
    const radius = Math.hypot(x - centerX, y - centerY);
    meanRadius += radius;
    minRadius = Math.min(minRadius, radius);
    maxRadius = Math.max(maxRadius, radius);

    const after = (index + 2) % count;
    const turn =
      (nextX - x) * (points[after * 2 + 1] - nextY) - (nextY - y) * (points[after * 2] - nextX);
    if (turn > 1e-4) positiveTurns++;
    if (turn < -1e-4) negativeTurns++;
  }

  const area = twiceArea / 2;
  if (Math.abs(twiceArea) > 1e-5) {
    centroidX /= 3 * twiceArea;
    centroidY /= 3 * twiceArea;
  } else {
    centroidX = centerX;
    centroidY = centerY;
  }
  return {
    area: Math.abs(area),
    areaCentroidX: centroidX,
    areaCentroidY: centroidY,
    maxRadius,
    minRadius,
    meanRadius: meanRadius / count,
    positiveTurns,
    negativeTurns,
  };
}

function orientation(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const abC = orientation(ax, ay, bx, by, cx, cy);
  const abD = orientation(ax, ay, bx, by, dx, dy);
  const cdA = orientation(cx, cy, dx, dy, ax, ay);
  const cdB = orientation(cx, cy, dx, dy, bx, by);
  return abC * abD < 0 && cdA * cdB < 0;
}

function assertSimpleContour(points, count) {
  for (let first = 0; first < count; first++) {
    const firstNext = (first + 1) % count;
    for (let second = first + 2; second < count; second++) {
      const secondNext = (second + 1) % count;
      if (first === 0 && secondNext === 0) continue;
      assert.equal(
        segmentsIntersect(
          points[first * 2],
          points[first * 2 + 1],
          points[firstNext * 2],
          points[firstNext * 2 + 1],
          points[second * 2],
          points[second * 2 + 1],
          points[secondNext * 2],
          points[secondNext * 2 + 1],
        ),
        false,
        "the connected outer contour has no self-intersections",
      );
    }
  }
}

function fakeContext() {
  const calls = { closePath: 0, clip: 0, fill: 0, stroke: 0, shadowBlurs: [], gradients: [] };
  const makeGradient = (kind) => {
    const gradient = {
      kind,
      stops: [],
      addColorStop(offset, color) {
        this.stops.push([offset, color]);
      },
    };
    calls.gradients.push(gradient);
    return gradient;
  };
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    quadraticCurveTo() {},
    closePath() {
      calls.closePath++;
    },
    clip() {
      calls.clip++;
    },
    fill() {
      calls.fill++;
    },
    stroke() {
      calls.stroke++;
    },
    createRadialGradient() {
      return makeGradient("radial");
    },
    createLinearGradient() {
      return makeGradient("linear");
    },
    set shadowBlur(value) {
      calls.shadowBlurs.push(value);
    },
    get shadowBlur() {
      return calls.shadowBlurs.at(-1) ?? 0;
    },
  };
  return { ctx, calls };
}

test("active sound produces one bounded, concave fluid contour and a clipped gel surface", () => {
  const frame = makeToneFrame(0.24, "mid");
  const { points, count } = geometry(frame, { ...FLUID_OPTIONS, detail: "high" });
  assert.equal(count, 160);
  assert.ok(points.every(Number.isFinite));

  const metrics = polygonMetrics(points, count, frame);
  assert.ok(metrics.maxRadius <= Math.min(frame.width, frame.height) * 0.43 + 1e-4);
  assert.ok(metrics.maxRadius > Math.min(frame.width, frame.height) * 0.25);
  assert.ok(
    metrics.positiveTurns > 8 && metrics.negativeTurns > 8,
    "the outline has real concavities",
  );
  assert.ok(metrics.area > 0);
  assert.ok(
    Math.hypot(metrics.areaCentroidX - frame.width / 2, metrics.areaCentroidY - frame.height / 2) <
      Math.min(frame.width, frame.height) * 0.075 + 1e-4,
  );
  assertSimpleContour(points, count);

  const { ctx, calls } = fakeContext();
  blob.liquidBlob.draw(ctx, frame, { ...FLUID_OPTIONS, detail: "high" });
  assert.equal(calls.closePath, 3);
  assert.equal(calls.clip, 1);
  assert.equal(calls.fill, 5);
  assert.equal(calls.stroke, 1);
  assert.ok(
    calls.shadowBlurs.every((value) => value <= Math.min(frame.width, frame.height) * 0.016),
  );
});

test("the production default keeps a broad multi-peak signal visibly fluid", () => {
  const frame = makeBroadMusicFrame();
  const shape = geometry(frame, DEFAULT_OPTIONS);
  const metrics = polygonMetrics(shape.points, shape.count, frame);
  assert.ok(
    (metrics.maxRadius - metrics.minRadius) / metrics.meanRadius > 0.2,
    "the shipped deformation default should show mass movement on broad music",
  );
  assert.ok(metrics.positiveTurns > 4 && metrics.negativeTurns > 4);
  assertSimpleContour(shape.points, shape.count);
});

test("silence and zero deformation are circles; near-silence joins the fluid continuously", () => {
  const silent = makeFrame({ time: 4 });
  const quiet = geometry(silent, { ...DEFAULT_OPTIONS, idleMotion: "off" });
  const quietMetrics = polygonMetrics(quiet.points, quiet.count, silent);
  assert.ok(quietMetrics.maxRadius - quietMetrics.minRadius < 1e-4);

  const active = makeToneFrame(0.31, "mid");
  const undeformed = geometry(active, { ...DEFAULT_OPTIONS, deformation: 0 });
  const undeformedMetrics = polygonMetrics(undeformed.points, undeformed.count, active);
  assert.ok(undeformedMetrics.maxRadius - undeformedMetrics.minRadius < 1e-4);

  const quietLevels = [0, 1e-8, 1e-6, 1e-4, 1e-3, 1e-2];
  const quietShapes = quietLevels.map((level) =>
    geometry(makeQuietToneFrame(level), { ...FLUID_OPTIONS, idleMotion: "off" }),
  );
  for (let index = 1; index < quietShapes.length; index++) {
    assert.ok(
      contourDistance(
        quietShapes[index - 1].points,
        quietShapes[index].points,
        quietShapes[index].count,
      ) < 2.5,
      "quiet asymmetric spectra blend into the circle without a centroid jump",
    );
  }

  const subtleA = geometry({ ...silent, time: 1 }, { ...DEFAULT_OPTIONS, idleMotion: "subtle" });
  const subtleB = geometry({ ...silent, time: 3 }, { ...DEFAULT_OPTIONS, idleMotion: "subtle" });
  const reducedA = geometry({ ...silent, time: 1, reducedMotion: true });
  const reducedB = geometry({ ...silent, time: 9, reducedMotion: true });
  assert.ok(contourDistance(subtleA.points, subtleB.points, subtleA.count) > 0.1);
  assert.deepEqual(reducedA.points, reducedB.points);
});

test("spectral redistribution changes the shape while the beat and broad levels stay fixed", () => {
  const bass = geometry(makeToneFrame(0.12, "mid"), FLUID_OPTIONS);
  const lowerMid = geometry(makeToneFrame(0.28, "mid"), FLUID_OPTIONS);
  const upperMid = geometry(makeToneFrame(0.62, "mid"), FLUID_OPTIONS);
  const treble = geometry(makeToneFrame(0.88, "mid"), FLUID_OPTIONS);
  for (const other of [lowerMid, upperMid, treble]) {
    assert.ok(contourDistance(bass.points, other.points, bass.count) > 3);
  }
  assert.ok(contourDistance(lowerMid.points, upperMid.points, lowerMid.count) > 3);
  assert.deepEqual(
    lowerMid.points,
    geometry({ ...makeToneFrame(0.28, "mid"), time: 80 }, FLUID_OPTIONS).points,
  );
});

test("size, deformation, expansion, detail and sensitivity remain useful controls", () => {
  const frame = makeToneFrame(0.28, "bass");
  const small = geometry(frame, { ...FLUID_OPTIONS, size: 50 });
  const large = geometry(frame, { ...FLUID_OPTIONS, size: 150 });
  assert.ok(
    polygonMetrics(large.points, large.count, frame).area >
      polygonMetrics(small.points, small.count, frame).area,
  );

  const lowDeformation = geometry(frame, { ...FLUID_OPTIONS, deformation: 15 });
  const highDeformation = geometry(frame, { ...FLUID_OPTIONS, deformation: 100 });
  assert.ok(
    contourDistance(lowDeformation.points, highDeformation.points, lowDeformation.count) > 3,
  );

  const noBassExpansion = geometry(frame, { ...FLUID_OPTIONS, bassExpansion: 0 });
  const expanded = geometry(frame, { ...FLUID_OPTIONS, bassExpansion: 100 });
  assert.ok(
    polygonMetrics(expanded.points, expanded.count, frame).area >
      polygonMetrics(noBassExpansion.points, noBassExpansion.count, frame).area,
  );

  const lowSensitivity = geometry({ ...frame, settings: { ...frame.settings, sensitivity: 0.2 } });
  const highSensitivity = geometry({ ...frame, settings: { ...frame.settings, sensitivity: 3 } });
  assert.ok(
    contourDistance(lowSensitivity.points, highSensitivity.points, lowSensitivity.count) > 0.5,
  );
  assert.equal(geometry(frame, { ...FLUID_OPTIONS, detail: "low" }).count, 96);
  assert.equal(geometry(frame, { ...FLUID_OPTIONS, detail: "high" }).count, 160);
});

test("absolute source time is deterministic across FPS, seeks and query order", () => {
  const outputs = [24, 30, 60].map((fps) => {
    const sourceFrame = Math.round(5 * fps);
    return geometry({ ...makeToneFrame(0.36, "mid"), time: sourceFrame / fps }, FLUID_OPTIONS)
      .points;
  });
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(outputs[1], outputs[2]);

  const frame = makeToneFrame(0.51, "mid");
  geometry({ ...frame, time: 8 }, FLUID_OPTIONS);
  const afterSeek = geometry({ ...frame, time: 5 }, FLUID_OPTIONS).points;
  assert.deepEqual(afterSeek, geometry({ ...frame, time: 5 }, FLUID_OPTIONS).points);

  const staticActive = geometry(frame, FLUID_OPTIONS).points;
  assert.deepEqual(staticActive, geometry({ ...frame, time: 25 }, FLUID_OPTIONS).points);
});

test("frequency changes form a smooth, source-timed musical trajectory", () => {
  const centerAt = (time) => 0.22 + Math.min(1, Math.max(0, (time - 1) / 2)) * 0.48;
  const history = {
    revision: 1,
    read(time, target) {
      const center = centerAt(time);
      const length = target.length;
      for (let index = 0; index < length; index++) {
        const distance = (index / (length - 1) - center) / 0.06;
        target[index] = 0.78 * Math.exp(-0.5 * distance * distance);
      }
      return true;
    },
  };
  const descriptors = [];
  for (let step = 0; step <= 8; step++) {
    const time = 1 + step * 0.25;
    const frame = makeToneFrame(centerAt(time), "mid", { time, history });
    const result = geometry(frame, FLUID_OPTIONS);
    const metrics = polygonMetrics(result.points, result.count, frame);
    descriptors.push([
      metrics.areaCentroidX,
      metrics.areaCentroidY,
      metrics.area,
      metrics.maxRadius,
    ]);
  }

  let totalMovement = 0;
  for (let index = 1; index < descriptors.length; index++) {
    const previous = descriptors[index - 1];
    const current = descriptors[index];
    const distance = Math.hypot(current[0] - previous[0], current[1] - previous[1]);
    assert.ok(distance < 12, "mass moves without frame-to-frame jumps");
    totalMovement += distance;
  }
  assert.ok(totalMovement > 8, "the spectrum steers visible mass across the frame");
  const atEnd = geometry(
    makeToneFrame(centerAt(3), "mid", { time: 3, history }),
    FLUID_OPTIONS,
  ).points;
  geometry(makeToneFrame(0.3, "mid", { time: 20, history }), FLUID_OPTIONS);
  assert.deepEqual(
    atEnd,
    geometry(makeToneFrame(centerAt(3), "mid", { time: 3, history }), FLUID_OPTIONS).points,
  );
});

test("low-detail small blobs keep a smooth contour as a narrow peak moves", () => {
  const centerAt = (time) => 0.22 + Math.min(1, Math.max(0, (time - 1) / 2)) * 0.48;
  const history = {
    revision: 1,
    read(time, target) {
      const center = centerAt(time);
      for (let index = 0; index < target.length; index++) {
        const distance = (index / (target.length - 1) - center) / 0.06;
        target[index] = 0.78 * Math.exp(-0.5 * distance * distance);
      }
      return true;
    },
  };
  const options = {
    ...FLUID_OPTIONS,
    size: 50,
    detail: "low",
    fluidity: 100,
    deformation: 85,
  };
  const frameAt = (time) => {
    const spectrum = toneBands(centerAt(time), 96, 0.78, 0.06);
    const sensitivity = 1.3;
    const bass = frequencyHistory.bandEnergy(spectrum, 0, 0.27, sensitivity);
    const mid = frequencyHistory.bandEnergy(spectrum, 0.27, 0.7, sensitivity);
    const treble = frequencyHistory.bandEnergy(spectrum, 0.7, 1, sensitivity);
    const activity = Math.max(bass, mid, treble);
    return makeFrame({
      time,
      width: 320,
      height: 240,
      settings: { ...makeFrame().settings, visualScale: 0.5 },
      history,
      bands: [spectrum],
      audio: {
        activity,
        bass,
        mid,
        treble,
        energy: activity,
        impact: 0,
        bands: [spectrum],
        bandLayers: [],
        ringMix: 0,
      },
    });
  };

  let previous = null;
  let largestAreaStep = 0;
  let largestCentroidStep = 0;
  let largestContourStep = 0;
  for (let frameIndex = 0; frameIndex <= 120; frameIndex++) {
    const frame = frameAt(1 + frameIndex / 60);
    const shape = geometry(frame, options);
    const metrics = polygonMetrics(shape.points, shape.count, frame);
    assert.ok(shape.points.every(Number.isFinite));
    assert.ok(metrics.maxRadius <= Math.min(frame.width, frame.height) * 0.43 + 1e-4);
    if (previous) {
      largestAreaStep = Math.max(largestAreaStep, Math.abs(metrics.area - previous.metrics.area));
      largestCentroidStep = Math.max(
        largestCentroidStep,
        Math.hypot(
          metrics.areaCentroidX - previous.metrics.areaCentroidX,
          metrics.areaCentroidY - previous.metrics.areaCentroidY,
        ),
      );
      largestContourStep = Math.max(
        largestContourStep,
        contourMaxDistance(shape.points, previous.points, shape.count),
      );
    }
    previous = { points: shape.points.slice(0, shape.count * 2), metrics };
  }

  assert.ok(largestAreaStep < 100, `one-frame area change was ${largestAreaStep.toFixed(1)} px²`);
  assert.ok(
    largestCentroidStep < 4,
    `one-frame centroid move was ${largestCentroidStep.toFixed(1)} px`,
  );
  assert.ok(
    largestContourStep < 12,
    `one-frame contour move was ${largestContourStep.toFixed(1)} px`,
  );
});

test("response retains fast attacks and settling while unavailable history uses current audio", () => {
  const readTimes = [];
  const levelAt = (time) => (time >= 0.97 && time < 1.03 ? 0.78 : 0);
  const history = {
    revision: 1,
    read(time, target) {
      readTimes.push(time);
      target.fill(levelAt(time));
      return true;
    },
  };
  const frameAt = (time, level, historySource) => {
    const frame = makeLevelFrame(level, { time, history: historySource, reducedMotion: true });
    return frame;
  };
  const options = { ...FLUID_OPTIONS, idleMotion: "off" };
  const quiet = geometry(frameAt(0.8, 0, undefined), options);
  const attack = geometry(frameAt(1, 0.78, history), options);
  const releaseDry = geometry(frameAt(1.1, 0, history), { ...options, fluidity: 0 });
  readTimes.length = 0;
  const releaseWet = geometry(frameAt(1.1, 0, history), { ...options, fluidity: 100 });
  const quietMean = polygonMetrics(quiet.points, quiet.count, frameAt(0.8, 0)).meanRadius;
  const attackMean = polygonMetrics(attack.points, attack.count, frameAt(1, 0.78)).meanRadius;
  const dryMean = polygonMetrics(releaseDry.points, releaseDry.count, frameAt(1.1, 0)).meanRadius;
  const wetMean = polygonMetrics(releaseWet.points, releaseWet.count, frameAt(1.1, 0)).meanRadius;
  const attackChange = contourDistance(attack.points, quiet.points, attack.count);
  const releaseChange = contourDistance(releaseWet.points, releaseDry.points, releaseWet.count);

  assert.ok(attackMean > quietMean + 4, "current audio appears on the attack frame");
  assert.ok(Math.abs(dryMean - quietMean) < 0.1, "zero fluidity uses current measurements only");
  assert.ok(wetMean > dryMean + 1, "fluidity blends the measured release envelope");
  assert.ok(
    releaseChange > 1 && releaseChange < attackChange,
    "the release responds, then settles",
  );
  assert.ok(readTimes.includes(1.1 - 0.18), "shape velocity reads a short raw source-time lag");
  assert.ok(readTimes.every((time) => time <= 1.1 && time >= 1.1 - 0.9 - 1e-6));

  const unavailable = geometry({ ...frameAt(1.1, 0), history: { read: () => false } }, options);
  assert.deepEqual(unavailable.points, releaseDry.points);
});

test("high settings keep the whole single contour finite and inside the frame bound", () => {
  for (const [width, height] of [
    [1280, 720],
    [720, 1280],
    [960, 960],
  ]) {
    const frame = makeToneFrame(0.23, "bass", { width, height });
    frame.settings.visualScale = 1.5;
    frame.audio = { ...frame.audio, bass: 1, mid: 1, treble: 1, impact: 1 };
    const shape = geometry(frame, {
      ...FLUID_OPTIONS,
      size: 150,
      deformation: 100,
      bassExpansion: 100,
      detail: "high",
    });
    assert.ok(shape.points.every(Number.isFinite));
    const metrics = polygonMetrics(shape.points, shape.count, frame);
    assert.ok(metrics.maxRadius <= Math.min(width, height) * 0.43 + 1e-4);
    assert.ok(metrics.area > Math.PI * Math.min(width, height) ** 2 * 0.01);
    assertSimpleContour(shape.points, shape.count);
  }
});

test("the gel material has soft volume without a hard white patch or optional rim at glow zero", () => {
  const frame = makeToneFrame(0.36, "mid");
  const { ctx, calls } = fakeContext();
  blob.liquidBlob.draw(ctx, frame, { ...FLUID_OPTIONS, internalGlow: 0 });

  assert.equal(calls.clip, 1);
  assert.equal(calls.stroke, 0);
  assert.equal(calls.fill, 4);
  assert.equal(calls.closePath, 2);
  const highlight = calls.gradients.find((gradient) =>
    gradient.stops.some(([, color]) => color.includes("255,255,255")),
  );
  assert.ok(highlight);
  const alpha = highlight.stops.map(([, color]) => Number(color.match(/,([\d.]+)\)$/)?.[1] ?? 0));
  assert.ok(Math.max(...alpha) <= 0.18);
  assert.ok(highlight.stops.some(([, color]) => color.includes("97,229,255")));

  const darkGradients = calls.gradients.filter((gradient) =>
    gradient.stops.some(([, color]) => color.includes("0,0,0")),
  );
  assert.equal(darkGradients.length, 2);
  const glowing = fakeContext();
  blob.liquidBlob.draw(glowing.ctx, frame, { ...FLUID_OPTIONS, internalGlow: 70 });
  assert.equal(glowing.calls.stroke, 1);
  assert.equal(glowing.calls.fill, 5);
});

test("non-finite inputs stay bounded without contaminating reusable geometry", () => {
  const brokenSpectrum = new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, -0.5]);
  const broken = makeFrame({
    time: Number.NaN,
    settings: { ...makeFrame().settings, sensitivity: Number.NaN, visualScale: Number.NaN },
    audio: {
      ...makeFrame().audio,
      bass: Number.NaN,
      mid: Number.POSITIVE_INFINITY,
      bands: [brokenSpectrum],
    },
  });
  const safe = geometry(broken, { ...FLUID_OPTIONS, size: Number.NaN });
  assert.ok(safe.points.every(Number.isFinite));
  const next = geometry(makeToneFrame(0.36, "mid"));
  assert.ok(next.points.every(Number.isFinite));
});
