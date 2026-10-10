import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources({
  modules: [
    "audio-analysis-config",
    "audio-normalize",
    "export-settings",
    "export-timeline",
    "project-model",
    "playlist-timeline",
    "export-preflight",
  ],
});
const {
  assertBlobFallbackWithinBudget,
  estimateBlobFallbackBytes,
  EXPORT_BLOB_FALLBACK_BUDGET_BYTES,
} = modules["export-preflight"];

test("small Blob fallback workloads stay below the output budget", () => {
  const request = {
    durationSeconds: 30,
    width: 1280,
    height: 720,
    frameRate: 30,
    audioIncluded: true,
  };
  const estimate = estimateBlobFallbackBytes(request);
  assert.ok(estimate > 0);
  assert.ok(estimate < EXPORT_BLOB_FALLBACK_BUDGET_BYTES);
  assert.equal(assertBlobFallbackWithinBudget(request), estimate);
});

test("large in-memory exports fail with guidance to use Save to file", () => {
  assert.throws(
    () =>
      assertBlobFallbackWithinBudget({
        durationSeconds: 180,
        width: 1920,
        height: 1080,
        frameRate: 30,
        audioIncluded: true,
      }),
    /estimated .* MiB; limit 300 MiB.*Save to file/i,
  );
});

test("compressed quality lowers the fallback estimate without changing the hard budget", () => {
  const base = {
    durationSeconds: 90,
    width: 1920,
    height: 1080,
    frameRate: 30,
    audioIncluded: true,
  };
  const high = estimateBlobFallbackBytes(base);
  const compressed = estimateBlobFallbackBytes({ ...base, videoCompression: true });
  assert.ok(compressed < high);
  assert.equal(EXPORT_BLOB_FALLBACK_BUDGET_BYTES, 300 * 1024 * 1024);
});
