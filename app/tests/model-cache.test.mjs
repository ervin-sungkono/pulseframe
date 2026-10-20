import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import ts from "typescript";

async function loadModelCache() {
  const directory = mkdtempSync(join(tmpdir(), "pulseframe-model-cache-test-"));
  try {
    const source = readFileSync(new URL("../lib/lyrics/model-cache.ts", import.meta.url), "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const path = join(directory, "model-cache.mjs");
    writeFileSync(path, output);
    return await import(pathToFileURL(path).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const { loadVerifiedModel } = await loadModelCache();

function stalledCacheDependencies(artifact) {
  const state = { reads: 0, cancelCalls: 0, cancelReason: undefined, releaseCalls: 0 };
  const response = {
    headers: {
      get: (name) => (name.toLowerCase() === "content-length" ? String(artifact.bytes) : null),
    },
    body: {
      getReader() {
        return {
          read() {
            state.reads += 1;
            return new Promise(() => {});
          },
          cancel(reason) {
            state.cancelCalls += 1;
            state.cancelReason = reason;
            return new Promise(() => {});
          },
          releaseLock() {
            state.releaseCalls += 1;
          },
        };
      },
    },
  };
  const cache = {
    async match() {
      return response;
    },
    async delete() {
      throw new Error("An aborted cache read must not become a cache miss.");
    },
  };
  return {
    state,
    dependencies: {
      cacheStorage: {
        async open() {
          return cache;
        },
      },
      fetcher: async () => {
        throw new Error("An aborted cache read must not fall through to network fetch.");
      },
      subtle: {
        async digest() {
          throw new Error("A stalled body cannot be validated.");
        },
      },
      origin: "https://pulseframe.test",
    },
  };
}

async function settleWithin(promise, timeoutMs = 2_000) {
  let timeout;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

const artifact = {
  url: "https://models.test/model.onnx",
  revision: "test-revision",
  bytes: 16,
  sha256: "0".repeat(64),
};

async function createArtifact(bytes) {
  const digest = await webcrypto.subtle.digest("SHA-256", bytes);
  return {
    url: "https://models.test/model.onnx",
    revision: "test-revision",
    bytes: bytes.byteLength,
    sha256: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
      "",
    ),
  };
}

function cachedResponse(bytes) {
  return new Response(bytes, {
    headers: { "content-length": String(bytes.byteLength) },
  });
}

test("a verified cached model is returned without a network fetch", async () => {
  const expectedBytes = Uint8Array.from([1, 4, 9, 16, 25, 36, 49, 64]);
  const pinnedArtifact = await createArtifact(expectedBytes);
  let fetchCalls = 0;
  const cache = {
    async match() {
      return cachedResponse(expectedBytes);
    },
  };
  const bytes = await loadVerifiedModel(pinnedArtifact, new AbortController().signal, {
    cacheStorage: {
      async open() {
        return cache;
      },
    },
    fetcher: async () => {
      fetchCalls += 1;
      throw new Error("A valid cached artifact should not be fetched again.");
    },
    subtle: webcrypto.subtle,
    origin: "https://pulseframe.test",
  });

  assert.deepEqual(bytes, expectedBytes);
  assert.equal(fetchCalls, 0);
});

test("a corrupt cached model is deleted and replaced by pinned network bytes", async () => {
  const expectedBytes = Uint8Array.from([2, 3, 5, 7, 11, 13, 17, 19]);
  const corruptBytes = expectedBytes.slice();
  corruptBytes[0] ^= 0xff;
  const pinnedArtifact = await createArtifact(expectedBytes);
  let deleteCalls = 0;
  let fetchCalls = 0;
  const cache = {
    async match() {
      return cachedResponse(corruptBytes);
    },
    async delete() {
      deleteCalls += 1;
      return true;
    },
  };
  const bytes = await loadVerifiedModel(pinnedArtifact, new AbortController().signal, {
    cacheStorage: {
      async open() {
        return cache;
      },
    },
    fetcher: async () => {
      fetchCalls += 1;
      return cachedResponse(expectedBytes);
    },
    subtle: webcrypto.subtle,
    origin: "https://pulseframe.test",
  });

  assert.deepEqual(bytes, expectedBytes);
  assert.equal(deleteCalls, 1);
  assert.equal(fetchCalls, 1);
});

test("parent abort settles a stalled cached model read and requests reader cancellation", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Canceled by test", "AbortError");
  const { dependencies, state } = stalledCacheDependencies(artifact);
  const pending = loadVerifiedModel(artifact, controller.signal, {
    ...dependencies,
    timeoutMs: 1_000,
  });

  while (state.reads === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(reason);
  const settled = await settleWithin(pending);

  assert.equal(settled.timedOut, undefined);
  assert.equal(settled.error, reason);
  assert.equal(state.cancelCalls, 1);
  assert.equal(state.cancelReason, reason);
  assert.equal(state.releaseCalls, 1);
});

test("model download timeout settles a stalled cached read without waiting for reader.cancel", async () => {
  const controller = new AbortController();
  const { dependencies, state } = stalledCacheDependencies(artifact);
  const pending = loadVerifiedModel(artifact, controller.signal, {
    ...dependencies,
    timeoutMs: 20,
  });
  const settled = await settleWithin(pending);

  assert.equal(settled.timedOut, undefined);
  assert.equal(settled.error?.name, "TimeoutError");
  assert.match(settled.error?.message ?? "", /timed out after 20 ms/u);
  assert.equal(state.reads, 1);
  assert.equal(state.cancelCalls, 1);
  assert.equal(state.cancelReason, settled.error);
  assert.equal(state.releaseCalls, 1);
});
