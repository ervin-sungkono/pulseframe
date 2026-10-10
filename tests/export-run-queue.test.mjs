import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = mkdtempSync(join(tmpdir(), "pulseframe-export-run-"));
const requestPath = join(directory, "export-request.mjs");
const jobPath = join(directory, "export-job.mjs");
const requestSource = readFileSync(new URL("../lib/export-request.ts", import.meta.url), "utf8");
const jobSource = readFileSync(new URL("../lib/export-job.ts", import.meta.url), "utf8");
writeFileSync(
  requestPath,
  ts.transpileModule(requestSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText,
);
writeFileSync(
  jobPath,
  ts
    .transpileModule(jobSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace('from "./export-request"', 'from "./export-request.mjs"'),
);
const { createExportJobController } = await import(pathToFileURL(jobPath).href);
const { snapshotExportRequests } = await import(pathToFileURL(requestPath).href);
after(() => rmSync(directory, { recursive: true, force: true }));

function request(id) {
  return {
    id,
    label: `Request ${id}`,
    filename: `request-${id}`,
    kind: "video",
    source: {
      file: { name: `${id}.wav` },
      sourceKind: "audio",
      duration: 10,
      range: [0, 10],
      format: "landscape",
      resolution: 720,
      frameRate: 30,
      videoCompression: false,
      settings: { nested: { color: "#111111" } },
      subtitles: [{ id: "caption", start: 1, end: 2, text: "original" }],
      logo: null,
      background: null,
      reducedMotion: false,
    },
  };
}

function job(options = {}) {
  const lockedRef = { current: false };
  const states = [];
  const errors = [];
  let pauses = 0;
  const controller = createExportJobController({
    lockedRef,
    pausePlayback: () => pauses++,
    execute: async () => ({ saved: true, extension: "mp4" }),
    onState: (exporting, progress, run) => states.push({ exporting, progress, run }),
    onError: (message) => errors.push(message),
    onNotice: () => {},
    ...options,
  });
  return {
    controller,
    lockedRef,
    states,
    errors,
    get pauses() {
      return pauses;
    },
  };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for the export queue.");
}

test("ordered runs keep one lock, stop at failure, then retry only unfinished requests", async () => {
  const executions = [];
  let failSecond = true;
  const observedLocks = [];
  const testJob = job({
    executeRequest: async (item) => {
      executions.push(item.id);
      observedLocks.push(testJob.lockedRef.current);
      if (item.id === "second" && failSecond) {
        failSecond = false;
        throw new Error("The second output failed.");
      }
      return { saved: true, extension: "webm" };
    },
  });

  await testJob.controller.runRequests([request("first"), request("second"), request("third")]);
  assert.equal(testJob.pauses, 1, "playback pauses once for the entire batch");
  assert.equal(testJob.lockedRef.current, false);
  assert.deepEqual(executions, ["first", "second"]);
  assert.deepEqual(testJob.errors, ["The second output failed."]);
  assert.deepEqual(
    testJob.states.at(-1).run.items.map((item) => item.status),
    ["complete", "failed", "pending"],
  );
  assert.ok(observedLocks.every(Boolean), "the shared lock stays held at every item start");

  await testJob.controller.retryPending();
  assert.deepEqual(executions, ["first", "second", "second", "third"]);
  assert.deepEqual(
    testJob.states.at(-1).run.items.map((item) => item.status),
    ["complete", "complete", "complete"],
  );
  assert.equal(testJob.lockedRef.current, false);
});

test("Blob fallback exposes one output at a time and waits for the user's download action", async () => {
  const started = [];
  const ready = [];
  let controller;
  const testJob = job({
    executeRequest: async (item) => {
      started.push(item.id);
      return { blob: new Blob([item.id]), extension: "mp4" };
    },
    onOutputReady: (_output, item) => ready.push(item.id),
  });
  controller = testJob.controller;
  const task = controller.runRequests([request("one"), request("two")]);
  await waitFor(() => ready.length === 1);
  assert.deepEqual(started, ["one"], "the next file waits until the first Blob is downloaded");
  assert.deepEqual(ready, ["one"]);
  assert.equal(testJob.lockedRef.current, true);
  controller.continueOutput();
  await waitFor(() => ready.length === 2);
  assert.deepEqual(started, ["one", "two"]);
  controller.continueOutput();
  await task;
  assert.deepEqual(
    testJob.states.at(-1).run.items.map((item) => item.status),
    ["complete", "complete"],
  );
  assert.equal(testJob.lockedRef.current, false);
});

test("cancel holds the lock until the active encoder settles and stops the rest", async () => {
  let finish;
  let started = 0;
  const testJob = job({
    executeRequest: () => {
      started++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const task = testJob.controller.runRequests([request("active"), request("remaining")]);
  assert.equal(testJob.lockedRef.current, true);
  testJob.controller.cancel();
  assert.equal(
    testJob.lockedRef.current,
    true,
    "cancel waits for encoder cleanup before releasing the lock",
  );
  finish({ saved: true, extension: "mp4" });
  await task;
  assert.equal(started, 1);
  assert.deepEqual(
    testJob.states.at(-1).run.items.map((item) => item.status),
    ["stopped", "stopped"],
  );
  assert.equal(testJob.lockedRef.current, false);
});

test("retry uses the edited queue and does not resurrect a removed failed request", async () => {
  const executions = [];
  const testJob = job({
    executeRequest: async (item) => {
      executions.push(item.id);
      if (item.id === "remove-me") throw new Error("This output failed.");
      return { saved: true, extension: "mp4" };
    },
  });
  await testJob.controller.runRequests([
    request("done"),
    request("remove-me"),
    request("keep-pending"),
  ]);
  await testJob.controller.retryPending([request("done"), request("keep-pending")]);
  assert.deepEqual(executions, ["done", "remove-me", "keep-pending"]);
  assert.deepEqual(
    testJob.states.at(-1).run.items.map((item) => item.id),
    ["done", "keep-pending"],
  );
});

test("queue snapshots clone settings and captions while retaining media File references", () => {
  const media = { name: "song.wav" };
  const track = {
    id: "track-1",
    file: media,
    duration: 10,
    range: [1, 9],
    title: "Song",
    artist: "Artist",
    subtitles: [{ id: "track-caption", start: 2, end: 3, text: "track" }],
    artwork: null,
  };
  const logoImage = { label: "decoded-logo" };
  const artworkImage = { label: "decoded-artwork" };
  const logoFile = { name: "logo.png" };
  const artworkFile = { name: "cover.png" };
  const original = request("snapshot");
  original.source.file = media;
  original.source.tracks = [track];
  original.source.logo = logoImage;
  original.source.artwork = artworkImage;
  original.source.logoFile = logoFile;
  original.source.artworkFile = artworkFile;
  original.source.prepared = { decoded: true };
  original.source.snapshot = { sound: { decoded: true }, media: { active: true } };
  const snapshot = snapshotExportRequests([original])[0];
  original.source.settings.nested.color = "#ffffff";
  original.source.subtitles[0].text = "changed";
  original.source.tracks[0].subtitles[0].text = "changed track";

  assert.equal(snapshot.source.file, media);
  assert.equal(snapshot.source.tracks[0].file, media);
  assert.equal(snapshot.source.tracks[0].artwork, null);
  assert.equal(snapshot.source.logo, null, "decoded preview images are not pinned by a batch item");
  assert.equal(snapshot.source.artwork, null);
  assert.equal(
    snapshot.source.logoFile,
    logoFile,
    "batch items keep the local input file reference",
  );
  assert.equal(snapshot.source.artworkFile, artworkFile);
  assert.equal(snapshot.source.settings.nested.color, "#111111");
  assert.equal(snapshot.source.subtitles[0].text, "original");
  assert.equal(snapshot.source.tracks[0].subtitles[0].text, "track");
  assert.equal(snapshot.source.prepared, undefined);
  assert.equal(snapshot.source.snapshot, undefined);

  const retained = snapshotExportRequests([original], { keepRuntime: true })[0];
  assert.equal(
    retained.source.logo,
    logoImage,
    "the active single-export path can retain session image handles",
  );
  assert.equal(retained.source.artwork, artworkImage);
});
