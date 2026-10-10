import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const {
  createExportDestination,
  pickExportDestination,
  pickExportDirectoryDestination,
  supportsDirectoryExport,
  supportsFileExport,
} = (await loadSources({ modules: ["export-destination"] }))["export-destination"];

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete globalThis.window;
});

function mockPhysicalWritable() {
  const writes = [];
  let closeCount = 0;
  let abortCount = 0;
  return {
    writes,
    get closeCount() {
      return closeCount;
    },
    get abortCount() {
      return abortCount;
    },
    handle: {
      async createWritable() {
        return {
          async write(chunk) {
            writes.push(chunk);
          },
          async close() {
            closeCount++;
          },
          async abort() {
            abortCount++;
          },
        };
      },
    },
  };
}

function mockDirectory() {
  const entries = new Map();
  const removed = [];
  const createEntry = (name, initial = { size: 0, lastModified: 1 }) => {
    const state = { ...initial };
    let pendingSize = state.size;
    const handle = {
      async createWritable() {
        pendingSize = state.size;
        return {
          async write(chunk) {
            pendingSize = Math.max(pendingSize, chunk.position + chunk.data.length);
          },
          async close() {
            state.size = pendingSize;
            state.lastModified++;
          },
          async abort() {},
        };
      },
      async getFile() {
        return { size: state.size, lastModified: state.lastModified };
      },
      async isSameEntry(other) {
        return other === handle;
      },
    };
    entries.set(name, { handle, state });
    return handle;
  };
  const directory = {
    async getFileHandle(name, options) {
      if (entries.has(name)) return entries.get(name).handle;
      if (!options?.create) throw new DOMException("Not found", "NotFoundError");
      return createEntry(name);
    },
    async removeEntry(name) {
      if (!entries.delete(name)) throw new DOMException("Not found", "NotFoundError");
      removed.push(name);
    },
  };
  return { directory, entries, removed, createEntry };
}

test("Mediabunny stream close does not commit the physical file; explicit commit does", async () => {
  const physical = mockPhysicalWritable();
  const destination = createExportDestination(physical.handle);
  const transaction = await destination.createWriter("mp4", "finished.mp4");
  const writer = transaction.stream.getWriter();
  const data = new Uint8Array([1, 2, 3]);
  await writer.write({ type: "write", data, position: 8 });
  await writer.close();

  assert.equal(physical.closeCount, 0, "Mediabunny closing its target is not a physical commit");
  assert.equal(physical.writes.length, 1);
  assert.equal(physical.writes[0].position, 8);
  assert.deepEqual([...physical.writes[0].data], [1, 2, 3]);

  await transaction.commit();
  assert.equal(physical.closeCount, 1);
  assert.equal(physical.abortCount, 0);
});

test("Mediabunny cancellation closes only its wrapper and the owner aborts the physical write", async () => {
  const physical = mockPhysicalWritable();
  const destination = createExportDestination(physical.handle);
  const transaction = await destination.createWriter("webm", "canceled.webm");
  const writer = transaction.stream.getWriter();
  await writer.write({ type: "write", data: new Uint8Array([9]), position: 0 });
  await writer.close();
  assert.equal(physical.closeCount, 0);

  await transaction.abort(new Error("canceled"));
  assert.equal(physical.closeCount, 0);
  assert.equal(physical.abortCount, 1);
  await transaction.abort();
  assert.equal(physical.abortCount, 1, "abort remains idempotent");
});

test("a PNG still accepts one positioned output chunk and commits only when asked", async () => {
  const physical = mockPhysicalWritable();
  const destination = createExportDestination(physical.handle);
  const transaction = await destination.createWriter("png", "cover.png");
  const writer = transaction.stream.getWriter();
  const pngBytes = new Uint8Array([137, 80, 78, 71]);
  await writer.write({ type: "write", data: pngBytes, position: 0 });
  await writer.close();
  assert.equal(physical.closeCount, 0);
  assert.equal(physical.writes[0].position, 0);
  assert.deepEqual([...physical.writes[0].data], [137, 80, 78, 71]);
  await transaction.commit();
  assert.equal(physical.closeCount, 1);
});

test("a failed physical close aborts the incomplete output", async () => {
  let abortCount = 0;
  const destination = createExportDestination({
    async createWritable() {
      return {
        async write() {},
        async close() {
          throw new Error("disk full");
        },
        async abort() {
          abortCount++;
        },
      };
    },
  });
  const transaction = await destination.createWriter("mp4", "broken.mp4");
  const writer = transaction.stream.getWriter();
  await writer.close();
  await assert.rejects(transaction.commit(), /could not be finalized/i);
  assert.equal(abortCount, 1);
  await transaction.abort();
  assert.equal(abortCount, 1, "failed commit still settles the transaction");
});

test("folder abort removes only an unchanged placeholder and allows a retry", async () => {
  const { directory, entries, removed, createEntry } = mockDirectory();
  createEntry("existing.png", { size: 12, lastModified: 7 });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { showDirectoryPicker: async () => directory },
  });
  assert.equal(supportsDirectoryExport(), true);
  const destination = await pickExportDirectoryDestination();
  assert.ok(destination);

  await assert.rejects(destination.createWriter("png", "existing"), /already exists/i);
  assert.equal(entries.has("existing.png"), true, "a pre-existing entry is preserved");
  assert.deepEqual(removed, []);

  const canceled = await destination.createWriter("png", "retry");
  assert.ok(canceled.stream instanceof WritableStream);
  await canceled.abort();
  assert.equal(entries.has("retry.png"), false, "aborting removes the unchanged placeholder");
  assert.deepEqual(removed, ["retry.png"]);

  const retry = await destination.createWriter("png", "retry");
  const retryWriter = retry.stream.getWriter();
  await retryWriter.write({ type: "write", data: new Uint8Array([1, 2]), position: 0 });
  await retryWriter.close();
  await retry.commit();
  await retry.abort();
  assert.equal(entries.has("retry.png"), true, "the retried completed file is preserved");

  const externallyChanged = await destination.createWriter("png", "external-change");
  const changedEntry = entries.get("external-change.png");
  changedEntry.state.size = 19;
  changedEntry.state.lastModified = 9;
  await externallyChanged.abort();
  assert.equal(entries.has("external-change.png"), true, "external changes are preserved");
  assert.deepEqual(removed, ["retry.png"]);
});

test("single-file picker cancellation is a normal null result", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      showSaveFilePicker: async () => {
        throw new DOMException("User canceled", "AbortError");
      },
    },
  });
  assert.equal(supportsFileExport(), true);
  assert.equal(await pickExportDestination("mp4", "preview"), null);
});
