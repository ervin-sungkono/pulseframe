import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { settingsSchema, migrateSettings } = modules["visual-settings"];
const { DEFAULT_SETTINGS, BUILTIN_LOOKS, SECTION_KEYS } = modules["customizer-config"];
const { presetStyle, applyPreset } = modules.presets;
const { PresetStore, PRESET_STORAGE_KEY } = modules["preset-store"];
const { makeProjectFile, readProjectFile } = modules["project-file"];
const { VISUAL_MODES, DEFAULT_LOGO_AUTO_FIT, DEFAULT_LOGO_FIT_SCALE, DEFAULT_LOGO_PLACEMENTS } =
  modules["visual-settings-model"];
const { DEFAULT_RADIAL_OPTIONS, DEFAULT_TERRAIN_OPTIONS } = modules["style-options"];

const newModes = ["radial", "terrain"];
const optionDefaults = {
  radialOptions: DEFAULT_RADIAL_OPTIONS,
  terrainOptions: DEFAULT_TERRAIN_OPTIONS,
};
const media = new File(["small audio fixture"], "fixture.wav", { type: "audio/wav" });
const cue = { id: "line-1", start: 0.25, end: 1.25, text: "A saved subtitle" };

function input(changes = {}) {
  return { ...structuredClone(DEFAULT_SETTINGS), ...changes };
}

function schemaResult(group, groupValue) {
  return settingsSchema.safeParse(input({ [group]: groupValue }));
}

function projectContent(settings) {
  return {
    format: "landscape",
    range: [0, 2],
    settings,
    subtitles: [cue],
    media,
    logo: null,
    background: null,
  };
}

async function openProject(settings, filename = "style.pulseframe") {
  const blob = makeProjectFile(projectContent(settings));
  const bytes = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const manifestLength = new DataView(bytes.buffer).getUint32(4, true);
  const manifest = JSON.parse(await blob.slice(8, 8 + manifestLength).text());
  const opened = await readProjectFile(new File([blob], filename));
  return { manifest, opened };
}

test("all five visual modes have complete logo defaults and both style option defaults", () => {
  assert.deepEqual(VISUAL_MODES, ["ring", "spectrum", "edges", "radial", "terrain"]);
  assert.deepEqual(Object.keys(DEFAULT_LOGO_AUTO_FIT).sort(), [...VISUAL_MODES].sort());
  assert.deepEqual(Object.keys(DEFAULT_LOGO_FIT_SCALE).sort(), [...VISUAL_MODES].sort());
  assert.deepEqual(Object.keys(DEFAULT_LOGO_PLACEMENTS).sort(), [...VISUAL_MODES].sort());
  for (const mode of VISUAL_MODES) {
    const modeResult = settingsSchema.safeParse(input({ mode }));
    assert.equal(modeResult.success, true, `${mode} should be an accepted visual mode`);
    assert.equal(modeResult.data.mode, mode);
  }

  const parsed = settingsSchema.parse(DEFAULT_SETTINGS);
  assert.deepEqual(parsed.radialOptions, DEFAULT_RADIAL_OPTIONS);
  assert.deepEqual(parsed.terrainOptions, DEFAULT_TERRAIN_OPTIONS);
  for (const mode of VISUAL_MODES) {
    assert.equal(typeof parsed.logoAutoFit[mode], "boolean");
    assert.equal(typeof parsed.logoFitScale[mode], "number");
    assert.ok(parsed.logoPlacements[mode]);
  }
});

test("option schema accepts exact documented bounds and rejects out-of-range and non-finite numbers", () => {
  const numericRanges = [
    ["radialOptions", "barCount", 32, 160, 1],
    ["radialOptions", "innerRadius", 10, 40, 0.1],
    ["radialOptions", "maxBarLength", 5, 35, 0.1],
    ["radialOptions", "barWidth", 20, 100, 0.1],
    ["radialOptions", "roundness", 0, 100, 0.1],
    ["radialOptions", "rotationSpeed", -100, 100, 0.1],
    ["terrainOptions", "height", 0, 100, 0.1],
    ["terrainOptions", "historySeconds", 2, 10, 0.1],
    ["terrainOptions", "travelSpeed", 0, 200, 0.1],
    ["terrainOptions", "wireOpacity", 0, 100, 0.1],
    ["terrainOptions", "surfaceFill", 0, 100, 0.1],
  ];

  for (const [group, field, minimum, maximum, outsideStep] of numericRanges) {
    const defaults = optionDefaults[group];
    for (const value of [minimum, maximum]) {
      assert.equal(
        schemaResult(group, { ...defaults, [field]: value }).success,
        true,
        `${group}.${field} should accept ${value}`,
      );
    }
    for (const value of [minimum - outsideStep, maximum + outsideStep]) {
      assert.equal(
        schemaResult(group, { ...defaults, [field]: value }).success,
        false,
        `${group}.${field} should reject ${value}`,
      );
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.equal(
        schemaResult(group, { ...defaults, [field]: value }).success,
        false,
        `${group}.${field} should reject ${String(value)}`,
      );
    }
  }

  for (const [group, field, allowed] of [
    ["radialOptions", "direction", ["clockwise", "mirrored"]],
    ["radialOptions", "variant", ["outward", "inward", "both"]],
    ["terrainOptions", "density", ["low", "medium", "high"]],
    ["terrainOptions", "perspective", ["low", "medium", "high"]],
  ]) {
    for (const value of allowed) {
      assert.equal(
        schemaResult(group, { ...optionDefaults[group], [field]: value }).success,
        true,
        `${group}.${field} should accept ${value}`,
      );
    }
    assert.equal(
      schemaResult(group, { ...optionDefaults[group], [field]: "invalid" }).success,
      false,
      `${group}.${field} should reject unknown options`,
    );
  }
});

test("missing and partial style option groups receive property defaults in old settings and projects", async () => {
  const oldSettings = input();
  delete oldSettings.radialOptions;
  delete oldSettings.terrainOptions;
  const parsedOld = settingsSchema.parse(oldSettings);
  assert.deepEqual(parsedOld.radialOptions, DEFAULT_RADIAL_OPTIONS);
  assert.deepEqual(parsedOld.terrainOptions, DEFAULT_TERRAIN_OPTIONS);

  const partial = settingsSchema.parse(
    input({
      radialOptions: { barCount: 32 },
      terrainOptions: { surfaceFill: 99 },
    }),
  );
  assert.deepEqual(partial.radialOptions, { ...DEFAULT_RADIAL_OPTIONS, barCount: 32 });
  assert.deepEqual(partial.terrainOptions, { ...DEFAULT_TERRAIN_OPTIONS, surfaceFill: 99 });

  const { opened } = await openProject(oldSettings, "old-style-settings.pulseframe");
  assert.deepEqual(opened.settings.radialOptions, DEFAULT_RADIAL_OPTIONS);
  assert.deepEqual(opened.settings.terrainOptions, DEFAULT_TERRAIN_OPTIONS);
});

test("new styles roundtrip through version 2 projects with their settings, logo placement and subtitle", async () => {
  const customSettings = {
    radial: {
      radialOptions: {
        ...DEFAULT_RADIAL_OPTIONS,
        barCount: 128,
        rotationSpeed: -35,
        direction: "mirrored",
        variant: "both",
      },
    },
    terrain: {
      terrainOptions: {
        ...DEFAULT_TERRAIN_OPTIONS,
        historySeconds: 9,
        perspective: "low",
        wireOpacity: 33,
      },
    },
  };

  for (const mode of newModes) {
    const placement = { x: 34, y: 61, size: 29 };
    const settings = input({
      ...customSettings[mode],
      mode,
      logoPlacements: { ...DEFAULT_LOGO_PLACEMENTS, [mode]: placement },
      showTrackInfo: true,
      trackTitle: `Saved ${mode}`,
    });
    const { manifest, opened } = await openProject(settings, `${mode}.pulseframe`);
    assert.equal(manifest.version, 2);
    assert.equal(opened.settings.mode, mode);
    assert.equal(opened.migratedStyle, undefined);
    assert.deepEqual(opened.settings[`${mode}Options`], settings[`${mode}Options`]);
    assert.deepEqual(opened.settings.logoPlacements[mode], placement);
    assert.deepEqual(opened.subtitles, [cue]);
    assert.equal(opened.settings.trackTitle, `Saved ${mode}`);
  }
});

test("retired project IDs migrate to their historical supported styles and retain their logo layouts", async () => {
  for (const [oldMode, target] of [
    ["halo", "ring"],
    ["tunnel", "ring"],
    ["bloom", "ring"],
    ["wave", "spectrum"],
    ["aurora", "spectrum"],
    ["blob", "ring"],
  ]) {
    const layout = { x: 37, y: 41, size: 22 };
    const settings = input({
      mode: oldMode,
      [`${oldMode}Options`]: { detail: "high" },
      logoPlacements: { ...DEFAULT_LOGO_PLACEMENTS, [oldMode]: layout },
      logoAutoFit: { ...DEFAULT_LOGO_AUTO_FIT, [oldMode]: false },
      logoFitScale: { ...DEFAULT_LOGO_FIT_SCALE, [oldMode]: 75 },
    });
    const { opened } = await openProject(settings, `${oldMode}.pulseframe`);
    assert.equal(opened.settings.mode, target);
    assert.equal(`${oldMode}Options` in opened.settings, false);
    const importedPreset = presetStyle(settings);
    assert.equal(importedPreset.mode, target);
    assert.equal(`${oldMode}Options` in importedPreset, false);
    assert.deepEqual(importedPreset.logoPlacements[target], layout);
    assert.equal(opened.migratedStyle, oldMode);
    assert.deepEqual(opened.settings.logoPlacements[target], layout);
    assert.equal(opened.settings.logoAutoFit[target], false);
    assert.equal(opened.settings.logoFitScale[target], 75);
  }

  for (const mode of newModes) {
    const migrated = migrateSettings(settingsSchema.parse(input({ mode })));
    assert.equal(migrated.mode, mode);
  }
});

test("new option groups persist in version 1 local presets and survive apply", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const firstStore = new PresetStore(() => storage);
  const requested = [
    ["radial", { radialOptions: { ...DEFAULT_RADIAL_OPTIONS, barCount: 144, variant: "inward" } }],
    [
      "terrain",
      { terrainOptions: { ...DEFAULT_TERRAIN_OPTIONS, historySeconds: 8, surfaceFill: 44 } },
    ],
  ];

  for (const [mode, options] of requested) {
    await firstStore.create({
      id: randomUUID(),
      name: `${mode} saved`,
      settings: presetStyle(input({ mode, ...options, trackTitle: "Do not save" })),
    });
  }
  assert.equal(JSON.parse(values.get(PRESET_STORAGE_KEY)).schemaVersion, 1);

  const reloaded = new PresetStore(() => storage).list();
  assert.equal(reloaded.length, requested.length);
  for (const [mode, options] of requested) {
    const saved = reloaded.find((preset) => preset.settings.mode === mode);
    assert.ok(saved, `missing saved ${mode} preset`);
    assert.deepEqual(saved.settings[`${mode}Options`], options[`${mode}Options`]);
    assert.equal("trackTitle" in saved.settings, false);
    const applied = applyPreset(
      input({ trackTitle: "Current track", trackArtist: "Current artist" }),
      saved.settings,
    );
    assert.equal(applied.mode, mode);
    assert.deepEqual(applied[`${mode}Options`], options[`${mode}Options`]);
    assert.equal(applied.trackTitle, "Current track");
    assert.equal(applied.trackArtist, "Current artist");
  }
});

test("new style settings reset with the Visual section and built-in looks carry valid snapshots", () => {
  for (const group of ["radialOptions", "terrainOptions"])
    assert.ok(SECTION_KEYS.visual.includes(group), `${group} must reset with Visual settings`);

  const expected = [
    ["contour", "Contour", "ring"],
    ["after-hours", "After Hours", "spectrum"],
    ["counterflow", "Counterflow", "edges"],
    ["orbit", "Orbit", "radial"],
    ["neon-horizon", "Neon Horizon", "terrain"],
  ];
  assert.equal(BUILTIN_LOOKS.length, 5);
  assert.deepEqual(
    BUILTIN_LOOKS.map((look) => look.settings.mode).sort(),
    [...VISUAL_MODES].sort(),
  );
  for (const [id, name, mode] of expected) {
    const look = BUILTIN_LOOKS.find((item) => item.id === id);
    assert.ok(look, `missing ${name} built-in look`);
    assert.equal(look.name, name);
    assert.equal(look.settings.mode, mode);
    assert.equal(look.settings.particles, true, `${name} should include particles by default`);
    assert.ok(look.settings.particleCount >= 24 && look.settings.particleCount <= 40);
    assert.deepEqual(presetStyle(look.settings), look.settings);
    assert.ok(look.settings.radialOptions && look.settings.terrainOptions);
  }
});
