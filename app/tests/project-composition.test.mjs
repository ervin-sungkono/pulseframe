import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { DEFAULT_SETTINGS } = modules["customizer-config"];
const { defaultComposition, newElement } = modules["composition/model"];
const { makeProjectFile, readProjectFile } = modules["project-file"];
const { CompositionAssetOwner, disposeStagedAssets } = modules["composition/assets"];

function baseContent(changes = {}) {
  return {
    format: "landscape",
    range: [0, 2],
    settings: structuredClone(DEFAULT_SETTINGS),
    subtitles: [],
    media: new File(["audio-bytes"], "song.wav", { type: "audio/wav" }),
    logo: null,
    background: null,
    ...changes,
  };
}

async function archiveManifest(file) {
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const size = new DataView(header.buffer).getUint32(4, true);
  return JSON.parse(await file.slice(8, 8 + size).text());
}

async function rewriteManifest(file, mutate) {
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const size = new DataView(header.buffer).getUint32(4, true);
  const manifest = JSON.parse(await file.slice(8, 8 + size).text());
  mutate(manifest);
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  new DataView(header.buffer).setUint32(4, bytes.length, true);
  const manifestEnd = 8 + size;
  return new File([header, bytes, file.slice(manifestEnd)], "corrupt.pulseframe");
}

function legacyArchive(version, content) {
  const manifest = {
    version,
    format: content.format,
    profile: "standard",
    range: content.range,
    settings: content.settings,
    subtitles: content.subtitles,
    media: { name: content.media.name, type: content.media.type, size: content.media.size },
    logo: content.logo
      ? { name: content.logo.name, type: content.logo.type, size: content.logo.size }
      : null,
    ...(version === 2
      ? {
          frameRate: 30,
          videoCompression: false,
          resolution: 720,
          background: content.background
            ? {
                name: content.background.name,
                type: content.background.type,
                size: content.background.size,
              }
            : null,
        }
      : {}),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(8);
  header.set(new TextEncoder().encode("PF01"));
  new DataView(header.buffer).setUint32(4, bytes.length, true);
  return new File(
    [
      header,
      bytes,
      content.media,
      ...(content.logo ? [content.logo] : []),
      ...(version === 2 && content.background ? [content.background] : []),
    ],
    `v${version}.pulseframe`,
  );
}

test("v1 and v2 projects gain the default composition and save forward as v3", async () => {
  const legacy = baseContent({
    logo: new File(["logo"], "logo.png", { type: "image/png" }),
    background: new File(["background"], "background.png", { type: "image/png" }),
    subtitles: [{ id: "cue", start: 0, end: 1, text: "untimed fallback" }],
  });
  for (const version of [1, 2]) {
    const original = await readProjectFile(legacyArchive(version, legacy));
    assert.deepEqual(original.composition, defaultComposition());
    assert.deepEqual(Object.keys(original.assets), []);
    assert.equal(original.logo.name, "logo.png");
    if (version === 2) assert.equal(original.background.name, "background.png");
    assert.equal(original.subtitles[0].words, undefined);

    const upgraded = makeProjectFile(original);
    assert.equal((await archiveManifest(upgraded)).version, 3);
    const reopened = await readProjectFile(new File([upgraded], "upgraded.pulseframe"));
    assert.deepEqual(reopened.composition, defaultComposition());
    assert.deepEqual(Object.keys(reopened.assets), []);
    assert.equal(reopened.media.name, "song.wav");
  }
});

test("v3 round-trips composition assets after legacy media, logo, and background blobs", async () => {
  const composition = defaultComposition();
  composition.elements = [newElement("image", "cover-art")];
  const content = baseContent({
    composition,
    assets: { "cover-art": new File(["image-bytes"], "cover.webp", { type: "image/webp" }) },
    logo: new File(["logo"], "logo.png", { type: "image/png" }),
    background: new File(["background"], "background.png", { type: "image/png" }),
    subtitles: [
      {
        id: "timed",
        start: 0,
        end: 1,
        text: "hi there",
        words: [
          { textStart: 0, textEnd: 2, start: 0.1, end: 0.4 },
          { textStart: 3, textEnd: 8, start: 0.4, end: 0.9 },
        ],
      },
      { id: "plain", start: 1, end: 2, text: "untimed" },
    ],
  });
  const archive = makeProjectFile(content);
  const reopened = await readProjectFile(new File([archive], "roundtrip.pulseframe"));
  assert.deepEqual(reopened.composition, composition);
  assert.equal(await reopened.assets["cover-art"].text(), "image-bytes");
  assert.equal(reopened.assets["cover-art"].name, "cover.webp");
  assert.equal(await reopened.media.text(), "audio-bytes");
  assert.equal(await reopened.logo.text(), "logo");
  assert.equal(await reopened.background.text(), "background");
  assert.deepEqual(reopened.subtitles[0].words, content.subtitles[0].words);
  assert.equal(reopened.subtitles[1].words, undefined);
});

test("v3 rejects duplicate, dangling, unmatched, and out-of-bounds asset metadata", async () => {
  const composition = defaultComposition();
  composition.elements = [newElement("image", "cover-art"), newElement("image", "stamp")];
  const content = baseContent({
    composition,
    assets: {
      "cover-art": new File(["cover"], "cover.png", { type: "image/png" }),
      stamp: new File(["stamp"], "stamp.png", { type: "image/png" }),
    },
  });
  const valid = makeProjectFile(content);
  await assert.rejects(
    readProjectFile(
      await rewriteManifest(valid, (manifest) => (manifest.assets[1].id = "cover-art")),
    ),
    /unsupported version/,
  );
  await assert.rejects(
    readProjectFile(
      await rewriteManifest(
        valid,
        (manifest) => (manifest.composition.elements[0].assetId = "missing"),
      ),
    ),
    /unsupported version/,
  );
  await assert.rejects(
    readProjectFile(await rewriteManifest(valid, (manifest) => (manifest.assets[0].size += 1))),
    /missing or damaged/,
  );
  await assert.rejects(
    readProjectFile(await rewriteManifest(valid, (manifest) => manifest.assets.pop())),
    /unsupported version/,
  );
});

test("project words are validated while ordinary untimed cues remain available", async () => {
  const content = baseContent({
    subtitles: [
      {
        id: "timed",
        start: 0,
        end: 1,
        text: "hello",
        words: [{ textStart: 0, textEnd: 5, start: 0.1, end: 0.9 }],
      },
      { id: "plain", start: 1, end: 2, text: "normal cue" },
    ],
  });
  const valid = makeProjectFile(content);
  const reopened = await readProjectFile(new File([valid], "words.pulseframe"));
  assert.equal(reopened.subtitles[0].words[0].textEnd, 5);
  assert.equal(reopened.subtitles[1].words, undefined);
  const invalid = await rewriteManifest(valid, (manifest) => {
    manifest.subtitles[0].words[0].textEnd = 99;
  });
  await assert.rejects(readProjectFile(invalid), /unsupported version/);
});

test("v3 project metadata accepts bounded subtitle text beyond the former manifest cap", async () => {
  const subtitles = Array.from({ length: 500 }, (_, index) => ({
    id: `cue-${index}`,
    start: 0,
    end: 1,
    text: "x".repeat(600),
  }));
  const archive = makeProjectFile(baseContent({ subtitles }));
  const manifest = await archiveManifest(archive);
  const header = new Uint8Array(await archive.slice(0, 8).arrayBuffer());
  assert.ok(new DataView(header.buffer).getUint32(4, true) > 256 * 1024);
  assert.equal(
    (await readProjectFile(new File([archive], "large-manifest.pulseframe"))).subtitles.length,
    500,
  );
  assert.equal(manifest.subtitles[0].text.length, 600);
});

test("project file wrappers preserve blob sizes without reading the complete media bytes", async () => {
  const media = new File([new Uint8Array(2 * 1024 * 1024)], "large.wav", { type: "audio/wav" });
  media.arrayBuffer = () => Promise.reject(new Error("full media read"));
  const archive = makeProjectFile(baseContent({ media }));
  const project = new File([archive], "blob-backed.pulseframe");
  project.arrayBuffer = () => Promise.reject(new Error("full project read"));
  const opened = await readProjectFile(project);
  assert.equal(opened.media.size, media.size);
});

function withImageStubs(run) {
  const originalImage = globalThis.Image;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked = [];
  let nextUrl = 0;
  class FakeImage {
    naturalWidth = FakeImage.width;
    naturalHeight = FakeImage.height;
    src = "";
    decode() {
      return FakeImage.decodePromise ?? Promise.resolve();
    }
  }
  FakeImage.width = 100;
  FakeImage.height = 100;
  URL.createObjectURL = () => `blob:asset-${++nextUrl}`;
  URL.revokeObjectURL = (url) => revoked.push(url);
  globalThis.Image = FakeImage;
  return Promise.resolve()
    .then(() => run({ FakeImage, revoked }))
    .finally(() => {
      globalThis.Image = originalImage;
      if (originalCreate === undefined) delete URL.createObjectURL;
      else URL.createObjectURL = originalCreate;
      if (originalRevoke === undefined) delete URL.revokeObjectURL;
      else URL.revokeObjectURL = originalRevoke;
    });
}

test("composition asset owner transfers, prunes, and releases decoded images", async () => {
  await withImageStubs(async ({ revoked }) => {
    const owner = new CompositionAssetOwner();
    const initial = await owner.prepare({
      first: new File(["first"], "first.png", { type: "image/png" }),
      second: new File(["second"], "second.png", { type: "image/png" }),
    });
    owner.commit(initial, true);
    assert.equal(initial.size, 0);
    const stableView = owner.images();
    assert.equal(owner.images(), stableView);
    assert.equal(owner.files().first.name, "first.png");

    owner.prune(new Set(["second"]));
    assert.notEqual(owner.images(), stableView);
    assert.deepEqual([...owner.images().keys()], ["second"]);
    assert.deepEqual(revoked, ["blob:asset-1"]);

    const replacement = await owner.prepare({
      second: new File(["next"], "next.png", { type: "image/png" }),
    });
    owner.commit(replacement);
    assert.equal(owner.files().second.name, "next.png");
    assert.deepEqual(revoked, ["blob:asset-1", "blob:asset-2"]);
    owner.dispose();
    assert.equal(owner.images().size, 0);
    assert.deepEqual(revoked, ["blob:asset-1", "blob:asset-2", "blob:asset-3"]);
  });
});

test("composition asset preparation disposes partial and canceled staging, and caps pixels", async () => {
  await withImageStubs(async ({ FakeImage, revoked }) => {
    const owner = new CompositionAssetOwner();
    await assert.rejects(
      owner.prepare({
        valid: new File(["valid"], "valid.png", { type: "image/png" }),
        invalid: new File(["bad"], "bad.gif", { type: "image/gif" }),
      }),
    );
    assert.deepEqual(revoked, ["blob:asset-1"]);

    let finishDecode;
    FakeImage.decodePromise = new Promise((resolve) => (finishDecode = resolve));
    const controller = new AbortController();
    const pending = owner.prepare(
      { pending: new File(["pending"], "pending.png", { type: "image/png" }) },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(revoked, ["blob:asset-1", "blob:asset-2"]);
    finishDecode();
    FakeImage.decodePromise = undefined;

    FakeImage.width = 4096;
    FakeImage.height = 4096;
    await assert.rejects(
      owner.prepare({
        one: new File(["1"], "1.png", { type: "image/png" }),
        two: new File(["2"], "2.png", { type: "image/png" }),
        three: new File(["3"], "3.png", { type: "image/png" }),
        four: new File(["4"], "4.png", { type: "image/png" }),
      }),
      /64 megapixel/,
    );
    assert.deepEqual(revoked.slice(2), [
      "blob:asset-3",
      "blob:asset-4",
      "blob:asset-5",
      "blob:asset-6",
    ]);

    const staged = new Map([["staged", { url: "blob:staged" }]]);
    disposeStagedAssets(staged);
    assert.deepEqual(revoked.at(-1), "blob:staged");
  });
});

test("composition asset commits preserve active ownership when a merged set exceeds the budget", async () => {
  await withImageStubs(async ({ FakeImage, revoked }) => {
    const owner = new CompositionAssetOwner();
    FakeImage.width = 4096;
    FakeImage.height = 4096;
    const original = await owner.prepare({
      first: new File(["1"], "1.png", { type: "image/png" }),
      second: new File(["2"], "2.png", { type: "image/png" }),
      third: new File(["3"], "3.png", { type: "image/png" }),
    });
    owner.commit(original, true);
    const oldView = owner.images();
    const staged = await owner.prepare({ next: new File(["4"], "4.png", { type: "image/png" }) });
    assert.throws(() => owner.commit(staged), /64 megapixel/);
    assert.equal(staged.size, 1);
    assert.equal(owner.images(), oldView);
    assert.deepEqual(Object.keys(owner.files()), ["first", "second", "third"]);
    disposeStagedAssets(staged);
    assert.equal(revoked.length, 1);

    const replacement = await owner.prepare({
      next: new File(["4"], "4.png", { type: "image/png" }),
    });
    owner.commit(replacement, true);
    assert.deepEqual(Object.keys(owner.files()), ["next"]);
    assert.deepEqual(revoked, ["blob:asset-4", "blob:asset-1", "blob:asset-2", "blob:asset-3"]);
    owner.dispose();
    assert.equal(revoked.at(-1), "blob:asset-5");
  });
});
