import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { ringMotion, cameraMotion } = modules.motion;
const { DEFAULT_SETTINGS } = modules["customizer-config"];
const identity = { x: 0, y: 0, rotation: 0, scale: 1 };
const settings = {
  ...DEFAULT_SETTINGS,
  motionSpeed: 1,
  motionPreset: "none",
  motionAmount: 50,
  cameraShake: false,
  cameraShakeAmount: 35,
};

function finiteTransform(transform) {
  for (const value of Object.values(transform)) assert.ok(Number.isFinite(value));
}

function without(source, key) {
  const result = { ...source };
  delete result[key];
  return result;
}

test("ring motion is a pure function of absolute media time, even after seeks", () => {
  const ringSettings = { ...settings, motionPreset: "drift" };
  const cameraSettings = { ...settings, cameraShake: true, cameraShakeAmount: 80 };
  const times = [12.375, 0, -8, 300, 12.375, Number.MAX_VALUE, 2.5, 300];
  const ringResults = times.map((time) => ringMotion(time, 1280, 720, ringSettings, 0.6));
  const cameraResults = times.map((time) =>
    cameraMotion(time, 1280, 720, cameraSettings, 0.7, 0.8),
  );

  assert.deepEqual(ringResults[0], ringResults[4]);
  assert.deepEqual(ringResults[3], ringResults[7]);
  assert.deepEqual(cameraResults[0], cameraResults[4]);
  assert.deepEqual(cameraResults[3], cameraResults[7]);
  for (const transform of [...ringResults, ...cameraResults]) finiteTransform(transform);
});

test("ring motion is inactive for legacy settings, other styles, reduced motion and zero amount", () => {
  const legacySettings = without(settings, "motionPreset");
  const legacyAmount = without(settings, "motionAmount");
  const active = { ...settings, motionPreset: "orbit", motionAmount: 100 };

  assert.deepEqual(ringMotion(2, 800, 600, settings, 0), identity);
  assert.deepEqual(ringMotion(2, 800, 600, legacySettings, 0), identity);
  assert.deepEqual(ringMotion(2, 800, 600, legacyAmount, 0), identity);
  assert.deepEqual(ringMotion(2, 800, 600, { ...active, mode: "spectrum" }, 1), identity);
  assert.deepEqual(ringMotion(2, 800, 600, active, 1, true), identity);
  assert.deepEqual(ringMotion(2, 800, 600, { ...active, motionAmount: 0 }, 1), identity);
  assert.deepEqual(ringMotion(2, 800, 600, { ...active, motionPreset: "none" }, 1), identity);
});

test("beat motion follows only the supplied pulse while loop presets keep their own clock", () => {
  const beatSettings = { ...settings, motionPreset: "beat", motionAmount: 100 };
  const noPulse = ringMotion(4, 600, 900, beatSettings, 0);
  const beat = ringMotion(4, 600, 900, beatSettings, 0.75);
  const loop = ringMotion(4, 600, 900, { ...beatSettings, motionPreset: "orbit" }, 0);

  assert.deepEqual(noPulse, identity);
  assert.equal(beat.y, -600 * 0.08 * 0.75);
  assert.equal(beat.scale, 1 + 0.12 * 0.75);
  assert.ok(loop.x !== 0 || loop.y !== 0);
});

test("all ring presets stay finite and within their motion bounds across aspect ratios", () => {
  const sizes = [
    [1280, 720],
    [720, 1280],
    [800, 800],
    [1, 1],
  ];
  const times = [0, 0.01, 3.5, 37, -18, 3600, Number.MAX_VALUE, -Number.MAX_VALUE];
  const presets = ["none", "orbit", "bounce", "drift", "rotate", "zoom", "beat"];

  for (const [w, h] of sizes) {
    const shortEdge = Math.min(w, h);
    for (const motionPreset of presets) {
      const active = { ...settings, motionPreset, motionSpeed: 3, motionAmount: 100 };
      for (const time of times) {
        const transform = ringMotion(time, w, h, active, 1);
        finiteTransform(transform);
        assert.ok(Math.hypot(transform.x, transform.y) <= shortEdge * 0.08 + 1e-9);
        assert.ok(transform.rotation >= 0 && transform.rotation <= Math.PI * 2 + 1e-9);
        assert.ok(transform.scale >= 1 && transform.scale <= 1.12 + 1e-9);
      }
    }
  }

  const tinyRotation = {
    ...settings,
    motionPreset: "rotate",
    motionAmount: 1e-305,
    motionSpeed: 0.1,
  };
  finiteTransform(ringMotion(Number.MAX_VALUE, 640, 480, tinyRotation, 0));
});

test("continuous motion ignores audio strength while reactive motion scales toward its original pose", () => {
  for (const motionPreset of ["orbit", "bounce", "drift", "rotate", "zoom"]) {
    const continuous = { ...settings, motionPreset, motionAmount: 100 };
    const reactive = { ...continuous, motionBehavior: "audio-reactive" };
    assert.deepEqual(
      ringMotion(3, 1280, 720, continuous, 0),
      ringMotion(3, 1280, 720, continuous, 1),
    );
    assert.deepEqual(ringMotion(3, 1280, 720, reactive, 0), identity);
    assert.deepEqual(ringMotion(3, 1280, 720, reactive, 1, true), identity);
    const full = ringMotion(3, 1280, 720, reactive, 1);
    const quiet = ringMotion(3, 1280, 720, reactive, 0.25);
    assert.ok(full.x || full.y || full.rotation || full.scale !== 1, motionPreset);
    for (const key of ["x", "y", "rotation"])
      assert.ok(Math.abs(quiet[key] - full[key] * 0.25) < 1e-10, `${motionPreset}: ${key}`);
    assert.ok(Math.abs(quiet.scale - 1 - (full.scale - 1) * 0.25) < 1e-10);
    const legacy = without(continuous, "motionBehavior");
    assert.deepEqual(ringMotion(3, 1280, 720, legacy, 0), ringMotion(3, 1280, 720, continuous, 0));
  }
});

test("ring travel remains inside its radial limit over long tracks, lower intensities and repeated seeks", () => {
  for (const [w, h] of [
    [1280, 720],
    [720, 1280],
    [800, 800],
  ]) {
    for (const motionBehavior of ["continuous", "audio-reactive"]) {
      for (const motionPreset of ["orbit", "bounce", "drift", "beat"]) {
        for (const motionAmount of [0, 25, 50, 100]) {
          const active = { ...settings, motionBehavior, motionPreset, motionAmount };
          const limit = Math.min(w, h) * 0.08 * (motionAmount / 100);
          const pose = ringMotion(1.25, w, h, active, 0.75);
          for (let time = 0; time <= 3600; time += 1.37) {
            const transform = ringMotion(time, w, h, active, 1);
            assert.ok(Math.hypot(transform.x, transform.y) <= limit + 1e-9);
          }
          assert.deepEqual(ringMotion(1.25, w, h, active, 0.75), pose);
        }
      }
    }
  }
});

test("reactive rotation stays near its original angle and is continuous across phase wrapping", () => {
  const active = {
    ...settings,
    motionPreset: "rotate",
    motionBehavior: "audio-reactive",
    motionAmount: 100,
  };
  for (let time = 0; time < 120; time += 0.1) {
    const transform = ringMotion(time, 800, 800, active, 1);
    assert.ok(Math.abs(transform.rotation) <= Math.PI / 12 + 1e-12);
  }
  for (const pulse of [0.25, 0.75, 1]) {
    const before = ringMotion(16 - 1e-6, 800, 800, active, pulse);
    const after = ringMotion(16 + 1e-6, 800, 800, active, pulse);
    assert.ok(Math.abs(before.rotation - after.rotation) < 1e-6);
  }
});

test("Beat jump remains audio-driven in either behavior without applying the pulse twice", () => {
  const active = { ...settings, motionPreset: "beat", motionAmount: 100 };
  for (const pulse of [0, 0.25, 0.75, 1])
    assert.deepEqual(
      ringMotion(2, 1000, 700, active, pulse),
      ringMotion(2, 1000, 700, { ...active, motionBehavior: "audio-reactive" }, pulse),
    );
});

test("reactive motion eases toward rest using the shared audio response during trailing silence", () => {
  const { createAudioReactiveState, soundResponse } = modules.visualizer;
  const active = {
    ...settings,
    motionPreset: "orbit",
    motionBehavior: "audio-reactive",
    motionAmount: 100,
  };
  const state = createAudioReactiveState();
  const loud = { rms: 0.3, rmsDb: -10, bassDb: -10, middleDb: -20, highDb: -30, bands: [] };
  for (let i = 0; i < 30; i++) soundResponse(loud, active, state, 1000 / 30);
  let previous = ringMotion(1, 1280, 720, active, state.ringPulse);
  assert.ok(Math.hypot(previous.x, previous.y) > 1);
  const silent = { rms: 0, rmsDb: -160, bassDb: -160, middleDb: -160, highDb: -160, bands: [] };
  let lastPulse = state.ringPulse;
  for (let i = 1; i <= 60; i++) {
    soundResponse(silent, active, state, 1000 / 30);
    assert.ok(state.ringPulse < lastPulse);
    const pose = ringMotion(1 + i / 30, 1280, 720, active, state.ringPulse);
    assert.ok(Math.hypot(pose.x, pose.y) < Math.hypot(previous.x, previous.y));
    lastPulse = state.ringPulse;
    previous = pose;
  }
  assert.ok(Math.hypot(previous.x, previous.y) < 1e-6);
});

test("ring loop presets are continuous at each waveform's wrap point", () => {
  const active = { ...settings, motionAmount: 100, motionSpeed: 1 };
  const checks = [
    ["orbit", 12, "position"],
    ["bounce", 4.8, "position"],
    ["drift", 17, "position"],
    ["drift", 17 / 0.71, "position"],
    ["zoom", 8.5, "scale"],
    ["rotate", 16, "rotation"],
  ];

  for (const [motionPreset, period, component] of checks) {
    const presetSettings = { ...active, motionPreset };
    const before = ringMotion(period - 1e-6, 700, 700, presetSettings, 0);
    const after = ringMotion(period + 1e-6, 700, 700, presetSettings, 0);
    if (component === "position") {
      assert.ok(Math.abs(before.x - after.x) < 0.001, `${motionPreset} x at ${period}s`);
      assert.ok(Math.abs(before.y - after.y) < 0.001, `${motionPreset} y at ${period}s`);
    } else if (component === "scale") {
      assert.ok(Math.abs(before.scale - after.scale) < 1e-7, `${motionPreset} scale`);
    } else {
      const rotationDelta = Math.atan2(
        Math.sin(before.rotation - after.rotation),
        Math.cos(before.rotation - after.rotation),
      );
      assert.ok(Math.abs(rotationDelta) < 1e-6, `${motionPreset} rotation`);
    }
  }
});

test("camera shake is gated by settings, pulse, activity and reduced motion", () => {
  const active = { ...settings, cameraShake: true, cameraShakeAmount: 100 };
  const legacySettings = without(active, "cameraShake");
  const legacyAmount = without(active, "cameraShakeAmount");

  assert.deepEqual(cameraMotion(1, 800, 600, settings, 1, 1), identity);
  assert.deepEqual(cameraMotion(1, 800, 600, legacySettings, 1, 1), identity);
  assert.deepEqual(cameraMotion(1, 800, 600, legacyAmount, 1, 1), identity);
  assert.deepEqual(cameraMotion(1, 800, 600, active, 0, 1), identity);
  assert.deepEqual(cameraMotion(1, 800, 600, active, 1, 0), identity);
  assert.deepEqual(cameraMotion(1, 800, 600, active, 1, 1, true), identity);
  assert.deepEqual(cameraMotion(1, 800, 600, { ...active, cameraShakeAmount: 0 }, 1, 1), identity);
  const moved = cameraMotion(1, 800, 600, active, 1, 1);
  assert.ok(moved.x !== 0 || moved.y !== 0);
});

test("camera shake scales with resolution and its envelope covers every translation", () => {
  const active = { ...settings, cameraShake: true, cameraShakeAmount: 75 };
  const small = cameraMotion(5.7, 1000, 700, active, 0.8, 0.6);
  const large = cameraMotion(5.7, 2000, 1400, active, 0.8, 0.6);

  assert.ok(Math.abs(small.x / 1000 - large.x / 2000) < 1e-12);
  assert.ok(Math.abs(small.y / 700 - large.y / 1400) < 1e-12);
  assert.equal(small.scale, large.scale);

  for (const [w, h] of [
    [1280, 720],
    [720, 1280],
    [640, 640],
    [1, 1],
  ]) {
    for (const time of [0, 0.03, 1.25, 42, -13, Number.MAX_VALUE]) {
      const transform = cameraMotion(time, w, h, active, 0.9, 0.7);
      const envelope = 1 + (2 * Math.min(w, h) * 0.018 * 0.75 * 0.9 * 0.7) / Math.min(w, h);
      finiteTransform(transform);
      assert.ok(Math.abs(transform.x) <= Math.min(w, h) * 0.018 * 0.75 * 0.9 * 0.7 + 1e-9);
      assert.ok(Math.abs(transform.y) <= Math.min(w, h) * 0.018 * 0.75 * 0.9 * 0.7 + 1e-9);
      assert.ok(transform.scale >= envelope - 1e-12);
      assert.ok(transform.scale >= 1 + (2 * Math.abs(transform.x)) / w);
      assert.ok(transform.scale >= 1 + (2 * Math.abs(transform.y)) / h);
    }
  }
});
