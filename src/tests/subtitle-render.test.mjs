import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = mkdtempSync(join(tmpdir(), "pulseframe-subtitle-render-"));
for (const name of ["subtitles/model", "subtitles/render"]) {
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
const { drawAnimatedSubtitles } = await import(
  pathToFileURL(join(dir, "subtitles/render.mjs")).href
);

class RecordingContext {
  font = "10px sans-serif";
  fillStyle = "#ffffff";
  shadowColor = "transparent";
  shadowBlur = 0;
  textAlign = "left";
  textBaseline = "alphabetic";
  globalAlpha = 1;
  measureCalls = 0;
  text = [];
  rectangles = [];
  scales = [];
  stack = [];

  save() {
    this.stack.push({
      font: this.font,
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    });
  }

  restore() {
    const state = this.stack.pop();
    if (state) Object.assign(this, state);
  }

  beginPath() {}
  clip() {}
  fill() {}
  roundRect() {}
  translate() {}

  scale(x, y) {
    this.scales.push([x, y]);
  }

  rect(x, y, width, height) {
    this.rectangles.push({ x, y, width, height, fillStyle: this.fillStyle });
  }

  measureText(value) {
    this.measureCalls += 1;
    const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 10);
    return { width: Array.from(value).length * size * 0.5 };
  }

  fillText(value, x, y) {
    this.text.push({ value, x, y, fillStyle: this.fillStyle, alpha: this.globalAlpha });
  }
}

const defaultStyle = {
  animation: "static",
  color: "#ffffff",
  highlightColor: "#b9a2ff",
  fontSize: 0.046,
  position: 0.945,
  background: false,
};

test("word karaoke highlights source-time spans across Unicode text", () => {
  const ctx = new RecordingContext();
  const cue = {
    id: "lyrics",
    start: 0,
    end: 2,
    text: "A 🌙!",
    words: [
      { textStart: 0, textEnd: 1, start: 0, end: 0.5 },
      { textStart: 2, textEnd: 4, start: 0.5, end: 1.5 },
    ],
  };
  drawAnimatedSubtitles(ctx, 800, 600, [cue], 1, { ...defaultStyle, animation: "karaoke" }, false);
  assert.equal(ctx.text[0].value, "A 🌙!");
  assert.equal(ctx.rectangles.length, 2);
  assert.ok(Math.abs(ctx.rectangles[0].width - ctx.rectangles[1].width * 2) < 0.01);
  assert.ok(ctx.text.slice(1).every((entry) => entry.fillStyle === "#b9a2ff"));
});

test("cue-only karaoke falls back to cue progress and reduced motion stays static", () => {
  const cue = { id: "plain", start: 0, end: 2, text: "hello" };
  const animated = new RecordingContext();
  drawAnimatedSubtitles(
    animated,
    300,
    200,
    [cue],
    1,
    { ...defaultStyle, animation: "karaoke" },
    false,
  );
  const [sweep] = animated.rectangles;
  assert.ok(sweep);
  assert.ok(Math.abs(sweep.width - Array.from("hello").length * 9.2 * 0.25) < 0.01);

  const reduced = new RecordingContext();
  drawAnimatedSubtitles(
    reduced,
    300,
    200,
    [{ ...cue, words: [{ textStart: 0, textEnd: 5, start: 0, end: 2 }] }],
    1,
    { ...defaultStyle, animation: "karaoke" },
    true,
  );
  assert.equal(reduced.rectangles.length, 0);
  assert.deepEqual(
    reduced.text.map((entry) => entry.fillStyle),
    ["#ffffff"],
  );
});

test("overlapping active cues keep earliest-first stack order and cache text layout", () => {
  const ctx = new RecordingContext();
  const cues = [
    { id: "early", start: 0, end: 3, text: "first line" },
    { id: "late", start: 1, end: 3, text: "second line" },
  ];
  drawAnimatedSubtitles(ctx, 800, 600, cues, 1.5, defaultStyle, false);
  assert.deepEqual(
    ctx.text.map((entry) => entry.value),
    ["first line", "second line"],
  );
  const measured = ctx.measureCalls;
  drawAnimatedSubtitles(ctx, 800, 600, cues, 2, defaultStyle, false);
  assert.equal(ctx.measureCalls, measured);
});

test("fade and pop derive their frame state from absolute cue progress", () => {
  const cue = { id: "animated", start: 0, end: 2, text: "hello" };
  const fade = new RecordingContext();
  drawAnimatedSubtitles(
    fade,
    300,
    200,
    [cue],
    0.175,
    { ...defaultStyle, animation: "fade" },
    false,
  );
  assert.ok(Math.abs(fade.text[0].alpha - 0.5) < 0.001);

  const pop = new RecordingContext();
  drawAnimatedSubtitles(pop, 300, 200, [cue], 0.1, { ...defaultStyle, animation: "pop" }, false);
  const firstScale = pop.scales.at(-1)[0];
  drawAnimatedSubtitles(pop, 300, 200, [cue], 0.1, { ...defaultStyle, animation: "pop" }, false);
  assert.equal(pop.scales.at(-1)[0], firstScale);
  assert.ok(firstScale > 0.88 && firstScale < 1);
});
