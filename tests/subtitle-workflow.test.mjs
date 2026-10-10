import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const {
  applySubtitleImport,
  exportSubtitles,
  isCurrentSubtitleImport,
  MAX_SUBTITLE_FILE_BYTES,
  offsetSubtitleCues,
  parseSrt,
  parseVtt,
  trimSubtitleCues,
} = modules["subtitle-file"];
const { activeSubtitle, hasSubtitleOverlap, SubtitleHistory, MAX_SUBTITLE_HISTORY } =
  modules.subtitles;

test("SRT import handles BOM, CRLF, identifiers, Unicode, multiline text, and stable time ties", () => {
  const imported = parseSrt(
    "\uFEFF2\r\n00:00:02,000 --> 00:00:03,000\r\n♪ café\r\n第二行\r\n\r\nfirst\r\n00:00:01,000 --> 00:00:02,000\r\nfirst line\r\n\r\nsecond\r\n00:00:01,000 --> 00:00:01,500\r\nsecond line",
  );
  assert.deepEqual(
    imported.cues.map((cue) => cue.id),
    ["first", "second", "2"],
  );
  assert.equal(imported.cues[2].text, "♪ café\n第二行");
  assert.equal(imported.warnings.length, 0);
});

test("plain WebVTT skips NOTE, keeps markup literal, and warns about unsupported presentation", () => {
  const imported = parseVtt(
    "WEBVTT\nKind: captions\n\nNOTE editorial note\nignored note text\n\nREGION\nid:west\nwidth:40%\n\nintro\n00:00:01.000 --> 00:00:04.000 position:20% align:start\n<b>Lyrics</b>\nsecond line\n\n00:02.000 --> 00:03.000\nplain",
  );
  assert.equal(imported.cues.length, 2);
  assert.equal(imported.cues[0].id, "intro");
  assert.equal(imported.cues[0].text, "<b>Lyrics</b>\nsecond line");
  assert.ok(imported.warnings.some((warning) => warning.includes("position")));
  assert.ok(imported.warnings.some((warning) => warning.includes("literal text")));
  assert.ok(imported.warnings.some((warning) => warning.includes("STYLE and REGION")));
});

test("selected-range sidecars clip intersecting cues and rebase them to zero", () => {
  const cues = [
    { id: "before", start: 1, end: 4, text: "starts before" },
    { id: "inside", start: 3, end: 7, text: "inside" },
    { id: "after", start: 7, end: 8, text: "ends at range boundary" },
  ];
  const srt = exportSubtitles(cues, "srt", [2, 7]);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:02,000\nstarts before/);
  assert.match(srt, /2\n00:00:01,000 --> 00:00:05,000\ninside/);
  assert.doesNotMatch(srt, /ends at range boundary/);
  const fullVtt = exportSubtitles(cues.slice(1, 2), "vtt");
  assert.match(fullVtt, /WEBVTT\n\ninside\n00:00:03\.000 --> 00:00:07\.000/);
});

test("import assigns unique local IDs, sorts stably, and rejects invalid changes atomically", () => {
  const current = [{ id: "keep", start: 0, end: 1, text: "existing" }];
  const imported = [
    { id: "keep", start: 2, end: 3, text: "tie one" },
    { id: "keep", start: 2, end: 2.5, text: "tie two" },
  ];
  const result = applySubtitleImport(current, imported, "append", 4);
  assert.equal(result.length, 3);
  assert.equal(new Set(result.map((cue) => cue.id)).size, 3);
  assert.deepEqual(
    result.slice(1).map((cue) => cue.text),
    ["tie one", "tie two"],
  );
  assert.throws(
    () =>
      applySubtitleImport(
        current,
        [{ id: "bad", start: 3, end: 5, text: "outside" }],
        "replace",
        4,
      ),
    /within the track/,
  );
  assert.deepEqual(current, [{ id: "keep", start: 0, end: 1, text: "existing" }]);
});

test("append enforces the combined 500-cue track budget", () => {
  const existing = [{ id: "existing", start: 0, end: 0.5, text: "old" }];
  const incoming = Array.from({ length: 500 }, (_, index) => ({
    id: `incoming-${index}`,
    start: 1 + index,
    end: 1.5 + index,
    text: "new",
  }));
  assert.throws(() => applySubtitleImport(existing, incoming, "append", 1000), /at most 500/);
  assert.equal(existing.length, 1);
});

test("subtitle file reads are stale after a track, duration, or import generation changes", () => {
  const firstFile = {};
  const secondFile = {};
  const ticket = { sourceFile: firstFile, trackDuration: 40, generation: 3 };
  assert.equal(isCurrentSubtitleImport(ticket, ticket), true);
  assert.equal(isCurrentSubtitleImport({ ...ticket, sourceFile: secondFile }, ticket), false);
  assert.equal(isCurrentSubtitleImport({ ...ticket, trackDuration: 41 }, ticket), false);
  assert.equal(isCurrentSubtitleImport({ ...ticket, generation: 4 }, ticket), false);
});

test("trim and bulk offset are explicit, bounded operations", () => {
  const cues = [
    { id: "cross", start: 8, end: 12, text: "clip end" },
    { id: "outside", start: 12, end: 13, text: "remove" },
  ];
  const trimmed = trimSubtitleCues(cues, 10);
  assert.equal(trimmed.removed, 1);
  assert.deepEqual(trimmed.cues, [{ id: "cross", start: 8, end: 10, text: "clip end" }]);
  assert.throws(() => offsetSubtitleCues(trimmed.cues, 1, 10), /within the track/);
  assert.deepEqual(offsetSubtitleCues([{ id: "a", start: 2, end: 3, text: "ok" }], -1, 10)[0], {
    id: "a",
    start: 1,
    end: 2,
    text: "ok",
  });
});

test("import limits reject oversized files, cue sets, and cue text", () => {
  assert.throws(() => parseSrt(new Uint8Array(MAX_SUBTITLE_FILE_BYTES + 1)), /2 MB or smaller/);
  const many = Array.from(
    { length: 501 },
    (_, index) => `${index + 1}\n00:00:00,000 --> 00:00:01,000\ntext`,
  ).join("\n\n");
  assert.throws(() => parseSrt(many), /at most 500 cues/);
  assert.throws(
    () => parseSrt(`1\n00:00:00,000 --> 00:00:02,000\n${"x".repeat(601)}`),
    /600-character limit/,
  );
});

test("overlap selection uses earliest start and half-open end boundaries", () => {
  const cues = [
    { id: "late", start: 2, end: 4, text: "later" },
    { id: "early", start: 1, end: 3, text: "earlier" },
    { id: "blank", start: 0, end: 3, text: "   " },
  ];
  assert.equal(activeSubtitle(cues, 2.5).id, "early");
  assert.equal(activeSubtitle(cues, 3).id, "late");
  assert.equal(activeSubtitle(cues, 4), undefined);
  assert.equal(
    hasSubtitleOverlap([
      { id: "long", start: 0, end: 10, text: "long" },
      { id: "nested", start: 1, end: 2, text: "nested" },
      { id: "third", start: 3, end: 4, text: "third" },
    ]),
    true,
  );
  assert.equal(
    hasSubtitleOverlap([
      { id: "one", start: 0, end: 1, text: "one" },
      { id: "two", start: 1, end: 2, text: "two" },
    ]),
    false,
  );
});

test("cue history groups text edits and undo restores a bulk offset", () => {
  const original = [{ id: "line", start: 2, end: 4, text: "before" }];
  const history = new SubtitleHistory(original);
  history.commit([{ ...original[0], text: "draft" }], "line");
  const finished = [{ ...original[0], text: "finished" }];
  history.commit(finished, "line");
  assert.equal(history.canUndo, true);
  assert.deepEqual(history.undo(), original);
  assert.deepEqual(history.redo(), finished);
  history.endGroup();
  const shifted = offsetSubtitleCues(finished, 1, 10);
  history.commit(shifted);
  assert.deepEqual(history.undo(), finished);
  assert.deepEqual(history.redo(), shifted);
});

test("cue history caps snapshots and supports redo", () => {
  const history = new SubtitleHistory([]);
  for (let index = 0; index < MAX_SUBTITLE_HISTORY + 5; index += 1)
    history.commit([{ id: String(index), start: index, end: index + 1, text: String(index) }]);
  let undos = 0;
  while (history.undo()) undos += 1;
  assert.equal(undos, MAX_SUBTITLE_HISTORY);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);
  assert.ok(history.redo());
});
