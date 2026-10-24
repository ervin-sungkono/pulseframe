import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./load-source.mjs";

const { PreviewQuality } = (await loadSources())["preview-quality"];

test("preview quality responds to sustained load and recovers with hysteresis", () => {
  const quality = new PreviewQuality();
  const budget = 1000 / 60;
  for (let time = 100; time < 2000; time += budget) quality.observe(20, time, budget);
  assert.equal(quality.scale, 1, "a brief overload does not resize the canvas");
  for (let time = 2000; time < 7000; time += budget) quality.observe(20, time, budget);
  assert.equal(quality.scale, 0.6, "sustained load reaches the bounded minimum");
  for (let time = 7000; time < 10000; time += budget) quality.observe(1, time, budget);
  assert.equal(quality.scale, 0.6, "recovery waits for sustained spare capacity");
  for (let time = 10000; time < 28000; time += budget) quality.observe(1, time, budget);
  assert.equal(quality.scale, 1);
});

test("invalid measurements cannot change preview quality", () => {
  const quality = new PreviewQuality();
  for (const [cost, now, budget] of [
    [NaN, 4000, 16],
    [20, NaN, 16],
    [-1, 4000, 16],
    [20, 4000, Infinity],
    [20, 4000, 0],
  ]) {
    assert.equal(quality.observe(cost, now, budget), false);
  }
  assert.equal(quality.scale, 1);
});
