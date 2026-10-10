import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./load-source.mjs";

const modulesPromise = loadSources();
const mediaFile = (name, contents, type = "audio/wav") => new File([contents], name, { type });

function projectFileWithManifest(blob, change, extraPayload = []) {
  return blob
    .slice(0, 8)
    .arrayBuffer()
    .then(async (headerBuffer) => {
      const header = new Uint8Array(headerBuffer);
      const oldLength = new DataView(header.buffer).getUint32(4, true);
      const manifest = JSON.parse(await blob.slice(8, 8 + oldLength).text());
      change(manifest);
      const bytes = new TextEncoder().encode(JSON.stringify(manifest));
      new DataView(header.buffer).setUint32(4, bytes.length, true);
      return new File(
        [header, bytes, blob.slice(8 + oldLength), ...extraPayload],
        "altered.pulseframe",
      );
    });
}

test("v3 projects round-trip ordered tracks, trims, captions and artwork as sliced assets", async () => {
  const modules = await modulesPromise;
  const { makeProjectFile, readProjectFile } = modules["project-file"];
  const { DEFAULT_SETTINGS } = modules["customizer-config"];
  const { createProjectTrack } = modules["project-model"];
  const first = createProjectTrack(mediaFile("first.wav", "raw-one"), 18, "track-first");
  first.range = [2, 12];
  first.title = "First title";
  first.artist = "First artist";
  first.subtitles = [{ id: "line-a", start: 3, end: 4, text: "First line" }];
  first.artwork = new File(["cover-one"], "cover-one.png", { type: "image/png" });
  const second = createProjectTrack(mediaFile("second.wav", "raw-two"), 20, "track-second");
  second.range = [5, 14];
  second.title = "Second title";
  second.artist = "Second artist";
  second.subtitles = [{ id: "line-b", start: 6, end: 8, text: "Second line" }];
  second.artwork = new File(["cover-two"], "cover-two.webp", { type: "image/webp" });

  const blob = makeProjectFile({
    settings: DEFAULT_SETTINGS,
    media: first.file,
    logo: new File(["logo"], "logo.png", { type: "image/png" }),
    background: new File(["bg"], "background.png", { type: "image/png" }),
    format: "landscape",
    range: first.range,
    subtitles: first.subtitles,
    tracks: [first, second],
    activeTrackId: second.id,
    globalExportRange: [1, 15],
    releaseRecipe: {
      fullVideo: {
        enabled: true,
        aspect: "landscape",
        resolution: 1080,
        frameRate: 30,
        videoCompression: false,
        range: [1, 15],
      },
      portraitTeaser: {
        enabled: true,
        aspect: "portrait",
        resolution: 720,
        frameRate: 30,
        videoCompression: true,
        range: [2, 12],
      },
      thumbnail: { enabled: true, aspect: "square", resolution: 480, time: 7 },
    },
  });
  const header = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const manifestLength = new DataView(header.buffer).getUint32(4, true);
  const manifest = JSON.parse(await blob.slice(8, 8 + manifestLength).text());
  assert.equal(manifest.version, 3);
  assert.equal(manifest.tracks.length, 2);
  assert.equal(manifest.assets.length, 6);

  const opened = await readProjectFile(new File([blob], "playlist.pulseframe"));
  assert.equal(opened.activeTrackId, "track-second");
  assert.equal(opened.media.name, "second.wav");
  assert.equal(opened.settings.trackTitle, "Second title");
  assert.equal(opened.settings.trackArtist, "Second artist");
  assert.deepEqual(opened.range, [5, 14]);
  assert.deepEqual(opened.globalExportRange, [1, 15]);
  assert.deepEqual(opened.releaseRecipe, {
    fullVideo: {
      enabled: true,
      aspect: "landscape",
      resolution: 1080,
      frameRate: 30,
      videoCompression: false,
      range: [1, 15],
    },
    portraitTeaser: {
      enabled: true,
      aspect: "portrait",
      resolution: 720,
      frameRate: 30,
      videoCompression: true,
      range: [2, 12],
    },
    thumbnail: { enabled: true, aspect: "square", resolution: 480, time: 7 },
  });
  assert.equal(await opened.tracks[0].file.text(), "raw-one");
  assert.equal(await opened.tracks[1].file.text(), "raw-two");
  assert.equal(await opened.tracks[0].artwork.text(), "cover-one");
  assert.equal(await opened.tracks[1].artwork.text(), "cover-two");
  assert.equal(await opened.logo.text(), "logo");
  assert.equal(await opened.background.text(), "bg");
  assert.deepEqual(
    opened.tracks.map((track) => track.range),
    [
      [2, 12],
      [5, 14],
    ],
  );
  const defaultRange = await readProjectFile(
    new File(
      [
        makeProjectFile({
          settings: DEFAULT_SETTINGS,
          media: first.file,
          logo: null,
          background: null,
          format: "landscape",
          range: first.range,
          subtitles: first.subtitles,
          tracks: [first, second],
        }),
      ],
      "default-range.pulseframe",
    ),
  );
  assert.deepEqual(defaultRange.globalExportRange, [0, 19]);
});

test("v3 project reader rejects duplicate IDs, unknown references, unsafe sizes and trailing payload", async () => {
  const modules = await modulesPromise;
  const { makeProjectFile, readProjectFile } = modules["project-file"];
  const { DEFAULT_SETTINGS } = modules["customizer-config"];
  const { createProjectTrack } = modules["project-model"];
  const track = createProjectTrack(mediaFile("one.wav", "payload"), 9, "one");
  const content = {
    settings: DEFAULT_SETTINGS,
    media: track.file,
    logo: null,
    background: null,
    format: "square",
    range: track.range,
    subtitles: [],
    tracks: [track],
  };
  const source = makeProjectFile(content);
  const readChanged = async (change, extra = []) =>
    readProjectFile(
      new File([await projectFileWithManifest(source, change, extra)], "broken.pulseframe"),
    );

  await assert.rejects(
    () => readChanged((manifest) => (manifest.tracks[0].mediaAssetId = "missing-media")),
    /missing or incompatible asset/,
  );
  await assert.rejects(
    () =>
      readChanged((manifest) => {
        manifest.tracks.push({ ...manifest.tracks[0] });
      }),
    /duplicate track IDs/,
  );
  await assert.rejects(
    () =>
      readChanged((manifest) => {
        manifest.assets.push({ ...manifest.assets[0] });
      }),
    /duplicate asset IDs/,
  );
  await assert.rejects(
    () => readChanged((manifest) => (manifest.assets[0].size = Number.MAX_SAFE_INTEGER + 1)),
    /unsupported version|invalid asset size|missing or damaged/,
  );
  await assert.rejects(
    () => readChanged(() => {}, [new Blob(["unexpected"])]),
    /missing or damaged/,
  );

  const duplicate = createProjectTrack(mediaFile("two.wav", "payload-two"), 9, "one");
  assert.throws(
    () => makeProjectFile({ ...content, tracks: [track, duplicate] }),
    /duplicate track IDs/,
  );
});

test("playlist timeline maps trims, hard-cut boundaries, clipped ranges and source-time captions", async () => {
  const modules = await modulesPromise;
  const { createProjectTrack } = modules["project-model"];
  const { buildPlaylistTimeline, resolveProjectTime, clipProjectRange, getProjectSubtitles } =
    modules["playlist-timeline"];
  const first = createProjectTrack(mediaFile("first.wav", "a"), 20, "first");
  first.range = [4, 10];
  first.subtitles = [
    { id: "before", start: 2, end: 5, text: "clipped at start" },
    { id: "after", start: 8, end: 12, text: "clipped at end" },
  ];
  const second = createProjectTrack(mediaFile("second.wav", "b"), 20, "second");
  second.range = [7, 12];
  second.subtitles = [{ id: "next", start: 8, end: 9, text: "next track" }];
  const timeline = buildPlaylistTimeline([first, second]);

  assert.equal(timeline.duration, 11);
  assert.deepEqual(
    [resolveProjectTime(timeline, 5).trackId, resolveProjectTime(timeline, 5).sourceTime],
    ["first", 9],
  );
  assert.deepEqual(
    [resolveProjectTime(timeline, 6).trackId, resolveProjectTime(timeline, 6).sourceTime],
    ["second", 7],
  );
  assert.deepEqual(
    [resolveProjectTime(timeline, 11).trackId, resolveProjectTime(timeline, 11).sourceTime],
    ["second", 12],
  );
  assert.deepEqual(
    clipProjectRange(timeline, [4, 9]).map((clip) => [
      clip.trackId,
      clip.projectRange,
      clip.sourceRange,
    ]),
    [
      ["first", [4, 6], [8, 10]],
      ["second", [6, 9], [7, 10]],
    ],
  );
  assert.deepEqual(
    getProjectSubtitles([first, second], [0.5, 8]).map(({ id, start, end }) => [id, start, end]),
    [
      ["first:before", 0.5, 1],
      ["first:after", 4, 6],
      ["second:next", 7, 8],
    ],
  );
});
