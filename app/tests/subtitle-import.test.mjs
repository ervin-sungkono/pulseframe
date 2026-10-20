import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = mkdtempSync(join(tmpdir(), "pulseframe-subtitle-import-"));
for (const name of ["subtitles/model", "subtitles/import", "lyrics/cues"]) {
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const target = join(dir, `${name}.mjs`);
  mkdirSync(dirname(target), { recursive: true });
  const output = ts
    .transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace(
      /(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g,
      (_, prefix, path, suffix) => `${prefix}${path.replace(/\.js$/, "")}.mjs${suffix}`,
    );
  writeFileSync(target, output);
}
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const { parseSubtitleImport: parse, MAX_SUBTITLE_IMPORT_BYTES } = await import(
  pathToFileURL(join(dir, "subtitles/import.mjs")).href
);

test("SRT preserves multiline Unicode, overlap, stable ties and decodes caption markup", () => {
  const result = parse(
    "\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\n<i>こんにちは</i> &amp; hello\r\nsecond line\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,000\r\noverlap\r\n\r\n3\r\n00:00:02,000 --> 00:00:04,000\r\nsame start",
    "song.SRT",
    10,
  );
  assert.deepEqual(result.cues, [
    { start: 1, end: 3, text: "こんにちは & hello\nsecond line" },
    { start: 2, end: 4, text: "overlap" },
    { start: 2, end: 4, text: "same start" },
  ]);
});

test("VTT handles identifiers, settings, comments, styles and word timestamps", () => {
  const result = parse(
    "WEBVTT\nKind: captions\n\nNOTE ignored\ncomment\n\nSTYLE\n::cue {color: red;}\n\nREGION\nid:r\n\nverse\n00:01.000 --> 00:03.000 align:start\n<v Singer><c.green>Hello</c> <00:02.000>world &lt;3 &#x1F3B5;\n",
    "song.vtt",
    10,
  );
  assert.deepEqual(result.cues, [{ start: 1, end: 3, text: "Hello world <3 🎵" }]);
});

test("LRC supports repeated timestamps, metadata, offsets and blank end markers", () => {
  const result = parse(
    "[ar:Singer]\n[tool:Editor]\n[offset:500]\n[00:01.00][00:05.00]hello\n[00:03.00]world\n[00:06.00]\n[00:12.00]outside",
    "song.lrc",
    10,
  );
  assert.deepEqual(result.cues, [
    { start: 0.5, end: 2.5, text: "hello" },
    { start: 2.5, end: 4.5, text: "world" },
    { start: 4.5, end: 5.5, text: "hello" },
  ]);
  assert.ok(result.notices.some((value) => value.includes("skipped")));
});

test("JSON accepts Pulseframe millisecond exports and canonical second-based cue arrays", () => {
  const expected = [{ start: 1, end: 3, text: "Hello" }];
  assert.deepEqual(
    parse(
      JSON.stringify({
        version: 1,
        generated: true,
        cues: [{ startMs: 1000, endMs: 3000, text: "Hello" }],
      }),
      "song.json",
      10,
    ).cues,
    expected,
  );
  assert.deepEqual(
    parse(
      JSON.stringify([{ id: "untrusted-id", start: 1, end: 3, text: "Hello" }]),
      "song.json",
      10,
    ).cues,
    expected,
  );
  assert.throws(
    () => parse('[{"start":1,"end":3,"startMs":1000,"text":"x"}]', "song.json", 10),
    /not both/,
  );
});

test("Import clips EOF, skips outside rows and respects editor limits without truncating text", () => {
  const result = parse(
    '[{"start":-1,"end":3,"text":"first"},{"start":8,"end":12,"text":"last"},{"start":15,"end":17,"text":"outside"}]',
    "song.json",
    10,
  );
  assert.deepEqual(result.cues, [
    { start: 0, end: 3, text: "first" },
    { start: 8, end: 10, text: "last" },
  ]);
  assert.equal(result.notices.length, 2);
  assert.throws(
    () =>
      parse(
        JSON.stringify(Array.from({ length: 501 }, () => ({ start: 1, end: 3, text: "x" }))),
        "song.json",
        10,
      ),
    /500-block/,
  );
  assert.throws(
    () => parse(JSON.stringify([{ start: 1, end: 3, text: "x".repeat(601) }]), "song.json", 10),
    /600-character/,
  );
  assert.throws(() => parse("x".repeat(MAX_SUBTITLE_IMPORT_BYTES + 1), "song.srt", 10), /2 MB/);
});

test("Invalid and untimed files fail instead of guessing timestamps or yielding empty replacements", () => {
  for (const [text, name] of [
    ["", "x.srt"],
    ["lyrics without timestamps", "x.lrc"],
    ["plain lyrics", "x.txt"],
    ["not JSON", "x.json"],
    ["WEBVTT\n\n00:61.000 --> 00:62.000\nx", "x.vtt"],
    ["1\n00:00:03,000 --> 00:00:01,000\nx", "x.srt"],
    ["[]", "x.json"],
    ['[{"start":"1","end":3,"text":"x"}]', "x.json"],
    ["1\nmissing times\nx", "x.srt"],
  ])
    assert.throws(() => parse(text, name, 10));
  assert.throws(() => parse("[00:01]x", "x.lrc", 0), /Load a track/);
});

test("All existing Pulseframe subtitle downloads can be imported again", async () => {
  const { serializeGeneratedSubtitles } = await import(
    pathToFileURL(join(dir, "lyrics/cues.mjs")).href
  );
  const source = [
    { startMs: 1000, endMs: 2000, text: "Hello & world" },
    { startMs: 3000, endMs: 4000, text: "Again" },
  ];
  for (const format of ["srt", "vtt", "lrc", "json"]) {
    const result = parse(
      serializeGeneratedSubtitles(source, 10000, format),
      `export.${format}`,
      10,
    );
    assert.deepEqual(
      result.cues.map(({ start, text }) => ({ start, text })),
      [
        { start: 1, text: "Hello & world" },
        { start: 3, text: "Again" },
      ],
    );
    if (format !== "lrc")
      assert.deepEqual(
        result.cues.map((cue) => cue.end),
        [2, 4],
      );
  }
  assert.throws(() => parse("[offset:not-a-number]\n[00:01]text", "bad.lrc", 10), /offset/);
});
