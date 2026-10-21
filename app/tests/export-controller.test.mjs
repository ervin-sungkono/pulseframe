import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadSources } from "./load-source.mjs";

const testDirectory = mkdtempSync(join(tmpdir(), "pulseframe-export-job-"));
const modulePath = join(testDirectory, "export-job.mjs");
const source = readFileSync(new URL("../lib/export/export-job.ts", import.meta.url), "utf8");
writeFileSync(
  modulePath,
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText,
);
const { createExportJobController } = await import(pathToFileURL(modulePath).href);
after(() => rmSync(testDirectory, { recursive: true, force: true }));

const output = { blob: new Blob(["encoded"]), extension: "mp4" };

function makeJob(overrides = {}) {
  const lockedRef = { current: false };
  const states = [];
  const errors = [];
  const notices = [];
  const downloads = [];
  const completions = [];
  let pauses = 0;
  const controller = createExportJobController({
    lockedRef,
    pausePlayback: () => {
      pauses++;
    },
    execute: async () => output,
    download: (result, source) => {
      downloads.push({ result, source });
    },
    onState: (exporting, progress) => states.push({ exporting, progress }),
    onError: (message) => errors.push(message),
    onNotice: (message) => notices.push(message),
    onComplete: (...args) => completions.push(args),
    ...overrides,
  });
  return {
    controller,
    lockedRef,
    states,
    errors,
    notices,
    downloads,
    completions,
    get pauses() {
      return pauses;
    },
  };
}

test("cancellation holds the lock until pending encoding settles and skips a late download", async () => {
  let finishFirst;
  let reportFirst;
  let executions = 0;
  const job = makeJob({
    execute: (_source, _signal, onProgress) => {
      executions++;
      if (executions === 1) {
        reportFirst = onProgress;
        return new Promise((resolve) => {
          finishFirst = resolve;
        });
      }
      return Promise.resolve(output);
    },
  });

  const firstTask = job.controller.start({ id: "first" });
  assert.ok(firstTask);
  assert.equal(job.lockedRef.current, true);
  assert.equal(job.controller.start({ id: "overlap" }), null);
  assert.equal(job.pauses, 1);

  job.controller.cancel();
  assert.equal(job.lockedRef.current, true);
  reportFirst({ phase: "Rendering frames", percent: 50 });
  assert.equal(job.states.length, 1, "progress from a canceled job is ignored");

  finishFirst(output);
  await firstTask;
  assert.equal(job.downloads.length, 0, "a resolved result is not downloaded after cancellation");
  assert.equal(
    job.completions.length,
    0,
    "a canceled job cannot record a successful timing sample",
  );
  assert.equal(job.lockedRef.current, false);
  assert.deepEqual(job.states.at(-1), { exporting: false, progress: null });

  const resolvedTask = job.controller.start({ id: "resolved-before-cancel" });
  assert.ok(resolvedTask);
  job.controller.cancel();
  await resolvedTask;
  assert.equal(
    job.downloads.length,
    0,
    "cancel between encoding resolution and continuation prevents download",
  );
  assert.equal(
    job.completions.length,
    0,
    "late canceled results do not reach completion callbacks",
  );

  await job.controller.start({ id: "next" });
  assert.equal(executions, 3);
  assert.equal(job.downloads.length, 1, "a new job can start after the prior job settles");
  assert.equal(
    job.completions.length,
    1,
    "only a successful current job reaches the history callback",
  );
  assert.equal(job.downloads[0].source.id, "next");
  assert.equal(job.lockedRef.current, false);
});

test("an encoder failure reports its message and releases lock and progress", async () => {
  const job = makeJob({
    execute: async () => {
      throw new Error("Encoder failed.");
    },
  });
  await job.controller.start({ id: "failure" });

  assert.deepEqual(job.errors, ["Encoder failed."]);
  assert.equal(job.lockedRef.current, false);
  assert.deepEqual(job.states.at(-1), { exporting: false, progress: null });
  assert.equal(job.downloads.length, 0);
});

test("unmount aborts the job, releases the lock, and ignores late progress and results", async () => {
  let finish;
  let report;
  let signal;
  const job = makeJob({
    execute: (_source, jobSignal, onProgress) => {
      signal = jobSignal;
      report = onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const task = job.controller.start({ id: "unmount" });
  const statesBeforeDispose = job.states.length;

  job.controller.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(job.lockedRef.current, false);
  report({ phase: "Rendering frames", percent: 90 });
  finish(output);
  await task;

  assert.equal(job.states.length, statesBeforeDispose, "disposed jobs do not update React state");
  assert.equal(job.downloads.length, 0);
  assert.equal(job.lockedRef.current, false);
});

test("successful download URLs revoke after 60 seconds or immediately on teardown", async () => {
  let scheduled;
  let revoked = 0;
  let timerCanceled = 0;
  const job = makeJob({
    download: () => () => {
      revoked++;
    },
    scheduleRevoke: (revoke, delayMs) => {
      scheduled = { revoke, delayMs };
      return () => {
        timerCanceled++;
      };
    },
  });

  await job.controller.start({ id: "download" });
  assert.equal(scheduled.delayMs, 60_000);
  assert.equal(revoked, 0);
  scheduled.revoke();
  assert.equal(revoked, 1);
  assert.equal(timerCanceled, 1);
  job.controller.dispose();
  assert.equal(revoked, 1, "teardown does not revoke the same URL twice");
});

test("hook snapshots mutable export inputs before lazy import and retains prepared assets by reference", async () => {
  const settingsPath = join(testDirectory, "export-settings.mjs");
  const estimatePath = join(testDirectory, "export-time-estimate.mjs");
  const timelinePath = join(testDirectory, "export-timeline.mjs");
  const responsePath = join(testDirectory, "audio-response-config.mjs");
  const response = (await loadSources())["audio-response"];
  writeFileSync(
    responsePath,
    `export const STYLE_RESPONSE_LOOKBACK_SECONDS = ${response.STYLE_RESPONSE_LOOKBACK_SECONDS};`,
  );
  const analysisPath = join(testDirectory, "audio-analysis-config.mjs");
  const timePath = join(testDirectory, "time.mjs");
  const reactPath = join(testDirectory, "react-mock.mjs");
  const adapterPath = join(testDirectory, "export-video-mock.mjs");
  const hookPath = join(testDirectory, "use-export-controller.mjs");
  writeFileSync(
    settingsPath,
    `
    export const COMPRESSED_VIDEO_QUALITY = 0.68;
    export const EXPORT_FRAME_RATES = [24, 30, 60];
    export function exportDimensions(format, resolution) {
      return format === 'square'
        ? { width: resolution, height: resolution }
        : { width: resolution * 2, height: resolution };
    }
  `,
  );
  const estimateSource = readFileSync(
    new URL("../lib/export/export-time-estimate.ts", import.meta.url),
    "utf8",
  ).replaceAll('"./export-settings"', JSON.stringify(pathToFileURL(settingsPath).href));
  writeFileSync(
    estimatePath,
    ts.transpileModule(estimateSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  );
  for (const [relative, path] of [
    ["audio/audio-analysis-config", analysisPath],
    ["export/export-timeline", timelinePath],
  ]) {
    const source = readFileSync(new URL(`../lib/${relative}.ts`, import.meta.url), "utf8")
      .replaceAll(
        '"../audio/audio-analysis-config"',
        JSON.stringify(pathToFileURL(analysisPath).href),
      )
      .replaceAll('"./export-settings"', JSON.stringify(pathToFileURL(settingsPath).href))
      .replaceAll(
        '"../visual/styles/audio-response"',
        JSON.stringify(pathToFileURL(responsePath).href),
      );
    writeFileSync(
      path,
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    );
  }
  const timeSource = readFileSync(new URL("../lib/time.ts", import.meta.url), "utf8");
  writeFileSync(
    timePath,
    ts.transpileModule(timeSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  );
  writeFileSync(
    reactPath,
    `
    export const useCallback = (...args) => globalThis.__snapshotHookHarness.useCallback(...args);
    export const useEffect = (...args) => globalThis.__snapshotHookHarness.useEffect(...args);
    export const useMemo = (...args) => globalThis.__snapshotHookHarness.useMemo(...args);
    export const useRef = (...args) => globalThis.__snapshotHookHarness.useRef(...args);
    export const useState = (...args) => globalThis.__snapshotHookHarness.useState(...args);
  `,
  );
  writeFileSync(
    adapterPath,
    `
    globalThis.__snapshotEvents.push('adapter-module');
    await globalThis.__snapshotImportGate;
    export async function exportVisualVideo(options) {
      globalThis.__snapshotEvents.push('adapter-called');
      globalThis.__snapshotExportOptions = options;
      return globalThis.__snapshotEncodeGate;
    }
  `,
  );
  let hookSource = readFileSync(
    new URL("../hooks/use-export-controller.ts", import.meta.url),
    "utf8",
  );
  hookSource = hookSource
    .replaceAll('"react"', JSON.stringify(pathToFileURL(reactPath).href))
    .replaceAll('"@/lib/export/export-settings"', JSON.stringify(pathToFileURL(settingsPath).href))
    .replaceAll('"@/lib/export/export-job"', JSON.stringify(pathToFileURL(modulePath).href))
    .replaceAll(
      '"@/lib/export/export-time-estimate"',
      JSON.stringify(pathToFileURL(estimatePath).href),
    )
    .replaceAll('"@/lib/export/export-timeline"', JSON.stringify(pathToFileURL(timelinePath).href))
    .replaceAll('"@/lib/time"', JSON.stringify(pathToFileURL(timePath).href))
    .replaceAll('"@/lib/export/export-video"', JSON.stringify(pathToFileURL(adapterPath).href));
  writeFileSync(
    hookPath,
    ts.transpileModule(hookSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  );
  const { useExportController } = await import(pathToFileURL(hookPath).href);

  const events = [];
  let resolveImport;
  let resolveEncoding;
  globalThis.__snapshotEvents = events;
  globalThis.__snapshotImportGate = new Promise((resolve) => {
    resolveImport = resolve;
  });
  globalThis.__snapshotEncodeGate = new Promise((resolve) => {
    resolveEncoding = resolve;
  });

  const slots = [];
  const effects = [];
  let cursor = 0;
  const sameDeps = (left, right) =>
    Boolean(
      left &&
      right &&
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index])),
    );
  const harness = {
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!slots[index])
        slots[index] = { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[index];
      return [
        slot.value,
        (value) => {
          slot.value = typeof value === "function" ? value(slot.value) : value;
        },
      ];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      const slot = slots[index];
      if (!slot || !sameDeps(slot.deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
    useMemo(factory, deps) {
      const index = cursor++;
      const slot = slots[index];
      if (!slot || !sameDeps(slot.deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useEffect(create, deps) {
      const index = cursor++;
      const old = effects[index];
      effects[index] = {
        create,
        deps,
        cleanup: old?.cleanup,
        changed: !old || !sameDeps(old.deps, deps),
      };
    },
    flushEffects() {
      effects.forEach((effect) => {
        if (!effect.changed) return;
        effect.cleanup?.();
        effect.cleanup = effect.create();
        effect.changed = false;
      });
    },
    cleanup() {
      effects.forEach((effect) => effect?.cleanup?.());
    },
  };
  globalThis.__snapshotHookHarness = harness;

  const lockedRef = {};
  let lock = false;
  Object.defineProperty(lockedRef, "current", {
    get: () => lock,
    set: (value) => {
      lock = value;
      if (value) events.push("lock");
    },
  });

  const originalLogo = { asset: "logo original" };
  const originalBackground = { asset: "background original" };
  const originalPrepared = {
    audio: { asset: "pcm original" },
    events: [1],
    envelopes: [{ rms: 0.2 }],
    overview: [0.3],
  };
  const range = [2, 4];
  const settings = { mode: "ring", primary: "#original", logoPlacements: { ring: { x: 25 } } };
  const subtitles = [{ id: "cue-1", start: 2.2, end: 3.5, text: "original subtitle" }];
  const source = {
    file: { name: "track.wav" },
    duration: 12,
    range,
    format: "square",
    resolution: 480,
    frameRate: 24,
    videoCompression: true,
    settings,
    subtitles,
    logo: originalLogo,
    background: originalBackground,
    prepared: originalPrepared,
    reducedMotion: false,
  };
  const options = {
    lockedRef,
    getSource: () => source,
    pausePlayback: () => {
      events.push(`pause:${lockedRef.current}`);
    },
  };
  cursor = 0;
  const hook = useExportController(options);
  harness.flushEffects();

  const priorDocument = globalThis.document;
  const priorCreateObjectURL = URL.createObjectURL;
  const priorRevokeObjectURL = URL.revokeObjectURL;
  let task;
  globalThis.document = { createElement: () => ({ click: () => events.push("download") }) };
  URL.createObjectURL = () => "blob:hook-test";
  URL.revokeObjectURL = () => {};
  try {
    task = hook.exportVideo();
    assert.ok(task);
    assert.equal(lockedRef.current, true);
    await waitFor(() => events.includes("adapter-module"));
    assert.equal(lockedRef.current, true, "the shared lock stays held during lazy import");
    assert.ok(events.indexOf("lock") < events.indexOf("pause:true"));
    assert.ok(events.indexOf("pause:true") < events.indexOf("adapter-module"));

    range[0] = 8;
    range[1] = 10;
    settings.primary = "#mutated";
    settings.logoPlacements.ring.x = 90;
    subtitles[0].text = "mutated subtitle";
    source.logo = { asset: "replacement logo" };
    source.background = { asset: "replacement background" };
    source.prepared = { events: [9] };

    resolveImport();
    await waitFor(() => events.includes("adapter-called"));
    const received = globalThis.__snapshotExportOptions;
    assert.equal(received.start, 2);
    assert.equal(received.end, 4);
    assert.equal(received.settings.primary, "#original");
    assert.equal(received.settings.logoPlacements.ring.x, 25);
    assert.equal(received.subtitles[0].text, "original subtitle");
    assert.equal(received.prepared, originalPrepared);
    assert.equal(received.logo, originalLogo);
    assert.equal(received.background, originalBackground);
    assert.equal(received.videoCompression, true);
    assert.equal(received.frameRate, 24);
    assert.equal(lockedRef.current, true, "the lock remains held while encoding is pending");

    resolveEncoding({ blob: new Blob(["video"]), extension: "webm" });
    await task;
    assert.equal(events.at(-1), "download");
    assert.equal(lockedRef.current, false);
  } finally {
    harness.cleanup();
    resolveImport();
    resolveEncoding({ blob: new Blob(["cleanup"]), extension: "webm" });
    await task?.catch(() => {});
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    if (priorCreateObjectURL === undefined) delete URL.createObjectURL;
    else URL.createObjectURL = priorCreateObjectURL;
    if (priorRevokeObjectURL === undefined) delete URL.revokeObjectURL;
    else URL.revokeObjectURL = priorRevokeObjectURL;
    delete globalThis.__snapshotHookHarness;
    delete globalThis.__snapshotEvents;
    delete globalThis.__snapshotImportGate;
    delete globalThis.__snapshotEncodeGate;
    delete globalThis.__snapshotExportOptions;
  }
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for export hook lifecycle event.");
}
