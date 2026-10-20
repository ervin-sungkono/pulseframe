import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { PresetStore, PresetStoreError, PRESET_STORAGE_KEY } = modules["preset-store"];
const { presetStyle } = modules.presets;
const settings = presetStyle(modules["customizer-config"].DEFAULT_SETTINGS);
function fixture() {
  const values = new Map();
  let blocked = false;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (blocked) throw new Error("Quota exceeded");
      values.set(key, value);
    },
  };
  return {
    values,
    store: new PresetStore(() => storage),
    second: new PresetStore(() => storage),
    block: () => {
      blocked = true;
    },
  };
}
const input = (name, extra = {}) => ({ id: randomUUID(), name, settings, ...extra });

test("local presets survive store recreation; saves retry by stable ID without duplicating or overwriting", async () => {
  const { store, second, values } = fixture();
  const request = input("Neon lake", { pinned: true });
  const saved = await store.create(request);
  const retried = await second.create({ ...request, name: "Retry must not rename" });
  assert.deepEqual(retried, saved);
  assert.deepEqual(second.list(), [saved]);
  assert.equal(JSON.parse(values.get(PRESET_STORAGE_KEY)).schemaVersion, 1);
  assert.equal("trackTitle" in saved.settings, false);
});

test("name validation and invalid settings never overwrite previously saved looks", async () => {
  const { store, values } = fixture();
  await store.create(input("Valid"));
  const before = values.get(PRESET_STORAGE_KEY);
  await assert.rejects(
    store.create(input(" ".repeat(4))),
    (error) => error instanceof PresetStoreError && error.code === "invalid",
  );
  await assert.rejects(store.create(input("Bad settings", { settings: { mode: "invalid" } })));
  await assert.rejects(store.create({ ...input("Bad metadata"), pinned: "yes" }));
  assert.equal(values.get(PRESET_STORAGE_KEY), before);
});

test("revision conflicts retain the current record and metadata edits preserve its settings", async () => {
  const { store, second, values } = fixture();
  const saved = await store.create(input("Original"));
  const changed = await second.update(saved.id, {
    name: "Renamed",
    pinned: true,
    expectedRevision: saved.revision,
  });
  assert.deepEqual(changed.settings, saved.settings);
  assert.equal(changed.revision, 2);
  const before = values.get(PRESET_STORAGE_KEY);
  await assert.rejects(
    store.update(saved.id, { name: "Stale tab", expectedRevision: 1 }),
    (error) => error.code === "conflict",
  );
  assert.equal(values.get(PRESET_STORAGE_KEY), before);
  const updated = await store.update(saved.id, { name: undefined, expectedRevision: 2 });
  assert.equal(updated.name, "Renamed");
  assert.equal(store.list()[0].name, "Renamed");
});

test("reordering writes the pair together and rejects stale or unpinned pairs without a partial swap", async () => {
  const { store, second, values } = fixture();
  const a = await store.create(input("First", { pinned: true, quickLookOrder: 1 }));
  const b = await store.create(input("Second", { pinned: true, quickLookOrder: 2 }));
  const [moved, shifted] = await store.reorder(a, b);
  assert.equal(moved.quickLookOrder, 2);
  assert.equal(shifted.quickLookOrder, 1);
  const before = values.get(PRESET_STORAGE_KEY);
  await assert.rejects(second.reorder(a, b), (error) => error.code === "conflict");
  assert.equal(values.get(PRESET_STORAGE_KEY), before);
  const unpinned = await store.update(moved.id, {
    pinned: false,
    expectedRevision: moved.revision,
  });
  const beforeUnpinned = values.get(PRESET_STORAGE_KEY);
  await assert.rejects(store.reorder(unpinned, shifted), (error) => error.code === "conflict");
  assert.equal(values.get(PRESET_STORAGE_KEY), beforeUnpinned);
});

test("quota failure, blocked storage, malformed data and future schemas do not silently replace data", async () => {
  const f = fixture();
  const saved = await f.store.create(input("Keep me"));
  const before = f.values.get(PRESET_STORAGE_KEY);
  f.block();
  await assert.rejects(
    f.store.update(saved.id, { name: "Not saved", expectedRevision: 1 }),
    (error) => error.code === "storage",
  );
  assert.equal(f.values.get(PRESET_STORAGE_KEY), before);
  for (const raw of [
    "broken JSON",
    '{"schemaVersion":2,"presets":[]}',
    '{"schemaVersion":1,"presets":[{}]}',
  ]) {
    const fresh = fixture();
    fresh.values.set(PRESET_STORAGE_KEY, raw);
    assert.throws(
      () => fresh.store.list(),
      (error) => error.code === "storage",
    );
    await assert.rejects(
      fresh.store.create(input("Must not overwrite")),
      (error) => error.code === "storage",
    );
    assert.equal(fresh.values.get(PRESET_STORAGE_KEY), raw);
  }
  const blocked = new PresetStore(() => {
    throw new Error("SecurityError");
  });
  assert.throws(
    () => blocked.list(),
    (error) => error.code === "storage",
  );
});

test("same-origin concurrent saves retain both records and deletion is persistent", async () => {
  const { store, second } = fixture();
  await Promise.all([store.create(input("One")), second.create(input("Two"))]);
  assert.equal(store.list().length, 2);
  const first = store.list()[0];
  await second.remove(first.id);
  assert.equal(store.list().length, 1);
  assert.ok(store.list().every((preset) => preset.id !== first.id));
  await assert.rejects(store.remove(first.id), (error) => error.code === "missing");
});
