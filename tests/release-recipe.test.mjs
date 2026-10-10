import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./load-source.mjs";

const modulesPromise = loadSources();

test("release defaults make independent full, 30-second portrait and selected-time PNG requests", async () => {
  const modules = await modulesPromise;
  const { DEFAULT_SETTINGS } = modules["customizer-config"];
  const { createDefaultReleaseRecipe, makeReleaseRequests } = modules["release-recipe"];
  const source = {
    file: new File(["audio"], "midnight.wav", { type: "audio/wav" }),
    sourceKind: "audio",
    duration: 100,
    range: [10, 80],
    format: "landscape",
    resolution: 1080,
    frameRate: 30,
    videoCompression: false,
    settings: structuredClone(DEFAULT_SETTINGS),
    subtitles: [],
    logo: null,
    background: null,
    reducedMotion: false,
  };
  const recipe = createDefaultReleaseRecipe(source, 26.4);
  assert.deepEqual(recipe.fullVideo.range, [10, 80]);
  assert.deepEqual(recipe.portraitTeaser.range, [10, 40]);
  assert.equal(recipe.thumbnail.time, 26.4);

  recipe.fullVideo.resolution = 720;
  recipe.portraitTeaser.frameRate = 60;
  recipe.thumbnail.aspect = "square";
  const requests = makeReleaseRequests(source, recipe);
  assert.deepEqual(
    requests.map(({ id, kind, filename }) => ({ id, kind, filename })),
    [
      { id: "release-full-video", kind: "video", filename: "midnight-full" },
      { id: "release-portrait-teaser", kind: "video", filename: "midnight-teaser-portrait" },
      { id: "release-thumbnail", kind: "still", filename: "midnight-thumbnail" },
    ],
  );
  assert.equal(requests[0].source.resolution, 720);
  assert.equal(requests[1].source.frameRate, 60);
  assert.equal(requests[1].source.format, "portrait");
  assert.equal(requests[2].source.format, "square");
  assert.equal(requests[2].stillTime, 26.4);
  assert.notEqual(
    requests[0].source,
    requests[1].source,
    "each output keeps its own source/settings snapshot",
  );
});

test("release recipes reject outputs outside the selected project range", async () => {
  const modules = await modulesPromise;
  const { DEFAULT_SETTINGS } = modules["customizer-config"];
  const { createDefaultReleaseRecipe, makeReleaseRequests } = modules["release-recipe"];
  const source = {
    file: new File(["audio"], "track.wav", { type: "audio/wav" }),
    sourceKind: "audio",
    duration: 12,
    range: [2, 10],
    format: "landscape",
    resolution: 720,
    frameRate: 30,
    videoCompression: false,
    settings: structuredClone(DEFAULT_SETTINGS),
    subtitles: [],
    logo: null,
    background: null,
    reducedMotion: false,
  };
  const recipe = createDefaultReleaseRecipe(source, 5);
  recipe.portraitTeaser.range = [1, 9];
  assert.throws(() => makeReleaseRequests(source, recipe), /within the project/);
});

test("release recipe time shifting bridges active-track and project-global timelines", async () => {
  const modules = await modulesPromise;
  const { shiftReleaseRecipe } = modules["release-recipe"];
  const original = {
    fullVideo: {
      enabled: true,
      aspect: "landscape",
      resolution: 720,
      frameRate: 30,
      videoCompression: false,
      range: [2, 12],
    },
    portraitTeaser: {
      enabled: true,
      aspect: "portrait",
      resolution: 480,
      frameRate: 24,
      videoCompression: true,
      range: [3, 8],
    },
    thumbnail: { enabled: true, aspect: "square", resolution: 480, time: 6 },
  };
  const global = shiftReleaseRecipe(original, 40);
  assert.deepEqual(global.fullVideo.range, [42, 52]);
  assert.deepEqual(global.portraitTeaser.range, [43, 48]);
  assert.equal(global.thumbnail.time, 46);
  assert.deepEqual(shiftReleaseRecipe(global, -40), original);
  assert.deepEqual(original.fullVideo.range, [2, 12], "shifting does not mutate the stored recipe");
});
