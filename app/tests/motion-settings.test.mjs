import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { DEFAULT_SETTINGS, SECTION_KEYS } = modules["customizer-config"];
const { settingsSchema } = modules["visual-settings"];
const { applyPreset, presetStyle } = modules.presets;
const { makeProjectFile, readProjectFile } = modules["project-file"];
const { PresetStore, PRESET_STORAGE_KEY } = modules["preset-store"];

function withoutMotionSettings(settings) {
  const legacy = { ...settings };
  delete legacy.motionPreset;
  delete legacy.motionAmount;
  delete legacy.cameraShake;
  delete legacy.cameraShakeAmount;
  return legacy;
}

function memoryStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set(PRESET_STORAGE_KEY, initialValue);
  return {
    values,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  };
}

async function projectFile(settings, name = "motion.pf") {
  const archive = makeProjectFile({
    format: "landscape",
    range: [0, 1],
    settings,
    subtitles: [],
    media: new File(["audio"], "track.wav", { type: "audio/wav" }),
    logo: null,
    background: null,
  });
  return readProjectFile(new File([archive], name, { type: "application/x-pulseframe" }));
}

test("settings, project files, and saved presets from before motion controls default to inactive motion", async () => {
  const legacySettings = withoutMotionSettings(DEFAULT_SETTINGS);
  const parsedSettings = settingsSchema.parse(legacySettings);
  assert.equal(parsedSettings.motionPreset, "none");
  assert.equal(parsedSettings.motionAmount, 50);
  assert.equal(parsedSettings.cameraShake, false);
  assert.equal(parsedSettings.cameraShakeAmount, 35);

  const legacyProject = await projectFile(legacySettings, "legacy.pf");
  assert.equal(legacyProject.settings.motionPreset, "none");
  assert.equal(legacyProject.settings.motionAmount, 50);
  assert.equal(legacyProject.settings.cameraShake, false);
  assert.equal(legacyProject.settings.cameraShakeAmount, 35);

  const legacyPresetStyle = withoutMotionSettings(presetStyle(DEFAULT_SETTINGS));
  const id = randomUUID();
  const { storage } = memoryStorage(
    JSON.stringify({
      schemaVersion: 1,
      presets: [
        {
          id,
          name: "Older look",
          settings: legacyPresetStyle,
          createdAt: 1,
          updatedAt: 1,
          pinned: false,
          quickLookOrder: 0,
          revision: 1,
        },
      ],
    }),
  );
  const [legacyPreset] = new PresetStore(() => storage).list();
  assert.equal(legacyPreset.id, id);
  assert.equal(legacyPreset.settings.motionPreset, "none");
  assert.equal(legacyPreset.settings.motionAmount, 50);
  assert.equal(legacyPreset.settings.cameraShake, false);
  assert.equal(legacyPreset.settings.cameraShakeAmount, 35);
});

test("motion settings validate the preset enum, finite percentage bounds, and camera shake boolean", () => {
  for (const motionPreset of ["none", "orbit", "bounce", "drift", "rotate", "zoom", "beat"])
    assert.equal(
      settingsSchema.parse({ ...DEFAULT_SETTINGS, motionPreset }).motionPreset,
      motionPreset,
    );

  for (const motionPreset of ["shake", "", null]) {
    assert.throws(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, motionPreset }));
  }

  for (const motionAmount of [0, 50, 100]) {
    assert.equal(
      settingsSchema.parse({ ...DEFAULT_SETTINGS, motionAmount }).motionAmount,
      motionAmount,
    );
  }
  for (const motionAmount of [-0.01, 100.01, NaN, Infinity, -Infinity]) {
    assert.throws(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, motionAmount }));
  }

  for (const cameraShakeAmount of [0, 35, 100]) {
    assert.equal(
      settingsSchema.parse({ ...DEFAULT_SETTINGS, cameraShakeAmount }).cameraShakeAmount,
      cameraShakeAmount,
    );
  }
  for (const cameraShakeAmount of [-0.01, 100.01, NaN, Infinity, -Infinity]) {
    assert.throws(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, cameraShakeAmount }));
  }

  assert.equal(settingsSchema.parse({ ...DEFAULT_SETTINGS, cameraShake: true }).cameraShake, true);
  assert.throws(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, cameraShake: 1 }));
});

test("saved presets and project files retain motion choices and amounts, while applying a preset keeps current track labels", async () => {
  const selected = {
    ...DEFAULT_SETTINGS,
    motionPreset: "zoom",
    motionAmount: 73,
    cameraShake: true,
    cameraShakeAmount: 81,
    trackTitle: "Source label",
    trackArtist: "Source artist",
  };

  const { storage } = memoryStorage();
  const store = new PresetStore(() => storage);
  const created = await store.create({
    id: randomUUID(),
    name: "Moving look",
    settings: presetStyle(selected),
  });
  const [restoredPreset] = new PresetStore(() => storage).list();
  assert.equal(restoredPreset.id, created.id);
  assert.equal(restoredPreset.settings.motionPreset, "zoom");
  assert.equal(restoredPreset.settings.motionAmount, 73);
  assert.equal(restoredPreset.settings.cameraShake, true);
  assert.equal(restoredPreset.settings.cameraShakeAmount, 81);

  const applied = applyPreset(
    { ...DEFAULT_SETTINGS, trackTitle: "Current title", trackArtist: "Current artist" },
    restoredPreset.settings,
  );
  assert.equal(applied.motionPreset, "zoom");
  assert.equal(applied.motionAmount, 73);
  assert.equal(applied.cameraShake, true);
  assert.equal(applied.cameraShakeAmount, 81);
  assert.equal(applied.trackTitle, "Current title");
  assert.equal(applied.trackArtist, "Current artist");

  const restoredProject = await projectFile(selected);
  assert.equal(restoredProject.settings.motionPreset, "zoom");
  assert.equal(restoredProject.settings.motionAmount, 73);
  assert.equal(restoredProject.settings.cameraShake, true);
  assert.equal(restoredProject.settings.cameraShakeAmount, 81);
});

test("motion section reset covers every new motion setting and uses their inactive defaults", () => {
  const motionKeys = SECTION_KEYS.motion;
  for (const key of ["motionPreset", "motionAmount", "cameraShake", "cameraShakeAmount"])
    assert.ok(motionKeys.includes(key), `${key} should reset with the motion section`);

  const baseline = presetStyle(DEFAULT_SETTINGS);
  assert.deepEqual(
    Object.fromEntries(
      ["motionPreset", "motionAmount", "cameraShake", "cameraShakeAmount"].map((key) => [
        key,
        baseline[key],
      ]),
    ),
    { motionPreset: "none", motionAmount: 50, cameraShake: false, cameraShakeAmount: 35 },
  );
});
