import assert from "node:assert/strict";
import test from "node:test";

import { loadSources } from "./load-source.mjs";

const { "liquid-blob": blob } = await loadSources();
const DEFAULT_OPTIONS = {
  size: 100,
  deformation: 35,
  fluidity: 60,
  detail: "medium",
  bassExpansion: 70,
  internalGlow: 45,
  idleMotion: "subtle",
};

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

function geometry(frame, options = DEFAULT_OPTIONS) {
  const points = new Float32Array(320);
  const count = blob.writeLiquidBlobGeometry(points, frame, options);
  return { points, count };
}

function makeToneFrame(position, field) {
  const spectrum = new Float32Array(256);
  for (let index = 0; index < spectrum.length; index += 1) {
    const distance = (index / (spectrum.length - 1) - position) / 0.045;
    spectrum[index] = 0.82 * Math.exp(-0.5 * distance * distance);
  }
  return makeFrame({
    bands: [spectrum],
    audio: {
      activity: 0.7,
      bass: field === "bass" ? 0.7 : 0,
      mid: field === "mid" ? 0.7 : 0,
      treble: field === "treble" ? 0.7 : 0,
      energy: 0.7,
      impact: 0,
      bands: [spectrum],
      bandLayers: [],
      ringMix: 0,
    },
  });
}

function center(frame) {
  return [frame.width / 2, frame.height / 2];
}

function radii(points, count, frame) {
  const [cx, cy] = center(frame);
  return Array.from({ length: count }, (_, index) =>
    Math.hypot(points[index * 2] - cx, points[index * 2 + 1] - cy),
  );
}

function contourDifference(a, b, count) {
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = a[index * 2] - b[index * 2];
    const dy = a[index * 2 + 1] - b[index * 2 + 1];
    total += Math.hypot(dx, dy);
  }
  return total / count;
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

function fakeContext() {
  const calls = { closePath: 0, fill: 0, stroke: 0, shadowBlurs: [] };
  const gradient = { addColorStop() {} };
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    quadraticCurveTo() {},
    closePath() {
      calls.closePath += 1;
    },
    fill() {
      calls.fill += 1;
    },
    stroke() {
      calls.stroke += 1;
    },
    createRadialGradient() {
      return gradient;
    },
    createLinearGradient() {
      return gradient;
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

test("writes a bounded, angularly ordered contour and draws it as a closed smooth curve", () => {
  const frame = makeToneFrame(0.22, "bass");
  const { points, count } = geometry(frame, { ...DEFAULT_OPTIONS, detail: "high" });
  assert.equal(count, 160);

  const [cx, cy] = center(frame);
  const angleStep = (Math.PI * 2) / count;
  const angleAt = (index) => {
    const raw = Math.atan2(points[index * 2 + 1] - cy, points[index * 2] - cx);
    return (raw + Math.PI * 2) % (Math.PI * 2);
  };
  const contourRadii = radii(points, count, frame);
  assert.ok(Math.min(...contourRadii) > 0, "the contour stays away from the center");
  assert.ok(Math.max(...contourRadii) <= Math.min(frame.width, frame.height) * 0.43 + 1e-4);

  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const delta = (angleAt(next) - angleAt(index) + Math.PI * 2) % (Math.PI * 2);
    assert.ok(delta > 0, "polar angle advances positively");
    assert.ok(
      Math.abs(delta - angleStep) < angleStep * 0.08,
      "angular samples remain evenly spaced",
    );
  }

  for (let first = 0; first < count; first += 1) {
    const firstNext = (first + 1) % count;
    for (let second = first + 2; second < count; second += 1) {
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
        "non-neighboring contour edges do not cross",
      );
    }
  }

  const { ctx, calls } = fakeContext();
  blob.liquidBlob.draw(ctx, frame, DEFAULT_OPTIONS);
  assert.equal(
    calls.closePath,
    3,
    "surface, radial interior and highlight each use a closed B-spline",
  );
  assert.equal(calls.fill, 2);
  assert.equal(calls.stroke, 1);
  assert.ok(
    calls.shadowBlurs.every((value) => value <= Math.min(frame.width, frame.height) * 0.016),
  );
});

test("silence stays circular when idle motion is off", () => {
  const frame = makeFrame();
  const { points, count } = geometry(frame, { ...DEFAULT_OPTIONS, idleMotion: "off" });
  const contourRadii = radii(points, count, frame);
  const average = contourRadii.reduce((sum, radius) => sum + radius, 0) / count;
  assert.ok(contourRadii.every((radius) => Math.abs(radius - average) < 1e-4));
});

test("bass, mid and treble tones produce distinct contours", () => {
  const tones = [
    geometry(makeToneFrame(0.12, "bass")),
    geometry(makeToneFrame(0.51, "mid")),
    geometry(makeToneFrame(0.89, "treble")),
  ];
  assert.equal(new Set(tones.map(({ count }) => count)).size, 1);
  assert.ok(contourDifference(tones[0].points, tones[1].points, tones[0].count) > 0.25);
  assert.ok(contourDifference(tones[0].points, tones[2].points, tones[0].count) > 0.25);
  assert.ok(contourDifference(tones[1].points, tones[2].points, tones[1].count) > 0.25);
});

test("reduced motion removes idle animation while preserving audio response", () => {
  const silentAtOne = makeFrame({ time: 1, reducedMotion: true });
  const silentAtNine = makeFrame({ time: 9, reducedMotion: true });
  const first = geometry(silentAtOne);
  const later = geometry(silentAtNine);
  assert.deepEqual([...first.points], [...later.points]);

  const active = makeToneFrame(0.2, "bass");
  active.reducedMotion = true;
  const activeShape = geometry(active);
  const silentShape = geometry({ ...active, audio: makeFrame().audio });
  assert.ok(contourDifference(activeShape.points, silentShape.points, activeShape.count) > 0.25);
});

test("size, deformation, fluidity, expansion and detail controls affect output", () => {
  const frame = makeToneFrame(0.23, "bass");
  const small = geometry(frame, { ...DEFAULT_OPTIONS, size: 50 });
  const large = geometry(frame, { ...DEFAULT_OPTIONS, size: 150 });
  assert.ok(
    radii(large.points, large.count, frame).reduce((sum, value) => sum + value, 0) >
      radii(small.points, small.count, frame).reduce((sum, value) => sum + value, 0),
  );

  const still = geometry({ ...frame, time: 4 }, { ...DEFAULT_OPTIONS, fluidity: 0 });
  const flowing = geometry({ ...frame, time: 4 }, { ...DEFAULT_OPTIONS, fluidity: 100 });
  assert.ok(contourDifference(still.points, flowing.points, still.count) > 0.1);

  const undeformed = geometry(frame, { ...DEFAULT_OPTIONS, deformation: 0 });
  const deformed = geometry(frame, { ...DEFAULT_OPTIONS, deformation: 100 });
  assert.ok(contourDifference(undeformed.points, deformed.points, undeformed.count) > 0.1);

  const noExpansion = radii(
    geometry(frame, { ...DEFAULT_OPTIONS, bassExpansion: 0 }).points,
    small.count,
    frame,
  );
  const expanded = radii(
    geometry(frame, { ...DEFAULT_OPTIONS, bassExpansion: 100 }).points,
    small.count,
    frame,
  );
  assert.ok(
    expanded.reduce((sum, value) => sum + value, 0) >
      noExpansion.reduce((sum, value) => sum + value, 0),
  );
  assert.equal(geometry(frame, { ...DEFAULT_OPTIONS, detail: "low" }).count, 96);
  assert.equal(geometry(frame, { ...DEFAULT_OPTIONS, detail: "high" }).count, 160);
});

test("NaN frame data is contained and same source time matches at 24, 30 and 60 FPS", () => {
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
  const { points: safe, count } = geometry(broken, { ...DEFAULT_OPTIONS, size: Number.NaN });
  for (let index = 0; index < count * 2; index += 1) assert.ok(Number.isFinite(safe[index]));

  const outputs = [24, 30, 60].map((fps) => {
    const sourceFrame = Math.round(5 * fps);
    return geometry({ ...makeToneFrame(0.36, "mid"), time: sourceFrame / fps }).points;
  });
  assert.deepEqual([...outputs[0]], [...outputs[1]]);
  assert.deepEqual([...outputs[1]], [...outputs[2]]);

  const outOfOrderFrame = makeToneFrame(0.36, "mid");
  geometry({ ...outOfOrderFrame, time: 8 });
  const atFiveAfterEight = geometry({ ...outOfOrderFrame, time: 5 }).points;
  const atFiveDirectly = geometry({ ...outOfOrderFrame, time: 5 }).points;
  assert.deepEqual([...atFiveAfterEight], [...atFiveDirectly]);
});
