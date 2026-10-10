import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { ArtistProfileStore, ArtistProfileStoreError } = modules["artist-profile-store"];
const { artistProfileStyleFromSettings, applyArtistProfileStyle } = modules["artist-profile"];
const { compositionSchema } = modules.composition;
const { DEFAULT_SETTINGS } = modules["customizer-config"];
const { makeArtistProfileFile, readArtistProfileFile } = modules["artist-profile-file"];
const {
  suggestPalettesFromPixels,
  keyedPaletteResult,
  isPaletteResultCurrent,
  colorContrastRatio,
} = modules["image-palette"];

class MemoryDatabase {
  records = new Map();
  assets = new Map();
  failNextWrite = false;
  advanceRevisionAfterNextRead = null;

  async list() {
    return [...this.records.values()];
  }
  async get(id) {
    const record = this.records.get(id);
    if (!record) return null;
    const result = { record, assets: this.assets.get(id) ?? {} };
    if (this.advanceRevisionAfterNextRead !== null) {
      this.records.set(id, { ...record, revision: this.advanceRevisionAfterNextRead });
      this.advanceRevisionAfterNextRead = null;
    }
    return result;
  }
  async create(record, assets) {
    if (this.failNextWrite) this.failWrite();
    if (this.records.has(record.id)) throw new Error("duplicate");
    this.records.set(record.id, record);
    this.assets.set(record.id, assets);
  }
  async update(id, expectedRevision, record, assets) {
    const current = this.records.get(id);
    if (!current) throw new ArtistProfileStoreError("missing", "missing");
    if (current.revision !== expectedRevision)
      throw new ArtistProfileStoreError("conflict", "conflict");
    if (this.failNextWrite) this.failWrite();
    this.records.set(id, record);
    this.assets.set(id, assets);
  }
  async delete(id, expectedRevision) {
    const current = this.records.get(id);
    if (!current) throw new ArtistProfileStoreError("missing", "missing");
    if (current.revision !== expectedRevision)
      throw new ArtistProfileStoreError("conflict", "conflict");
    if (this.failNextWrite) this.failWrite();
    this.records.delete(id);
    this.assets.delete(id);
  }
  failWrite() {
    this.failNextWrite = false;
    const error = new Error("quota");
    error.name = "QuotaExceededError";
    throw error;
  }
}

function draft(overrides = {}) {
  return {
    name: "Night Atlas",
    defaultArtist: "Night Atlas",
    style: artistProfileStyleFromSettings(DEFAULT_SETTINGS),
    assets: {},
    ...overrides,
  };
}
function imageAsset(name, text = "logo bytes") {
  const blob = new Blob([text], { type: "image/png" });
  return { blob, name, type: "image/png", size: blob.size };
}

test("profiles persist only whitelisted brand fields and round-trip portable image bytes", async () => {
  const db = new MemoryDatabase();
  const store = new ArtistProfileStore(db);
  const saved = await store.create(
    randomUUID(),
    draft({ assets: { logo: imageAsset("mark.png") } }),
  );
  assert.equal(saved.revision, 1);
  assert.equal(saved.assets.logo.blob.size, 10);
  assert.equal("trackTitle" in saved.style, false);
  assert.equal("trackArtist" in saved.style, false);
  assert.equal("sensitivity" in saved.style, false);
  assert.equal(JSON.stringify(saved).includes("audio"), false);

  const file = makeArtistProfileFile({
    name: saved.name,
    defaultArtist: saved.defaultArtist,
    style: saved.style,
    assets: saved.assets,
  });
  const imported = await readArtistProfileFile(file);
  assert.equal(imported.name, saved.name);
  assert.equal(imported.defaultArtist, saved.defaultArtist);
  assert.equal(await imported.assets.logo.blob.text(), "logo bytes");
  assert.deepEqual(imported.style, saved.style);
});

test("song fields, audio-response fields and audio blobs are rejected before storage", async () => {
  const db = new MemoryDatabase();
  const store = new ArtistProfileStore(db);
  await assert.rejects(
    store.create(randomUUID(), { ...draft(), trackTitle: "A song" }),
    (error) => error instanceof ArtistProfileStoreError && error.code === "invalid",
  );
  await assert.rejects(
    store.create(
      randomUUID(),
      draft({ style: { ...artistProfileStyleFromSettings(DEFAULT_SETTINGS), sensitivity: 1.2 } }),
    ),
    (error) => error instanceof ArtistProfileStoreError && error.code === "invalid",
  );
  const audio = new Blob(["song"], { type: "audio/mpeg" });
  await assert.rejects(
    store.create(
      randomUUID(),
      draft({
        assets: { artwork: { blob: audio, name: "song.mp3", type: audio.type, size: audio.size } },
      }),
    ),
    (error) => error instanceof ArtistProfileStoreError && error.code === "invalid",
  );
  assert.equal(db.records.size, 0);
});

test("profile style reuses composition geometry and typography while preserving release copy and audio settings", () => {
  const current = {
    ...DEFAULT_SETTINGS,
    trackTitle: "Keep this title",
    trackArtist: "Keep this artist",
    sensitivity: 2.1,
    composition: compositionSchema.parse({
      layouts: { base: { artwork: { x: 0.2, y: 0.1, width: 0.4, height: 0.6 } } },
      promo: { text: "Release-specific copy", visible: true },
    }),
  };
  const profileStyle = artistProfileStyleFromSettings(current);
  assert.deepEqual(profileStyle.composition.canvas.layouts, current.composition.layouts);
  assert.equal("text" in profileStyle.composition.canvas.promo, false);
  assert.equal("visible" in profileStyle.composition.canvas.promo, false);

  const applied = applyArtistProfileStyle(DEFAULT_SETTINGS, profileStyle);
  assert.equal(applied.trackTitle, "");
  assert.equal(applied.trackArtist, "");
  assert.equal(applied.sensitivity, DEFAULT_SETTINGS.sensitivity);
  const reappliedToCurrent = applyArtistProfileStyle(current, profileStyle);
  assert.equal(reappliedToCurrent.trackTitle, "Keep this title");
  assert.equal(reappliedToCurrent.trackArtist, "Keep this artist");
  assert.equal(reappliedToCurrent.sensitivity, 2.1);
  assert.equal(reappliedToCurrent.composition.promo.text, "Release-specific copy");
  assert.equal(reappliedToCurrent.composition.promo.visible, true);
});

test("revision conflicts and quota failures leave the committed profile and image untouched", async () => {
  const db = new MemoryDatabase();
  const store = new ArtistProfileStore(db);
  const id = randomUUID();
  const original = await store.create(
    id,
    draft({ assets: { logo: imageAsset("first.png", "first") } }),
  );
  db.advanceRevisionAfterNextRead = 7;
  await assert.rejects(
    store.update(id, original.revision, draft({ name: "Concurrent tab edit" })),
    (error) => error instanceof ArtistProfileStoreError && error.code === "conflict",
  );
  const concurrent = await store.get(id);
  assert.equal(concurrent.revision, 7);
  assert.equal(await concurrent.assets.logo.blob.text(), "first");

  // A stale editor is rejected before attempting another write.
  const latest = await store.update(
    id,
    concurrent.revision,
    draft({ name: "Latest edit", assets: { logo: imageAsset("second.png", "second") } }),
  );
  assert.equal(latest.revision, 8);
  await assert.rejects(
    store.update(id, original.revision, draft({ name: "Stale edit" })),
    (error) => error instanceof ArtistProfileStoreError && error.code === "conflict",
  );
  const before = await store.get(id);
  db.failNextWrite = true;
  await assert.rejects(
    store.update(
      id,
      latest.revision,
      draft({ name: "Quota failure", assets: { logo: imageAsset("bad.png", "bad") } }),
    ),
    (error) => error instanceof ArtistProfileStoreError && error.code === "storage",
  );
  const after = await store.get(id);
  assert.equal(after.name, before.name);
  assert.equal(await after.assets.logo.blob.text(), "second");
});

test("delete checks the displayed revision and atomically removes the image bundle", async () => {
  const db = new MemoryDatabase();
  const store = new ArtistProfileStore(db);
  const first = await store.create(
    randomUUID(),
    draft({ assets: { artwork: imageAsset("cover.png") } }),
  );
  const latest = await store.update(
    first.id,
    first.revision,
    draft({ name: "Renamed profile", assets: first.assets }),
  );
  await assert.rejects(
    store.remove(first.id, first.revision),
    (error) => error instanceof ArtistProfileStoreError && error.code === "conflict",
  );
  assert.ok(await store.get(first.id));
  await store.remove(latest.id, latest.revision);
  assert.equal(await store.get(latest.id), null);
  assert.equal(db.assets.has(latest.id), false);
});

test("palette sampling is stable, ignores transparent pixels and rejects stale source results", () => {
  const pixels = new Uint8ClampedArray([
    5, 8, 14, 255, 5, 8, 14, 255, 222, 68, 133, 255, 70, 210, 238, 255, 255, 255, 255, 0,
  ]);
  const first = suggestPalettesFromPixels(pixels);
  const second = suggestPalettesFromPixels(pixels);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0 && first.length <= 3);
  assert.ok(colorContrastRatio(first[0].colors.infoColor, first[0].colors.background) >= 4.5);
  assert.deepEqual(suggestPalettesFromPixels(new Uint8ClampedArray([20, 30, 40, 0])), []);

  const keyed = keyedPaletteResult("cover-a", first[0]);
  assert.equal(isPaletteResultCurrent(keyed, "cover-a"), true);
  assert.equal(isPaletteResultCurrent(keyed, "cover-b"), false);
});
