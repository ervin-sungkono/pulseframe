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
      calls.closePath += 1;
    },
    clip() {
      calls.clip += 1;
    },
    fill() {
      calls.fill += 1;
    },
    stroke() {
      calls.stroke += 1;
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
    "surface, clipping contour and the optional rim use the shared smooth spline",
  );
  assert.equal(calls.clip, 1, "soft shading is constrained to the deformed contour");
  assert.equal(calls.fill, 5);
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

  const crisp = geometry({ ...frame, time: 4 }, { ...DEFAULT_OPTIONS, fluidity: 0 });
  const soft = geometry({ ...frame, time: 4 }, { ...DEFAULT_OPTIONS, fluidity: 100 });
  assert.ok(contourDifference(crisp.points, soft.points, crisp.count) > 0.1);

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

test("sustained music holds its shape until the measured audio changes", () => {
  // Representative already-normalized levels from the shared analysis pipeline.
  // The previous second gain/limiter made loud music almost static and circular.
  const frame = makeFrame({ width: 1280, height: 720, time: 60 });
  frame.audio = {
    ...frame.audio,
    activity: 0.92,
    energy: 0.92,
    bass: 0.92,
    mid: 0.8,
    treble: 0.28,
    bands: [new Float32Array(96).fill(0.16)],
  };
  const first = geometry(frame);
  const later = geometry({ ...frame, time: 60.5 });
  const radius = radii(first.points, first.count, frame);
  const average = radius.reduce((sum, value) => sum + value, 0) / first.count;
  assert.ok((Math.max(...radius) - Math.min(...radius)) / average > 0.13);
  assert.deepEqual(first.points, later.points, "the clock alone must not rotate an active contour");

  const quieter = geometry({ ...frame, audio: { ...frame.audio, bass: 0.55 } });
  const quieterRadius = radii(quieter.points, quieter.count, frame);
  const quieterMean = quieterRadius.reduce((sum, value) => sum + value, 0) / quieter.count;
  assert.ok(average - quieterMean > 720 * 0.008, "bass changes remain visible at high levels");
});

test("maximum controls fit the whole silhouette without clipping its lobes into a circle", () => {
  for (const [width, height] of [
    [1280, 720],
    [720, 1280],
    [960, 960],
  ]) {
    const frame = makeToneFrame(0.23, "bass");
    frame.width = width;
    frame.height = height;
    frame.settings.visualScale = 1.5;
    frame.audio = { ...frame.audio, bass: 1, mid: 1, treble: 1, impact: 1 };
    const options = {
      ...DEFAULT_OPTIONS,
      size: 150,
      deformation: 100,
      bassExpansion: 100,
      detail: "high",
    };
    const shape = geometry(frame, options);
    const radius = radii(shape.points, shape.count, frame);
    const average = radius.reduce((sum, value) => sum + value, 0) / shape.count;
    const maximum = Math.max(...radius);
    assert.ok(maximum <= Math.min(width, height) * 0.43 + 1e-4);
    assert.ok(Math.min(...radius) > Math.min(width, height) * 0.025);
    assert.ok((maximum - Math.min(...radius)) / average > 0.2);
    assert.ok(radius.filter((value) => maximum - value < 0.01).length < shape.count * 0.1);
  }
});

test("idle flow stays finite and continuous while active geometry stays independent of the clock", () => {
  const frame = makeToneFrame(0.51, "mid");
  const extreme = geometry({ ...frame, time: Number.MAX_VALUE });
  assert.ok(extreme.points.every(Number.isFinite));
  const silent = makeFrame();
  const period = (Math.PI * 2 * 20) / 0.6;
  const before = geometry({ ...silent, time: period - 1e-6 });
  const after = geometry({ ...silent, time: period + 1e-6 });
  assert.ok(contourDifference(before.points, after.points, before.count) < 0.001);
});

test("frequency distribution drives local bulges even with unchanged beat and broad-band levels", () => {
  const first = makeToneFrame(0.25, "mid");
  first.width = 1280;
  first.height = 720;
  const shifted = makeToneFrame(0.62, "mid");
  shifted.width = 1280;
  shifted.height = 720;
  const atFirstPitch = geometry(first);
  const atSecondPitch = geometry(shifted);
  assert.equal(first.audio.impact, shifted.audio.impact);
  assert.equal(first.audio.mid, shifted.audio.mid);
  assert.ok(contourDifference(atFirstPitch.points, atSecondPitch.points, atFirstPitch.count) > 8);
  assert.deepEqual(atFirstPitch.points, geometry({ ...first, time: 120 }).points);
});

test("fluidity uses measured source-time response, with current data as the fallback", () => {
  const frame = makeToneFrame(0.62, "mid");
  const pastBands = makeToneFrame(0.25, "mid").audio.bands[0];
  const readTimes = [];
  frame.history = {
    read(time, target) {
      readTimes.push(time);
      if (time < 0) return false;
      for (let i = 0; i < target.length; i++) {
        const position = (i * (pastBands.length - 1)) / (target.length - 1);
        const first = Math.floor(position);
        const fraction = position - first;
        target[i] =
          pastBands[first] * (1 - fraction) +
          pastBands[Math.min(first + 1, pastBands.length - 1)] * fraction;
      }
      return true;
    },
  };
  const first = geometry(frame);
  assert.ok(readTimes.length > 1, "the response adapter samples a bounded measured history window");
  assert.ok(readTimes.every((time) => time <= frame.time && time >= frame.time - 0.9 - 1e-6));
  assert.ok(
    readTimes.includes(frame.time),
    "the response begins at the requested absolute source time",
  );
  const currentOnly = geometry({ ...frame, history: undefined });
  assert.ok(contourDifference(first.points, currentOnly.points, first.count) > 0.1);
  geometry({ ...frame, time: frame.time + 0.5 });
  assert.deepEqual(
    first.points,
    geometry(frame).points,
    "query order cannot advance hidden blob state",
  );
  const unavailable = geometry({ ...frame, history: { read: () => false } });
  assert.deepEqual(unavailable.points, currentOnly.points);
});

test("fast attacks stay visible while a measured release settles by fluidity", () => {
  const attackTime = 1;
  const sourceLevelAt = (time) => (time >= 0.97 && time < 1.03 ? 0.78 : 0);
  const history = {
    read(time, target) {
      if (time < 0) return false;
      target.fill(sourceLevelAt(time));
      return true;
    },
  };
  const frameAt = (time, level, historySource) => {
    const bands = new Float32Array(96).fill(level);
    return makeFrame({
      time,
      history: historySource,
      bands: [bands],
      reducedMotion: true,
      audio: {
        activity: 1 - Math.exp(-level * 1.3 * 8),
        bass: 1 - Math.exp(-level * 1.3 * 8),
        mid: 1 - Math.exp(-level * 1.3 * 8),
        treble: 1 - Math.exp(-level * 1.3 * 8),
        energy: 1 - Math.exp(-level * 1.3 * 8),
        impact: 0,
        bands: [bands],
        bandLayers: [],
        ringMix: 0,
      },
    });
  };
  const quietOptions = { ...DEFAULT_OPTIONS, idleMotion: "off" };
  const quietFrame = frameAt(0.8, 0, undefined);
  const attackFrame = frameAt(attackTime, 0.78, history);
  const releaseFrame = frameAt(1.1, 0, history);
  const quiet = geometry(quietFrame, quietOptions);
  const attack = geometry(attackFrame, quietOptions);
  const releaseDry = geometry(releaseFrame, { ...quietOptions, fluidity: 0 });
  const releaseWet = geometry(releaseFrame, { ...quietOptions, fluidity: 100 });
  const quietRadius =
    radii(quiet.points, quiet.count, quietFrame).reduce((sum, value) => sum + value, 0) /
    quiet.count;
  const attackRadius =
    radii(attack.points, attack.count, attackFrame).reduce((sum, value) => sum + value, 0) /
    attack.count;
  const releaseDryRadius =
    radii(releaseDry.points, releaseDry.count, releaseFrame).reduce(
      (sum, value) => sum + value,
      0,
    ) / releaseDry.count;
  const releaseWetRadius =
    radii(releaseWet.points, releaseWet.count, releaseFrame).reduce(
      (sum, value) => sum + value,
      0,
    ) / releaseWet.count;

  assert.ok(
    attackRadius > quietRadius + 2,
    "current measurements produce an immediate visible attack",
  );
  assert.ok(
    releaseDryRadius <= quietRadius + 0.001,
    "fluidity zero uses the current measured frame",
  );
  assert.ok(
    releaseWetRadius > releaseDryRadius + 0.5,
    "fluidity blends the measured release tail back into the current frame",
  );
  assert.ok(releaseWetRadius < attackRadius, "the source-time response settles after the attack");
});

test("the clipped gel surface keeps soft color shading when internal glow is disabled", () => {
  const frame = makeToneFrame(0.36, "mid");
  const { ctx, calls } = fakeContext();
  blob.liquidBlob.draw(ctx, frame, { ...DEFAULT_OPTIONS, internalGlow: 0 });

  assert.equal(calls.clip, 1);
  assert.equal(calls.stroke, 0, "internal contours are controlled by internalGlow");
  assert.equal(calls.fill, 4, "base fill and three clipped shading passes remain visible");
  assert.equal(calls.closePath, 2, "disabling internalGlow removes its inset contour");
  const highlight = calls.gradients.find((gradient) =>
    gradient.stops.some(([, color]) => color.includes("255,255,255")),
  );
  assert.ok(highlight, "the surface contains an off-center soft highlight");
  const alpha = highlight.stops.map(([, color]) => Number(color.match(/,([\d.]+)\)$/)?.[1] ?? 0));
  assert.ok(
    Math.max(...alpha) <= 0.18,
    "the highlight stays restrained instead of flattening to white",
  );
  assert.ok(highlight.stops.some(([, color]) => color.includes("97,229,255")));
  assert.ok(
    highlight.stops.some(([, color]) => color.includes("255,255,255,0.12")),
    "the small highlight mixes a low-opacity white center with the secondary color",
  );

  const darkGradients = calls.gradients.filter((gradient) =>
    gradient.stops.some(([, color]) => color.includes("0,0,0")),
  );
  assert.equal(darkGradients.length, 2, "directional and edge shading use neutral dark tint");
  const maxDarkAlpha = Math.max(
    ...darkGradients.flatMap((gradient) =>
      gradient.stops.map(([, color]) => Number(color.match(/,([\d.]+)\)$/)?.[1] ?? 0)),
    ),
  );
  assert.ok(maxDarkAlpha >= 0.16 && maxDarkAlpha <= 0.17);

  const withGlow = fakeContext();
  blob.liquidBlob.draw(withGlow.ctx, frame, { ...DEFAULT_OPTIONS, internalGlow: 70 });
  assert.equal(
    withGlow.calls.stroke,
    1,
    "internalGlow adds one subtle deformation-following directional rim",
  );
  assert.equal(withGlow.calls.fill, 5);
  assert.equal(withGlow.calls.closePath, 3);
});

test("idle motion fades smoothly across the quiet threshold", () => {
  const frame = makeFrame({ time: 5 });
  const atLevel = (level) =>
    geometry(
      {
        ...frame,
        audio: {
          ...frame.audio,
          bass: level,
          mid: level,
          treble: level,
          impact: 0,
          bands: [new Float32Array(96).fill(level)],
        },
      },
      { ...DEFAULT_OPTIONS, idleMotion: "subtle" },
    );
  const before = atLevel(frame.settings.quietThreshold - 1e-6);
  const after = atLevel(frame.settings.quietThreshold + 1e-6);
  assert.ok(
    contourDifference(before.points, after.points, before.count) < 0.01,
    "nearly equal quiet measurements must not switch on a different idle contour",
  );
});

test("audio sensitivity scales local frequency deformation without changing supplied broad features", () => {
  const frame = makeToneFrame(0.4, "mid");
  const before = { bass: frame.audio.bass, mid: frame.audio.mid, treble: frame.audio.treble };
  const low = geometry({ ...frame, settings: { ...frame.settings, sensitivity: 0.2 } });
  const high = geometry({ ...frame, settings: { ...frame.settings, sensitivity: 3 } });
  assert.ok(contourDifference(low.points, high.points, low.count) > 0.5);
  assert.deepEqual(
    { bass: frame.audio.bass, mid: frame.audio.mid, treble: frame.audio.treble },
    before,
  );
});
