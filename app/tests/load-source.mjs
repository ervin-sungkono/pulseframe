import ts from "typescript";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export async function loadSources({ dspAssets = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pulseframe-tests-"));
  process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dsp"), { recursive: true });
  writeFileSync(
    join(directory, "dsp", "analysis-worker-url.mjs"),
    `export default 'analysis-worker.test.js';`,
  );
  const names = [
    "audio-analysis-config",
    "visual-settings-model",
    "export-settings",
    "export-timeline",
    "audio-features",
    "pcm-features",
    "dsp/contracts",
    "dsp/loader",
    "dsp/wasm-backend",
    "dsp/scan-client",
    "visualizer",
    "subtitles",
    "project-file",
    "demo-file",
    "media-audio",
    "live-sound",
    "glitch",
    "beat-lighting",
    "track-overlay",
    "visual-settings",
    "presets",
    "customizer-config",
    "preset-store",
  ];
  for (const name of ["audio-dsp", "art-reactivity", "drop-detector"])
    writeFileSync(
      join(directory, name + ".mjs"),
      readFileSync(new URL("../lib/" + name + ".mjs", import.meta.url)),
    );
  for (const name of names) {
    const file = "../lib/" + name + ".ts";
    let source = readFileSync(new URL(file, import.meta.url), "utf8");
    if (dspAssets && name === "dsp/loader") {
      for (const asset of ["pulseframe_dsp.js", "pulseframe_dsp_bg.wasm"]) {
        source = source.replace(
          JSON.stringify("/dsp/" + asset),
          JSON.stringify(new URL("../public/dsp/" + asset, import.meta.url).href),
        );
      }
    }
    const js = ts
      .transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      })
      .outputText.replace(
        /from ["']\.\/analysis-worker\.ts\?worker&url["']/g,
        "from './analysis-worker-url.mjs'",
      )
      .replace(/from ["']@\/lib\/([^"']+)["']/g, (_, name) => `from './${name}.mjs'`)
      .replace(
        /from ["'](\.\.?\/[^"']+)["']/g,
        (_, path) => `from '${path.endsWith(".mjs") ? path : path + ".mjs"}'`,
      )
      .replace(
        /import\(["'](\.\.?\/[^"']+)["']\)/g,
        (_, path) => `import('${path.endsWith(".mjs") ? path : path + ".mjs"}')`,
      )
      .replace(/from ["']zod["']/g, `from '${pathToFileURL(require.resolve("zod")).href}'`);
    const resolved = js.replace(
      /from ["']mediabunny["']/g,
      `from '${import.meta.resolve("mediabunny")}'`,
    );
    const target = join(directory, name + ".mjs");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, resolved);
  }
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await import(pathToFileURL(resolve(directory, name + ".mjs")).href),
      ]),
    ),
  );
}
