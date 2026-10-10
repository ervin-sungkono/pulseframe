import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadSources } from "./load-source.mjs";

const directory = mkdtempSync(join(tmpdir(), "pulseframe-studio-project-"));
const projectModulesPromise = loadSources({
  modules: [
    "project-file",
    "visual-settings",
    "visual-settings-model",
    "composition",
    "project-model",
    "playlist-timeline",
    "customizer-config",
  ],
});
const paths = {
  react: join(directory, "react-mock.mjs"),
  media: join(directory, "media-mock.mjs"),
  tracks: join(directory, "tracks-mock.mjs"),
  model: join(directory, "project-model.mjs"),
  timeline: join(directory, "playlist-timeline.mjs"),
  releaseRecipe: join(directory, "release-recipe.mjs"),
  exportRequest: join(directory, "export-request-mock.mjs"),
  hook: join(directory, "use-studio-project.mjs"),
};
writeFileSync(
  paths.react,
  `
    export const useCallback = (...args) => globalThis.__studioHarness.useCallback(...args);
    export const useEffect = (...args) => globalThis.__studioHarness.useEffect(...args);
    export const useRef = (...args) => globalThis.__studioHarness.useRef(...args);
    export const useState = (...args) => globalThis.__studioHarness.useState(...args);
  `,
);
writeFileSync(
  paths.media,
  `
    export function useMediaSession(options) {
      globalThis.__studioStore.mediaOptions = options;
      return globalThis.__studioStore.media;
    }
  `,
);
writeFileSync(
  paths.tracks,
  `
    export function useProjectTracks(options) {
      globalThis.__studioStore.trackOptions = options;
      return globalThis.__studioStore.getTracksResult();
    }
  `,
);
writeFileSync(
  paths.model,
  `
    export function createProjectTrack(file, duration, id) {
      return { id, file, duration, range: [0, duration], title: file.name, artist: '', subtitles: [], artwork: null };
    }
    export function getProjectTrack(tracks, id) {
      return tracks.find((track) => track.id === id) ?? null;
    }
    export function updateProjectTrack(track, patch) {
      return { ...track, ...patch };
    }
  `,
);
writeFileSync(
  paths.timeline,
  `
    export function buildPlaylistTimeline(tracks) {
      let cursor = 0;
      const segments = [];
      for (const track of tracks) {
        const [sourceStart, sourceEnd] = track.range;
        if (sourceEnd <= sourceStart) continue;
        const length = sourceEnd - sourceStart;
        segments.push({ trackId: track.id, track, start: cursor, end: cursor + length, sourceStart, sourceEnd });
        cursor += length;
      }
      return { segments, duration: cursor };
    }
    export function resolveProjectTime(timeline, projectTime) {
      if (!Number.isFinite(projectTime) || projectTime < 0 || !timeline.segments.length) return null;
      const segment = timeline.segments.find((part) => projectTime < part.end) ?? timeline.segments.at(-1);
      return { trackId: segment.trackId, sourceTime: segment.sourceStart + projectTime - segment.start };
    }
  `,
);
writeFileSync(
  paths.exportRequest,
  `
    export function createExportRequest() { throw new Error('Not used by the studio hook test.'); }
    export function safeFilenameStem(value) { return value; }
  `,
);
const releaseRecipeSource = readFileSync(
  new URL("../lib/release-recipe.ts", import.meta.url),
  "utf8",
).replaceAll('"./export-request"', JSON.stringify(pathToFileURL(paths.exportRequest).href));
writeFileSync(
  paths.releaseRecipe,
  ts.transpileModule(releaseRecipeSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText,
);
let hookSource = readFileSync(new URL("../hooks/use-studio-project.ts", import.meta.url), "utf8");
hookSource = hookSource
  .replaceAll('"react"', JSON.stringify(pathToFileURL(paths.react).href))
  .replaceAll('"./use-media-session"', JSON.stringify(pathToFileURL(paths.media).href))
  .replaceAll('"./use-project-tracks"', JSON.stringify(pathToFileURL(paths.tracks).href))
  .replaceAll('"@/lib/project-model"', JSON.stringify(pathToFileURL(paths.model).href))
  .replaceAll('"@/lib/playlist-timeline"', JSON.stringify(pathToFileURL(paths.timeline).href))
  .replaceAll('"@/lib/release-recipe"', JSON.stringify(pathToFileURL(paths.releaseRecipe).href));
writeFileSync(
  paths.hook,
  ts.transpileModule(hookSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText,
);
const { useStudioProject } = await import(pathToFileURL(paths.hook).href);

const projectModel = await import(pathToFileURL(paths.model).href);

after(() => rmSync(directory, { recursive: true, force: true }));

function makeHarness() {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const sameDeps = (left, right) =>
    Boolean(
      left &&
      right &&
      left.length === right.length &&
      left.every((item, index) => Object.is(item, right[index])),
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
      const prior = effects[index];
      effects[index] = {
        create,
        deps,
        cleanup: prior?.cleanup,
        changed: !prior || !sameDeps(prior.deps, deps),
      };
    },
    render(options) {
      cursor = 0;
      const value = useStudioProject(options);
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

function setup({ tracks = [], activeTrackId = tracks[0]?.id ?? null, mediaOverrides = {} } = {}) {
  const calls = { loads: [], seeks: [], plays: 0, pauses: 0 };
  const store = {
    mediaOptions: null,
    trackOptions: null,
    tracks,
    activeTrackId,
    selectedTrackId: activeTrackId,
    media: null,
    deferredLoad: null,
    getTracksResult() {
      return {
        tracks: store.tracks,
        activeTrackId: store.activeTrackId,
        selectedTrackId: store.selectedTrackId,
        importing: false,
        importError: "",
        addFiles: async () => [],
        selectTrack(id) {
          store.selectedTrackId = id;
        },
        async activateTrack(id) {
          const track = store.tracks.find((item) => item.id === id);
          if (!track) return false;
          const result = await store.trackOptions.activateTrack(track);
          if (result === false) return false;
          store.activeTrackId = id;
          store.selectedTrackId = id;
          return true;
        },
        updateTrack(id, patch) {
          store.tracks = store.tracks.map((track) =>
            track.id === id ? projectModel.updateProjectTrack(track, patch) : track,
          );
        },
        reorderTrack(id, toIndex) {
          const fromIndex = store.tracks.findIndex((track) => track.id === id);
          if (fromIndex < 0) return;
          const reordered = [...store.tracks];
          const [track] = reordered.splice(fromIndex, 1);
          reordered.splice(toIndex, 0, track);
          store.tracks = reordered;
        },
        moveTrack(id, direction) {
          const index = store.tracks.findIndex((track) => track.id === id);
          if (index >= 0) this.reorderTrack(id, index + direction);
        },
        removeTrack(id) {
          store.tracks = store.tracks.filter((track) => track.id !== id);
          if (store.activeTrackId === id) store.activeTrackId = null;
        },
        replaceTracks(next, id) {
          store.tracks = next;
          store.activeTrackId = id ?? null;
          store.selectedTrackId = id ?? null;
          return true;
        },
        upsertActiveTrack() {
          return true;
        },
      };
    },
  };
  const snapshot = {
    duration: 10,
    logo: null,
    background: null,
    media: { currentTime: 0 },
  };
  const session = {
    get snapshot() {
      return snapshot;
    },
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    pause() {
      calls.pauses++;
    },
  };
  const listeners = new Set();
  store.media = {
    session,
    duration: snapshot.duration,
    suspendPreparedSound() {},
    async loadFile(file, range, project, options) {
      calls.loads.push({ file, range, project, options });
      return store.deferredLoad ?? true;
    },
    seek(time) {
      calls.seeks.push(time);
      snapshot.media.currentTime = time;
    },
    async togglePlay() {
      calls.plays++;
      return true;
    },
    async previewRange() {
      return true;
    },
    async changeArtwork() {
      return true;
    },
    ...mediaOverrides,
  };
  const harness = makeHarness();
  globalThis.__studioStore = store;
  globalThis.__studioHarness = harness;
  const options = {};
  let project = harness.render(options);
  return {
    calls,
    listeners,
    store,
    harness,
    options,
    get project() {
      return project;
    },
    render() {
      project = harness.render(options);
      return project;
    },
    cleanup() {
      harness.cleanup();
      delete globalThis.__studioStore;
      delete globalThis.__studioHarness;
    },
  };
}

function file(name) {
  return new File([name], name, { type: "audio/wav" });
}

test("project commits restore ordered tracks, active source, and the saved global range", () => {
  const first = projectModel.createProjectTrack(file("first.wav"), 8, "first");
  const second = projectModel.createProjectTrack(file("second.wav"), 6, "second");
  const studio = setup();
  try {
    studio.store.mediaOptions.onCommitted({
      next: second.file,
      range: second.range,
      snapshot: { duration: second.duration },
      project: {
        settings: {},
        tracks: [first, second],
        activeTrackId: second.id,
        globalExportRange: [2, 9],
      },
    });
    const restored = studio.render();

    assert.deepEqual(
      restored.tracks.tracks.map((track) => track.id),
      ["first", "second"],
    );
    assert.equal(restored.activeTrack.id, "second");
    assert.equal(restored.activeTrack.file, second.file);
    assert.deepEqual(restored.range, [2, 9]);
    assert.equal(restored.exportDuration, 14);
  } finally {
    studio.cleanup();
  }
});

test("single-track release recipes serialize globally and restore at the source trim offset", async () => {
  const modules = await projectModulesPromise;
  const { makeProjectFile, readProjectFile } = modules["project-file"];
  const { DEFAULT_SETTINGS } = modules["customizer-config"];
  const trimmed = projectModel.createProjectTrack(file("trimmed.wav"), 20, "trimmed");
  trimmed.range = [5, 10];
  const canonicalRecipe = {
    fullVideo: {
      enabled: true,
      aspect: "landscape",
      resolution: 720,
      frameRate: 30,
      videoCompression: false,
      range: [0, 5],
    },
    portraitTeaser: {
      enabled: true,
      aspect: "portrait",
      resolution: 480,
      frameRate: 24,
      videoCompression: true,
      range: [0, 3],
    },
    thumbnail: { enabled: true, aspect: "square", resolution: 480, time: 2.5 },
  };
  const blob = makeProjectFile({
    settings: DEFAULT_SETTINGS,
    media: trimmed.file,
    logo: null,
    background: null,
    format: "landscape",
    range: trimmed.range,
    subtitles: [],
    tracks: [trimmed],
    activeTrackId: trimmed.id,
    releaseRecipe: canonicalRecipe,
  });
  const opened = await readProjectFile(new File([blob], "trimmed.pulseframe"));
  assert.deepEqual(opened.range, [5, 10]);
  assert.deepEqual(opened.globalExportRange, [0, 5]);
  assert.deepEqual(opened.releaseRecipe, canonicalRecipe);

  const studio = setup();
  try {
    studio.store.mediaOptions.onCommitted({
      next: opened.media,
      range: opened.range,
      snapshot: { duration: opened.tracks[0].duration },
      project: opened,
    });
    const restored = studio.render();

    assert.deepEqual(restored.range, [5, 10], "the editor keeps source-time trim bounds");
    assert.deepEqual(restored.globalReleaseRecipe, canonicalRecipe);
    assert.deepEqual(restored.releaseRecipe, {
      fullVideo: { ...canonicalRecipe.fullVideo, range: [5, 10] },
      portraitTeaser: { ...canonicalRecipe.portraitTeaser, range: [5, 8] },
      thumbnail: { ...canonicalRecipe.thumbnail, time: 7.5 },
    });
  } finally {
    studio.cleanup();
  }
});

test("saved release recipes expire when track trims or order change", () => {
  const first = projectModel.createProjectTrack(file("first.wav"), 8, "first");
  const second = projectModel.createProjectTrack(file("second.wav"), 6, "second");
  const recipe = {
    fullVideo: {
      enabled: true,
      aspect: "landscape",
      resolution: 720,
      frameRate: 30,
      videoCompression: false,
      range: [0, 14],
    },
    portraitTeaser: {
      enabled: true,
      aspect: "portrait",
      resolution: 480,
      frameRate: 24,
      videoCompression: true,
      range: [0, 5],
    },
    thumbnail: { enabled: true, aspect: "square", resolution: 480, time: 7 },
  };
  const studio = setup();
  const restoreProject = () => {
    studio.store.mediaOptions.onCommitted({
      next: first.file,
      range: first.range,
      snapshot: { duration: first.duration },
      project: {
        settings: {},
        tracks: [first, second],
        activeTrackId: first.id,
        globalExportRange: [0, 14],
        releaseRecipe: recipe,
      },
    });
    return studio.render();
  };
  try {
    assert.ok(restoreProject().globalReleaseRecipe);
    studio.project.tracks.updateTrack(first.id, { range: [0, 7] });
    assert.equal(studio.render().globalReleaseRecipe, null);

    assert.ok(restoreProject().globalReleaseRecipe);
    studio.project.tracks.reorderTrack(second.id, 0);
    assert.equal(studio.render().globalReleaseRecipe, null);
  } finally {
    studio.cleanup();
  }
});

test("stopping during pending global-range activation must cancel the late preview", async () => {
  const first = projectModel.createProjectTrack(file("first.wav"), 8, "first");
  const second = projectModel.createProjectTrack(file("second.wav"), 6, "second");
  const studio = setup({ tracks: [first, second] });
  let finishLoad;
  studio.store.deferredLoad = new Promise((resolve) => {
    finishLoad = resolve;
  });
  try {
    const pendingPreview = studio.project.previewProjectRange([3, 10]);
    assert.equal(studio.calls.loads.length, 1);
    assert.equal(studio.calls.loads[0].file, first.file);

    studio.project.stopPlaylist();
    finishLoad(true);
    assert.equal(await pendingPreview, false);
    assert.equal(studio.project.playlistPlaying, false);
    assert.equal(studio.calls.plays, 0);
  } finally {
    studio.cleanup();
  }
});

for (const action of ["remove another track", "replace media"]) {
  test(`playlist playback pauses when asked to ${action}`, async () => {
    const first = projectModel.createProjectTrack(file("first.wav"), 8, "first");
    const second = projectModel.createProjectTrack(file("second.wav"), 6, "second");
    const studio = setup({ tracks: [first, second] });
    try {
      assert.equal(await studio.project.previewProjectRange([0, 14]), true);
      studio.render();
      const pausesBeforeAction = studio.calls.pauses;

      if (action === "remove another track") await studio.project.removeTrack(second.id);
      else await studio.project.loadFile(file("replacement.wav"));

      assert.equal(studio.calls.pauses, pausesBeforeAction + 1);
      assert.equal(studio.render().playlistPlaying, false);
    } finally {
      studio.cleanup();
    }
  });
}

test("global-range preview stops at its requested end across a playlist cut", async () => {
  const first = projectModel.createProjectTrack(file("first.wav"), 8, "first");
  const second = projectModel.createProjectTrack(file("second.wav"), 6, "second");
  const studio = setup({ tracks: [first, second] });
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervalCallbacks = [];
  globalThis.setInterval = (callback) => {
    intervalCallbacks.push(callback);
    return intervalCallbacks.length;
  };
  globalThis.clearInterval = () => {};
  try {
    assert.equal(await studio.project.previewProjectRange([3, 10]), true);
    assert.deepEqual(studio.calls.seeks, [3]);
    studio.render();
    assert.equal(intervalCallbacks.length, 1);

    studio.store.media.session.snapshot.media.currentTime = 8;
    intervalCallbacks.at(-1)();
    await new Promise((resolve) => setImmediate(resolve));
    studio.render();
    assert.equal(studio.project.activeTrack.id, "second");
    assert.equal(studio.calls.loads.at(-1).file, second.file);
    assert.equal(studio.calls.seeks.at(-1), second.range[0]);

    studio.store.media.session.snapshot.media.currentTime = 3;
    intervalCallbacks.at(-1)();
    studio.render();
    assert.equal(studio.project.playlistPlaying, false);
    assert.ok(studio.calls.pauses > 0);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    studio.cleanup();
  }
});
