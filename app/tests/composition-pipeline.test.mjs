import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const {
  MAX_CIRCLE_INSTANCES,
  activeVisualizers,
  compositionSchema,
  defaultComposition,
  duplicateVisualizer,
} = modules["composition/model"];
const { boundedTransform, framePoint, hitFrame } = modules["composition/geometry"];
const { drawVisualization, createAudioReactiveState } = modules.visualizer;
const { DEFAULT_SETTINGS } = modules["customizer-config"];

function recordingContext(width = 1280, height = 720) {
  const operations = [];
  const gradients = [];
  const ringCenters = [];
  const imageCenters = [];
  const transformStack = [];
  let transform = [1, 0, 0, 1, 0, 0];
  const transformedPoint = (x, y) => ({
    x: transform[0] * x + transform[2] * y + transform[4],
    y: transform[1] * x + transform[3] * y + transform[5],
  });
  const ctx = new Proxy(
    { canvas: { width, height }, globalAlpha: 1 },
    {
      set(target, key, value) {
        if (typeof value === "number") operations.push([String(key), value]);
        target[key] = value;
        return true;
      },
      get(target, key) {
        if (key in target) return target[key];
        if (key === "save")
          return () => {
            transformStack.push(transform);
            transform = [...transform];
          };
        if (key === "restore")
          return () => {
            transform = transformStack.pop() ?? transform;
          };
        if (key === "translate")
          return (x, y) => {
            transform[4] += transform[0] * x + transform[2] * y;
            transform[5] += transform[1] * x + transform[3] * y;
            operations.push([String(key), x, y]);
          };
        if (key === "rotate")
          return (angle) => {
            const [a, b, c, d, e, f] = transform;
            const cosine = Math.cos(angle);
            const sine = Math.sin(angle);
            transform = [
              a * cosine + c * sine,
              b * cosine + d * sine,
              c * cosine - a * sine,
              d * cosine - b * sine,
              e,
              f,
            ];
            operations.push([String(key), angle]);
          };
        if (key === "scale")
          return (x, y) => {
            transform[0] *= x;
            transform[1] *= x;
            transform[2] *= y;
            transform[3] *= y;
            operations.push([String(key), x, y]);
          };
        if (key === "arc")
          return (...args) => {
            ringCenters.push(transformedPoint(args[0], args[1]));
            operations.push([String(key), ...args]);
          };
        if (key === "drawImage")
          return (...args) => {
            const destination = args.length >= 9 ? 5 : 1;
            imageCenters.push(
              transformedPoint(
                args[destination] + args[destination + 2] / 2,
                args[destination + 1] + args[destination + 3] / 2,
              ),
            );
            operations.push([
              String(key),
              ...args.filter((argument) => typeof argument === "number"),
            ]);
          };
        if (key === "createLinearGradient" || key === "createRadialGradient") {
          return (...args) => {
            const gradient = {
              kind: key,
              args,
              stops: [],
              addColorStop(...stop) {
                this.stops.push(stop);
              },
            };
            gradients.push(gradient);
            return gradient;
          };
        }
        if (key === "measureText") return (text) => ({ width: String(text).length * 8 });
        return (...args) => {
          if (args.some((argument) => typeof argument === "number"))
            operations.push([
              String(key),
              ...args.filter((argument) => typeof argument === "number"),
            ]);
        };
      },
    },
  );
  return { ctx, operations, gradients, ringCenters, imageCenters };
}

function renderScene(composition, settings = {}) {
  const rendered = recordingContext();
  drawVisualization(
    rendered.ctx,
    {
      ...DEFAULT_SETTINGS,
      mode: "ring",
      backdrop: "clean",
      particles: false,
      trails: false,
      beatRays: false,
      glitch: false,
      dropEffects: false,
      showTrackInfo: false,
      ringLayers: 1,
      ...settings,
    },
    new Uint8Array(2048),
    new Uint8Array(4096).fill(128),
    [],
    0,
    0,
    null,
    null,
    createAudioReactiveState(),
    48_000,
    0,
    [],
    { composition },
  );
  return rendered;
}

test("duplicating a selected visualizer retains its own palette and frame", () => {
  const composition = duplicateVisualizer(defaultComposition());
  composition.visualizers[0].palette = { primary: "#ff0000", secondary: "#00ff00" };
  composition.visualizers[1].palette = { primary: "#0000ff", secondary: "#ffff00" };
  composition.visualizers[0].transform.rotation = 25;
  const next = duplicateVisualizer(composition, composition.visualizers[0].id);
  const duplicate = next.visualizers.at(-1);
  assert.deepEqual(duplicate.palette, composition.visualizers[0].palette);
  assert.notEqual(duplicate.palette, composition.visualizers[0].palette);
  assert.equal(duplicate.transform.rotation, 25);
  assert.equal(duplicate.transform.x, composition.visualizers[0].transform.x + 0.04);
  assert.notEqual(duplicate.id, composition.visualizers[0].id);
  assert.equal(duplicateVisualizer(composition, "missing"), composition);
});

test("circular compositions cap at four visualizers and keep one style across instances", () => {
  let composition = defaultComposition();
  for (let index = 1; index < MAX_CIRCLE_INSTANCES; index += 1)
    composition = duplicateVisualizer(composition);
  assert.equal(composition.visualizers.length, 4);
  assert.equal(duplicateVisualizer(composition), composition, "the fifth duplicate is ignored");
  assert.equal(activeVisualizers(composition, "ring").length, 4);
  assert.equal(activeVisualizers(composition, "radial").length, 4);
  assert.equal(activeVisualizers(composition, "spectrum").length, 1);
  assert.equal(activeVisualizers(composition, "edges").length, 1);
  assert.equal(
    compositionSchema.safeParse({
      ...composition,
      visualizers: [...composition.visualizers, { ...composition.visualizers[0], id: "fifth" }],
    }).success,
    false,
  );

  composition.visualizers = [
    {
      ...composition.visualizers[0],
      palette: { primary: "#ff0000", secondary: "#00ff00" },
    },
    {
      ...composition.visualizers[1],
      palette: { primary: "#0000ff", secondary: "#ffff00" },
    },
  ];
  const { gradients } = renderScene(composition);
  const ringGradients = gradients.filter((gradient) => gradient.kind === "createLinearGradient");
  assert.equal(ringGradients.length, 2, "both instances render through the shared Ring style");
  const colors = ringGradients.flatMap((gradient) => gradient.stops.map(([, color]) => color));
  for (const color of ["#ff0000", "#00ff00", "#0000ff", "#ffff00"])
    assert.ok(colors.includes(color), `the instance palette includes ${color}`);
});

test("an attached logo follows the same audio-reactive motion as its ring frame", () => {
  const { PcmFeatures } = modules["audio-features"];
  const width = 1280;
  const height = 720;
  const frame = { x: 0.54, y: 0.43, width: 0.76, height: 0.68, rotation: 17 };
  const composition = defaultComposition();
  composition.visualizers[0].transform = frame;
  const settings = {
    ...DEFAULT_SETTINGS,
    mode: "ring",
    motionPreset: "orbit",
    motionBehavior: "audio-reactive",
    motionAmount: 100,
    visualScale: 1,
    cameraShake: false,
    particles: false,
    trails: false,
    beatRays: false,
    glitch: false,
    dropEffects: false,
    logoAutoFit: { ...DEFAULT_SETTINGS.logoAutoFit, ring: false },
    logoPlacements: {
      ...DEFAULT_SETTINGS.logoPlacements,
      ring: { x: 50, y: 50, size: 20 },
    },
  };
  const sound = new PcmFeatures([new Float32Array(48_000)], 48_000, 0, "js").at(0.8);
  const state = createAudioReactiveState();
  state.activity = 1;
  state.ringPulse = 1;
  state.motionPulse = 0.25;
  const rendered = recordingContext(width, height);

  drawVisualization(
    rendered.ctx,
    settings,
    sound.frequency,
    sound.wave,
    [],
    2,
    0,
    null,
    { width: 256, height: 256 },
    state,
    48_000,
    1,
    [],
    { sound, composition },
  );

  assert.ok(rendered.ringCenters.length > 0, "the selected ring frame should be drawn");
  assert.equal(rendered.imageCenters.length, 1, "the attached logo should be drawn once");
  for (const center of rendered.ringCenters) {
    assert.ok(
      Math.hypot(center.x - rendered.imageCenters[0].x, center.y - rendered.imageCenters[0].y) <
        1e-6,
      "the ring and attached logo should share one transformed center",
    );
  }
  assert.ok(
    Math.hypot(
      rendered.ringCenters[0].x - frame.x * width,
      rendered.ringCenters[0].y - frame.y * height,
    ) > 1,
    "the test exercises a non-identity animated frame",
  );
  assert.notEqual(state.motionPulse, state.ringPulse, "the two response envelopes must differ");
});

test("empty silent compositions and bounded geometry keep every transform finite", () => {
  const emptyComposition = { ...defaultComposition(), visualizers: [], elements: [] };
  const { operations } = renderScene(emptyComposition);
  assert.ok(operations.length > 0, "the shared renderer still paints the frame background");
  assert.ok(
    operations
      .flat()
      .filter((value) => typeof value === "number")
      .every(Number.isFinite),
  );

  const transform = boundedTransform({
    x: Number.NaN,
    y: Number.POSITIVE_INFINITY,
    width: Number.NaN,
    height: -10,
    rotation: Number.NEGATIVE_INFINITY,
  });
  assert.ok(Object.values(transform).every(Number.isFinite));
  assert.deepEqual(transform, { x: 0.5, y: 0.5, width: 1, height: 0.03, rotation: 0 });
  const center = framePoint(transform, 640, 360, 1280, 720);
  assert.deepEqual(center, { x: 0.5, y: 0.5 });
  assert.equal(hitFrame(transform, 640, 360, 1280, 720), true);
});
