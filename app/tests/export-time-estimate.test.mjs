import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadSources } from "./load-source.mjs";

const testDirectory = mkdtempSync(join(tmpdir(), "pulseframe-export-time-"));
const settingsPath = join(testDirectory, "export-settings.mjs");
const modulePath = join(testDirectory, "export-time-estimate.mjs");
const settingsSource = readFileSync(
  new URL("../lib/export/export-settings.ts", import.meta.url),
  "utf8",
);
writeFileSync(
  settingsPath,
  ts.transpileModule(settingsSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText,
);
const source = readFileSync(
  new URL("../lib/export/export-time-estimate.ts", import.meta.url),
  "utf8",
).replaceAll('"./export-settings"', JSON.stringify(pathToFileURL(settingsPath).href));
writeFileSync(
  modulePath,
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText,
);
const estimate = await import(pathToFileURL(modulePath).href);
const { COMPRESSED_VIDEO_QUALITY } = await import(pathToFileURL(settingsPath).href);
const { DEFAULT_SETTINGS } = (await loadSources())["customizer-config"];
after(() => rmSync(testDirectory, { recursive: true, force: true }));

class MemoryStorage {
  values = new Map();
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, value);
  }
}

function profile({
  durationSeconds = 20,
  analysisSeconds = 30,
  preparedAudio = false,
  codec = "avc",
  audioIncluded = true,
  compression = false,
  ringLayers = 3,
  glow = 0.95,
  spectrumReflection = 45,
} = {}) {
  const workload = estimate.makeExportWorkload({
    durationSeconds,
    analysisSeconds,
    preparedAudio,
    mode: "ring",
    ringLayers,
    spectrumReflection,
    glow,
    particleMode: "stardust",
    particleCount: 140,
    particles: true,
    trails: true,
    backdrop: "nebula",
    beatEffects: true,
    glitch: false,
    dropEffects: true,
    subtitles: false,
    logo: false,
    background: false,
    videoOverlay: false,
    trackInfo: true,
    reducedMotion: false,
  });
  const base = estimate.makeExportTimingProfileBase({
    width: 854,
    height: 480,
    frameRate: 30,
    videoCompression: compression,
    sourceKind: "audio",
    preparedAudio,
    workload,
  });
  return { base, full: { ...base, codec, audioIncluded } };
}

function measurement(
  full,
  {
    frameCount = 600,
    preparationMs = 800,
    renderingMs = 12000,
    finalizationMs = 1200,
    totalMs = 14000,
  } = {},
) {
  return { profile: full, frameCount, preparationMs, renderingMs, finalizationMs, totalMs };
}

test("compressed timing profiles use the export encoder quality setting", () => {
  assert.equal(profile({ compression: true }).base.videoQuality, COMPRESSED_VIDEO_QUALITY);
});

test("constant completed-frame throughput produces a cautious range only after warmup", () => {
  const live = new estimate.LiveFrameEstimator();
  live.observe(5, 250);
  live.observe(10, 500);
  live.observe(15, 750);
  assert.equal(live.remaining(200, 15), null, "less than a second of completed work is not enough");
  live.observe(20, 1000);
  assert.equal(live.rate, 0.05);
  const remaining = live.remaining(200, 20);
  assert.equal(remaining.scope, "rendering");
  assert.ok(remaining.range.minSeconds < 9 && remaining.range.maxSeconds > 9);
});

test("smoothed frame timing follows a sustained slowdown without taking one noisy jump", () => {
  const live = new estimate.LiveFrameEstimator();
  live.observe(10, 300);
  live.observe(20, 600);
  live.observe(30, 900);
  live.observe(40, 1200);
  assert.equal(
    live.rate,
    0.03,
    "several completed windows and over a second of work are available",
  );
  live.observe(50, 1500);
  live.observe(60, 2500);
  assert.ok(live.rate > 0.03 && live.rate < 0.06, "slowdown is reflected gradually");
  live.observe(70, 3500);
  live.observe(80, 4500);
  assert.ok(live.rate > 0.06, "continued slower batches move the estimate toward the new pace");
});

test("very short jobs and invalid clock samples do not fabricate an ETA", () => {
  const live = new estimate.LiveFrameEstimator();
  live.observe(5, 100);
  live.observe(10, 200);
  live.observe(15, 300);
  assert.equal(live.remaining(15, 15), null);
  live.observe(20, Infinity);
  live.observe(25, NaN);
  live.observe(30, -1);
  assert.equal(live.rate, null);
  assert.equal(live.remaining(100, 30), null);
});

test("run clock separates preparation, completed rendering, and file finalization from click time", () => {
  let now = 100;
  const clock = new estimate.ExportRunClock(100, () => now);
  now = 140; // includes simulated pause/lazy-import and media preparation
  assert.deepEqual(clock.snapshot(), {
    phase: "Preparing media",
    elapsedMs: 40,
    phaseElapsedMs: 40,
  });
  clock.setPhase("Rendering frames");
  now = 210;
  clock.setPhase("Finishing file");
  now = 250;
  assert.deepEqual(clock.complete(), {
    preparationMs: 40,
    renderingMs: 70,
    finalizationMs: 40,
    totalMs: 150,
  });
});

test("history reuses only compatible profiles, expires, and refuses short-to-long decode reuse", () => {
  const storage = new MemoryStorage();
  const short = profile({ durationSeconds: 6, analysisSeconds: 16 });
  const now = 10_000;
  assert.equal(estimate.recordSuccessfulExport(measurement(short.full), storage, now), true);
  assert.ok(estimate.getPreExportEstimate(short.base, 600, storage, now));

  const long = profile({ durationSeconds: 300, analysisSeconds: 310 });
  assert.equal(
    estimate.getPreExportEstimate(long.base, 9000, storage, now),
    null,
    "a short fallback decode/finalization run cannot train a much longer range",
  );
  assert.equal(
    estimate.getHistoricalProfileEstimate({ ...short.full, codec: "vp9" }, 600, storage, now),
    null,
  );
  assert.equal(
    estimate.getPreExportEstimate(
      profile({ durationSeconds: 6, analysisSeconds: 16, ringLayers: 4 }).base,
      600,
      storage,
      now,
    ),
    null,
    "ring layer count changes the renderer workload profile",
  );
  assert.equal(
    estimate.getPreExportEstimate(
      profile({ durationSeconds: 6, analysisSeconds: 16, glow: 2 }).base,
      600,
      storage,
      now,
    ),
    null,
    "materially different glow work does not reuse the same profile",
  );
  assert.equal(
    estimate.getPreExportEstimate(
      short.base,
      600,
      storage,
      now + estimate.EXPORT_TIMING_MAX_AGE_MS + 1,
    ),
    null,
  );
});

test("pre-export lookup needs one unambiguous codec and audio configuration", () => {
  const storage = new MemoryStorage();
  const first = profile();
  const second = profile({ codec: "vp9" });
  estimate.recordSuccessfulExport(measurement(first.full), storage, 1000);
  assert.ok(estimate.getPreExportEstimate(first.base, 600, storage, 1000));
  estimate.recordSuccessfulExport(measurement(second.full), storage, 1001);
  assert.equal(estimate.getPreExportEstimate(first.base, 600, storage, 1001), null);
  assert.equal(
    estimate.getHistoricalProfileEstimate({ ...second.full, codec: "vp8" }, 600, storage, 1001),
    null,
    "a different actual codec does not borrow the first codec timing",
  );
});

test("storage errors and incompatible schemas fail closed without breaking export", () => {
  const broken = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("quota");
    },
  };
  const current = profile();
  assert.equal(estimate.recordSuccessfulExport(measurement(current.full), broken, 1000), false);
  assert.equal(estimate.getPreExportEstimate(current.base, 600, broken, 1000), null);

  const oldSchema = new MemoryStorage();
  oldSchema.setItem(
    estimate.EXPORT_TIMING_STORAGE_KEY,
    JSON.stringify({ schemaVersion: 99, records: [measurement(current.full)] }),
  );
  assert.equal(estimate.getPreExportEstimate(current.base, 600, oldSchema, 1000), null);
});

test("successful timing history stays bounded and stores no track or appearance text", () => {
  const storage = new MemoryStorage();
  const current = profile();
  for (let index = 0; index < estimate.EXPORT_TIMING_MAX_RECORDS + 3; index++) {
    estimate.recordSuccessfulExport(measurement(current.full), storage, 1000 + index);
  }
  const stored = JSON.parse(storage.getItem(estimate.EXPORT_TIMING_STORAGE_KEY));
  assert.equal(stored.records.length, estimate.EXPORT_TIMING_MAX_RECORDS);
  const serialized = JSON.stringify(stored);
  assert.doesNotMatch(serialized, /trackTitle|trackArtist|fileName|pcm|Artist Name/i);
  assert.ok(estimate.getHistoricalProfileEstimate(current.full, 600, storage, 1022));
});

test("new style workload profiles distinguish costly geometry without changing existing style profiles", () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const workload = () =>
    estimate.makeExportWorkloadForExport({
      durationSeconds: 180,
      analysisSeconds: 180,
      preparedAudio: true,
      settings,
      subtitles: false,
      logo: false,
      background: false,
      videoOverlay: false,
      reducedMotion: false,
    });
  assert.equal(Object.hasOwn(workload(), "styleComplexity"), false);
  settings.mode = "radial";
  const radial = workload();
  settings.radialOptions.barCount = 160;
  assert.notEqual(workload().styleComplexity, radial.styleComplexity);
  settings.mode = "blob";
  const blob = workload();
  assert.ok(
    blob.styleComplexity.startsWith("fluid3-"),
    "new render costs do not reuse older blob timings",
  );
  settings.blobOptions.detail = "high";
  assert.notEqual(workload().styleComplexity, blob.styleComplexity);
  settings.mode = "terrain";
  const terrain = workload();
  assert.ok(
    terrain.styleComplexity.startsWith("response2-"),
    "new render costs do not reuse older terrain timings",
  );
  settings.terrainOptions.density = "high";
  assert.notEqual(workload().styleComplexity, terrain.styleComplexity);
  const highDensity = workload();
  settings.terrainOptions.historySeconds = 10;
  assert.notEqual(workload().styleComplexity, highDensity.styleComplexity);
  const colored = workload();
  settings.primary = "#ff0000";
  assert.deepEqual(workload(), colored);
  assert.equal(new Set([radial.mode, blob.mode, terrain.mode]).size, 3);
});
