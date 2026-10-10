import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { suggestClips } = modules["clip-suggestions"];
const { ANALYSIS_FPS } = modules["audio-analysis-config"];

function prepared(duration, activeSpans = [], events = []) {
  const count = Math.ceil(duration * ANALYSIS_FPS);
  const envelopes = Array.from({ length: count }, (_, index) => {
    const time = index / ANALYSIS_FPS;
    const loud = activeSpans.some(([start, end]) => time >= start && time < end);
    return {
      rms: loud ? 0.6 : 0,
      rmsDb: loud ? -10 : -160,
      bassDb: loud ? -14 : -160,
      bassHitDb: loud ? -12 : -160,
      middleDb: loud ? -18 : -160,
      highDb: loud ? -22 : -160,
    };
  });
  return { audio: { duration }, envelopes, events, overview: [] };
}

test("clip windows stay inside the track, use requested lengths capped to short duration, and remain stable", () => {
  const sound = prepared(8, [[0, 8]]);
  const first = suggestClips(sound, 8, [15]);
  const second = suggestClips(sound, 8, [15]);
  assert.equal(first.suggestions.length, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.suggestions[0].range, [0, 8]);
  assert.equal(first.suggestions[0].length, 8);
  assert.equal(first.suggestions[0].requestedLength, 15);
});

test("energy windows produce distinct candidates and honest bass-return labels", () => {
  const sound = prepared(
    80,
    [
      [8, 25],
      [49, 72],
    ],
    [10, 52],
  );
  const result = suggestClips(sound, 80);
  assert.ok(result.suggestions.length >= 2);
  assert.ok(result.suggestions.length <= 3);
  for (const suggestion of result.suggestions) {
    assert.ok(suggestion.range[0] >= 0);
    assert.ok(suggestion.range[1] <= 80);
    assert.ok(suggestion.range[1] > suggestion.range[0]);
    assert.equal(suggestion.reason, "bass return");
  }
  assert.notDeepEqual(result.suggestions[0].range, result.suggestions[1].range);
});

test("equal-score windows break ties toward the earliest time", () => {
  const result = suggestClips(prepared(40, [[0, 40]]), 40, [15]);
  assert.equal(result.suggestions[0].range[0], 0);
});

test("silence, missing history, and stale incomplete history do not suggest ranges", () => {
  const silence = suggestClips(prepared(20), 20);
  assert.equal(silence.suggestions.length, 0);
  assert.match(silence.unavailableReason, /No clear high-energy/);

  const noHistory = suggestClips(
    { audio: { duration: 20 }, envelopes: [], events: [], overview: [] },
    20,
  );
  assert.equal(noHistory.suggestions.length, 0);
  assert.match(noHistory.unavailableReason, /prepared audio history/);

  const stale = prepared(20, [[0, 20]]);
  stale.envelopes.pop();
  const incomplete = suggestClips(stale, 20);
  assert.equal(incomplete.suggestions.length, 0);
  assert.match(incomplete.unavailableReason, /incomplete/);
});
