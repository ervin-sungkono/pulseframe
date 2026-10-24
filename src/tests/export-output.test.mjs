import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { EXPORT_RESOLUTIONS, exportDimensions, isSupportedExportDimensions } =
  modules["export-settings"];
const { createExportFileTarget } = modules["export-file-target"];
const {
  DESKTOP_BUFFERED_EXPORT_LIMIT_BYTES,
  MOBILE_BUFFERED_EXPORT_LIMIT_BYTES,
  bufferedExportLimitBytes,
  createEncodedPacketBudget,
} = modules["export-memory-budget"];
const { clearExportCapabilityCache, getCachedExportCapabilities, probeExportCapabilities } =
  modules["export-codec-capabilities"];

test("resolution presets include bounded 4K landscape, portrait, and square canvases", () => {
  assert.deepEqual(EXPORT_RESOLUTIONS, [480, 720, 1080, 1440, 2160]);
  assert.deepEqual(exportDimensions("landscape", 2160), {
    width: 3840,
    height: 2160,
    label: "16:9",
  });
  assert.deepEqual(exportDimensions("portrait", 2160), {
    width: 2160,
    height: 3840,
    label: "9:16",
  });
  assert.deepEqual(exportDimensions("square", 2160), {
    width: 2160,
    height: 2160,
    label: "1:1",
  });
  assert.equal(isSupportedExportDimensions(3840, 2160), true);
  assert.equal(isSupportedExportDimensions(2160, 3840), true);
  assert.equal(isSupportedExportDimensions(2160, 2160), true);
  assert.equal(isSupportedExportDimensions(4096, 2160), false);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function finalizeTarget(fileTarget) {
  fileTarget.target._start();
  fileTarget.target._write(new Uint8Array([1, 2]), 0);
  await fileTarget.target._flush();
  await fileTarget.target._finalize();
}

test("file target preserves positioned writes, honors backpressure, and defers commit", async () => {
  const writes = [];
  const events = [];
  const gate = deferred();
  const firstWriteStarted = deferred();
  const destination = {
    async createWritable() {
      return {
        write(chunk) {
          writes.push({ position: chunk.position, data: [...chunk.data] });
          events.push("write");
          if (writes.length === 1) {
            firstWriteStarted.resolve();
            return gate.promise;
          }
        },
        async close() {
          events.push("commit");
        },
        async abort() {
          events.push("abort");
        },
      };
    },
  };
  const fileTarget = await createExportFileTarget(destination);
  fileTarget.target._start();
  fileTarget.target._write(new Uint8Array([1, 2]), 0);
  await fileTarget.target._flush();
  await firstWriteStarted.promise;

  fileTarget.target._write(new Uint8Array([11, 12]), 10);
  const blockedFlush = fileTarget.target._flush();
  let secondFlushSettled = false;
  void blockedFlush.then(() => {
    secondFlushSettled = true;
  });
  await Promise.resolve();
  assert.equal(
    secondFlushSettled,
    false,
    "the stream waits for the first write before queueing more",
  );
  gate.resolve();
  await blockedFlush;
  fileTarget.target._write(new Uint8Array([3, 4]), 0);
  await fileTarget.target._flush();
  await fileTarget.target._finalize();

  assert.deepEqual(
    writes.map(({ position }) => position),
    [0, 2, 0],
    "the target preserves byte offsets for appended data and header rewrites",
  );
  assert.deepEqual(writes[1].data, [...new Array(8).fill(0), 11, 12]);
  assert.deepEqual(writes[2].data, [3, 4]);
  assert.deepEqual(
    events,
    ["write", "write", "write"],
    "Mediabunny close does not commit the file",
  );
  assert.equal(fileTarget.commitStarted, false);
  await fileTarget.commit(() => events.push("commit-start"));
  assert.deepEqual(events, ["write", "write", "write", "commit-start", "commit"]);
  assert.equal(fileTarget.commitStarted, true);
});

test("canceling a file transaction aborts its staging writer without committing", async () => {
  const events = [];
  const destination = {
    async createWritable() {
      return {
        async write() {},
        async close() {
          events.push("commit");
        },
        async abort() {
          events.push("abort");
        },
      };
    },
  };
  const fileTarget = await createExportFileTarget(destination);
  fileTarget.target._start();
  fileTarget.target._write(new Uint8Array([1]), 0);
  await fileTarget.target._flush();
  await fileTarget.target._close();
  await fileTarget.abort(new Error("canceled"));
  assert.deepEqual(events, ["abort"]);
  assert.equal(fileTarget.commitStarted, false);
});

test("a late cancel cannot abort a file once commit has started", async () => {
  const events = [];
  const closeGate = deferred();
  const destination = {
    async createWritable() {
      return {
        async write() {},
        async close() {
          events.push("commit-started");
          await closeGate.promise;
          events.push("commit-finished");
        },
        async abort() {
          events.push("abort");
        },
      };
    },
  };
  const fileTarget = await createExportFileTarget(destination);
  await finalizeTarget(fileTarget);
  const commit = fileTarget.commit();
  await Promise.resolve();
  await fileTarget.abort(new Error("late cancellation"));
  assert.deepEqual(events, ["commit-started"]);
  closeGate.resolve();
  await commit;
  assert.deepEqual(events, ["commit-started", "commit-finished"]);
});

test("buffered output is capped by encoded packet bytes with an actionable next step", () => {
  assert.equal(bufferedExportLimitBytes(false), DESKTOP_BUFFERED_EXPORT_LIMIT_BYTES);
  assert.equal(bufferedExportLimitBytes(true), MOBILE_BUFFERED_EXPORT_LIMIT_BYTES);
  const budget = createEncodedPacketBudget(10);
  budget.onPacket({ byteLength: 6 });
  budget.onPacket({ byteLength: 4 });
  assert.equal(budget.bytes, 10);
  budget.throwIfExceeded();
  budget.onPacket({ byteLength: 1 });
  assert.equal(budget.exceeded, true);
  assert.throws(budget.throwIfExceeded, /Save to file.*shorten the selected section/);
});

test("codec preflight exposes the cached extension for exact output settings", async () => {
  clearExportCapabilityCache();
  const request = {
    width: 3840,
    height: 2160,
    frameRate: 30,
    videoCompression: false,
    audio: { numberOfChannels: 2, sampleRate: 48000 },
  };
  assert.equal(getCachedExportCapabilities(request), null);
  const result = await probeExportCapabilities(request);
  assert.deepEqual(getCachedExportCapabilities(request), result);
  assert.deepEqual(await probeExportCapabilities(request), result);
});
