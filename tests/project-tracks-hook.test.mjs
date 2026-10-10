import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = mkdtempSync(join(tmpdir(), "pulseframe-project-tracks-hook-"));
const paths = {
  react: join(directory, "react-mock.mjs"),
  model: join(directory, "project-model.mjs"),
  hook: join(directory, "use-project-tracks.mjs"),
};
writeFileSync(
  paths.react,
  `
    export const useCallback = (...args) => globalThis.__projectTracksHarness.useCallback(...args);
    export const useEffect = (...args) => globalThis.__projectTracksHarness.useEffect(...args);
    export const useRef = (...args) => globalThis.__projectTracksHarness.useRef(...args);
    export const useState = (...args) => globalThis.__projectTracksHarness.useState(...args);
  `,
);
const modelSource = readFileSync(new URL("../lib/project-model.ts", import.meta.url), "utf8");
writeFileSync(
  paths.model,
  ts.transpileModule(modelSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText,
);
const hookSource = readFileSync(new URL("../hooks/use-project-tracks.ts", import.meta.url), "utf8")
  .replaceAll('"react"', JSON.stringify(pathToFileURL(paths.react).href))
  .replaceAll('"@/lib/project-model"', JSON.stringify(pathToFileURL(paths.model).href));
writeFileSync(
  paths.hook,
  ts.transpileModule(hookSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText,
);
const { useProjectTracks } = await import(pathToFileURL(paths.hook).href);
const { createProjectTrack } = await import(pathToFileURL(paths.model).href);

after(() => rmSync(directory, { recursive: true, force: true }));

function makeHarness(options) {
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
        (value) => (slot.value = typeof value === "function" ? value(slot.value) : value),
      ];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      const slot = slots[index];
      if (!slot || !sameDeps(slot.deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
    useEffect(create, deps) {
      const index = cursor++;
      const previous = effects[index];
      effects[index] = {
        create,
        deps,
        cleanup: previous?.cleanup,
        changed: !previous || !sameDeps(previous.deps, deps),
      };
    },
    render() {
      cursor = 0;
      const value = useProjectTracks(options);
      effects.forEach((effect) => {
        if (!effect.changed) return;
        effect.cleanup?.();
        effect.cleanup = effect.create();
        effect.changed = false;
      });
      return value;
    },
    cleanup() {
      effects.forEach((effect) => effect?.cleanup?.());
    },
  };
  return harness;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const tracks = ["A", "B", "C"].map((id) =>
    createProjectTrack(new File([id], `${id}.wav`, { type: "audio/wav" }), 10, id),
  );
  const gates = new Map();
  const options = {
    initialTracks: tracks,
    activeTrackId: "A",
    activateTrack: (track) => gates.get(track.id)?.promise ?? false,
  };
  const harness = makeHarness(options);
  globalThis.__projectTracksHarness = harness;
  return {
    tracks,
    gates,
    harness,
    render: () => harness.render(),
    cleanup() {
      harness.cleanup();
      delete globalThis.__projectTracksHarness;
    },
  };
}

test("metadata selection during activation keeps the committed active track and selected row distinct", async () => {
  const hook = setup();
  const activation = deferred();
  hook.gates.set("B", activation);
  try {
    let result = hook.render();
    const activateB = result.activateTrack("B");
    result = hook.render();
    assert.equal(result.activeTrackId, "A");
    assert.equal(result.selectedTrackId, "B");

    result.selectTrack("C");
    result = hook.render();
    assert.equal(result.activeTrackId, "A");
    assert.equal(result.selectedTrackId, "C");

    activation.resolve(true);
    assert.equal(await activateB, true);
    result = hook.render();
    assert.equal(result.activeTrackId, "B");
    assert.equal(result.selectedTrackId, "C");
  } finally {
    hook.cleanup();
  }
});

test("a competing activation invalidates an older pending activation", async () => {
  const hook = setup();
  const activateB = deferred();
  const activateC = deferred();
  hook.gates.set("B", activateB);
  hook.gates.set("C", activateC);
  try {
    let result = hook.render();
    const first = result.activateTrack("B");
    result = hook.render();
    const second = result.activateTrack("C");
    result = hook.render();
    assert.equal(result.activeTrackId, "A");
    assert.equal(result.selectedTrackId, "C");

    activateB.resolve(true);
    assert.equal(await first, false);
    result = hook.render();
    assert.equal(result.activeTrackId, "A");
    assert.equal(result.selectedTrackId, "C");

    activateC.resolve(true);
    assert.equal(await second, true);
    result = hook.render();
    assert.equal(result.activeTrackId, "C");
    assert.equal(result.selectedTrackId, "C");
  } finally {
    hook.cleanup();
  }
});
