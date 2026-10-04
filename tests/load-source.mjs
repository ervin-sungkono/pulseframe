import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export async function loadSources() {
  const directory = mkdtempSync(join(tmpdir(), 'pulseframe-tests-'));
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
  const names = ['audio-features', 'visualizer', 'subtitles', 'project-file', 'demo-file', 'media-audio', 'live-sound', 'glitch', 'beat-lighting', 'track-overlay', 'visual-settings', 'presets', 'preset-store', 'preset-api', 'preset-route', 'preset-id-route'];
  for (const name of ['audio-dsp', 'art-reactivity', 'drop-detector']) writeFileSync(join(directory, name + '.mjs'), readFileSync(new URL('../lib/' + name + '.mjs', import.meta.url)));
  writeFileSync(join(directory,'test-runtime.mjs'), `export const env={get DB(){return globalThis.__presetTestDB}}; export async function getChatGPTUser(){return globalThis.__presetTestUser??null;}`);
  for (const name of names) {
    const file = name === 'preset-route' ? '../app/api/presets/route.ts' : name === 'preset-id-route' ? '../app/api/presets/[id]/route.ts' : '../lib/' + name + '.ts';
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
      .replace(/from ["']cloudflare:workers["']/g, "from './test-runtime.mjs'")
      .replace(/from ["']@\/app\/chatgpt-auth["']/g, "from './test-runtime.mjs'")
      .replace(/from ["']@\/lib\/([^"']+)["']/g, (_, name) => `from './${name}.mjs'`)
      .replace(/from ["'](\.\/[^"']+)["']/g, (_, path) => `from '${path.endsWith('.mjs') ? path : path + '.mjs'}'`)
      .replace(/from ["']zod["']/g, `from '${pathToFileURL(require.resolve('zod')).href}'`);
    const resolved = js.replace(/from ["']mediabunny["']/g, `from '${import.meta.resolve('mediabunny')}'`);
    writeFileSync(join(directory, name + '.mjs'), resolved);
  }
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await import(pathToFileURL(resolve(directory, name + '.mjs')).href)])));
}
