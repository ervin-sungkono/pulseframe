import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = mkdtempSync(join(tmpdir(), "pulseframe-whisper-languages-"));
const require = createRequire(import.meta.url);
for (const name of [
  "subtitles/model",
  "lyrics/languages",
  "lyrics/mdx-config",
  "lyrics/policy",
  "lyrics/worker-protocol",
  "lyrics/gemini-contract",
  "lyrics/audio",
  "lyrics/cues",
  "lyrics/runtime-assets",
  "lyrics/whisper",
]) {
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const output = ts
    .transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace(
      /(from\s+["'])(\.[^"']+)(["'])/g,
      (_, prefix, path, suffix) => `${prefix}${path.replace(/\.js$/, "")}.mjs${suffix}`,
    )
    .replace('from "zod"', `from "${pathToFileURL(require.resolve("zod")).href}"`)
    .replace('import("@huggingface/transformers")', 'import("./fake-transformers.mjs")');
  const target = join(directory, `${name}.mjs`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output);
}
writeFileSync(
  join(directory, "lyrics/fake-transformers.mjs"),
  `
export const calls = [];
export const env = {backends:{onnx:{}}};
export let failGpu = false;
export function failNextGpu() { failGpu = true; }
export async function pipeline(task, model, options) {
  const transcriber = async (audio, args) => {
    calls.push({device:options.device, args});
    if (failGpu && options.device === "webgpu") { failGpu = false; throw new Error("GPU lost"); }
    return {text:"test", chunks:[{text:"test", timestamp:[0, 1]}]};
  };
  transcriber.model = {sessions:{decoder:{config:{device:options.device}}}};
  transcriber.dispose = async () => {};
  return transcriber;
}
`,
);
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
const languages = await import(pathToFileURL(join(directory, "lyrics/languages.mjs")).href);
const { transcribeLocalWhisper, disposeWhisperPipelines } = await import(
  pathToFileURL(join(directory, "lyrics/whisper.mjs")).href
);
const provider = await import(pathToFileURL(join(directory, "lyrics/fake-transformers.mjs")).href);

test("Whisper language choices match Tiny/Base's 99-language vocabulary", () => {
  const options = languages.getLanguageOptions("local");
  assert.equal(options.length, 100);
  assert.equal(new Set(options.map(([code]) => code)).size, 100);
  assert.deepEqual(options[0], ["", "Auto"]);
  assert.ok(options.some(([code]) => code === "jw"));
  assert.ok(options.some(([code]) => code === "ta"));
  assert.ok(!options.some(([code]) => code === "yue"));
  assert.equal(languages.getLanguageOptions("gemini").length, 84);
  for (const [input, expected] of [
    ["en-US", "en"],
    ["jv-ID", "jw"],
    ["fil-PH", "tl"],
    ["cmn-Hans-CN", "zh"],
    ["nb-NO", "no"],
    ["kea-CV", ""],
  ])
    assert.equal(languages.resolveLanguageCode("local", input), expected);
  for (const [input, expected] of [
    ["jw", "jv-ID"],
    ["tl", "fil-PH"],
    ["zh", "cmn-Hans-CN"],
    ["no", "nb-NO"],
    ["ta", ""],
    ["pt-PT", "pt-PT"],
  ])
    assert.equal(languages.resolveLanguageCode("gemini", input), expected);
});

const run = (languageCode, preferredBackend = "wasm", seconds = 1) =>
  transcribeLocalWhisper({
    model: "onnx-community/whisper-tiny",
    preferredBackend,
    languageCode,
    waveform: new Float32Array(seconds * 16000).fill(0.2),
    durationMs: seconds * 1000,
    onProgress() {},
  });

test("Whisper receives the language in every window and omits it for Auto", async () => {
  provider.calls.length = 0;
  await run("id", "wasm", 31);
  assert.equal(provider.calls.length, 2);
  assert.ok(
    provider.calls.every(({ args }) => args.language === "id" && args.task === "transcribe"),
  );
  await run("");
  assert.ok(!Object.hasOwn(provider.calls.at(-1).args, "language"));
  const callsBeforeInvalid = provider.calls.length;
  await assert.rejects(run("id-ID"), /not supported by Whisper/);
  assert.equal(provider.calls.length, callsBeforeInvalid);
});

test("Whisper keeps the language when inference falls back from WebGPU to WASM", async () => {
  provider.calls.length = 0;
  provider.failNextGpu();
  const result = await run("ja", "webgpu");
  assert.equal(result.backend, "wasm");
  assert.deepEqual(
    provider.calls.map(({ device, args }) => [device, args.language]),
    [
      ["webgpu", "ja"],
      ["wasm", "ja"],
    ],
  );
  await disposeWhisperPipelines();
});
