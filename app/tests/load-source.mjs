import ts from "typescript";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const modules = {
  "style-options": "visual/style-options",
  "audio-analysis-config": "audio/audio-analysis-config",
  "visual-settings-model": "visual/visual-settings-model",
  motion: "visual/motion",
  "export-settings": "export/export-settings",
  "export-timeline": "export/export-timeline",
  "audio-features": "audio/audio-features",
  "pcm-features": "audio/pcm-features",
  "dsp/contracts": "dsp/contracts",
  "dsp/loader": "dsp/loader",
  "dsp/wasm-backend": "dsp/wasm-backend",
  "dsp/scan-client": "dsp/scan-client",
  visualizer: "visual/visualizer",
  subtitles: "subtitles/model",
  "project-file": "persistence/project-file",
  "demo-file": "media/demo-file",
  "media-audio": "media/media-audio",
  "live-sound": "audio/live-sound",
  glitch: "visual/glitch",
  "beat-lighting": "visual/beat-lighting",
  "track-overlay": "visual/track-overlay",
  "visual-settings": "visual/visual-settings",
  presets: "visual/presets",
  "customizer-config": "visual/customizer-config",
  "preset-store": "persistence/preset-store",
  "local-image": "media/local-image",
  "media-session": "media/media-session",
};

// Style modules share the production module graph, including their small helpers.
for (const file of readdirSync(new URL("../lib/visual/styles/", import.meta.url), {
  recursive: true,
})) {
  if (typeof file === "string" && file.endsWith(".ts"))
    modules[file.replace(/\.ts$/, "")] = `visual/styles/${file.replace(/\.ts$/, "")}`;
}

const jsModules = {
  "audio/audio-dsp": "audio/audio-dsp.mjs",
  "audio/art-reactivity": "audio/art-reactivity.mjs",
  "audio/drop-detector": "audio/drop-detector.mjs",
};

function rewriteModuleSpecifiers(source) {
  return source
    .replace(
      /from ["']\.\/analysis-worker\.ts\?worker&url["']/g,
      "from './analysis-worker-url.mjs'",
    )
    .replace(
      /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g,
      (_match, prefix, quote, specifier) => {
        const queryIndex = specifier.search(/[?#]/);
        const modulePath = queryIndex < 0 ? specifier : specifier.slice(0, queryIndex);
        const suffix = queryIndex < 0 ? "" : specifier.slice(queryIndex);
        const outputPath = modulePath.endsWith(".mjs")
          ? modulePath
          : /\.(?:ts|tsx|js)$/.test(modulePath)
            ? modulePath.replace(/\.(?:ts|tsx|js)$/, ".mjs")
            : `${modulePath}.mjs`;
        return `${prefix}${quote}${outputPath}${suffix}${quote}`;
      },
    );
}

export async function loadSources({ dspAssets = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pulseframe-tests-"));
  process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
  const libDirectory = join(directory, "lib");
  const workerUrl = join(libDirectory, "dsp", "analysis-worker-url.mjs");
  mkdirSync(dirname(workerUrl), { recursive: true });
  writeFileSync(workerUrl, `export default 'analysis-worker.test.js';`);

  for (const [targetPath, sourcePath] of Object.entries(jsModules)) {
    const target = join(libDirectory, `${targetPath}.mjs`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(new URL(`../lib/${sourcePath}`, import.meta.url)));
  }

  for (const [name, modulePath] of Object.entries(modules)) {
    const sourceFile = `../lib/${modulePath}.ts`;
    let source = readFileSync(new URL(sourceFile, import.meta.url), "utf8");
    if (dspAssets && name === "dsp/loader") {
      for (const asset of ["pulseframe_dsp.js", "pulseframe_dsp_bg.wasm"]) {
        source = source.replace(
          JSON.stringify("/dsp/" + asset),
          JSON.stringify(new URL("../public/dsp/" + asset, import.meta.url).href),
        );
      }
    }
    let js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const target = join(libDirectory, `${modulePath}.mjs`);
    mkdirSync(dirname(target), { recursive: true });
    js = rewriteModuleSpecifiers(js)
      .replace(/from ["']zod["']/g, `from '${pathToFileURL(require.resolve("zod")).href}'`)
      .replace(/from ["']mediabunny["']/g, `from '${import.meta.resolve("mediabunny")}'`);
    writeFileSync(target, js);
  }

  return Object.fromEntries(
    await Promise.all(
      Object.entries(modules).map(async ([name, modulePath]) => [
        name,
        await import(pathToFileURL(resolve(libDirectory, `${modulePath}.mjs`)).href),
      ]),
    ),
  );
}
