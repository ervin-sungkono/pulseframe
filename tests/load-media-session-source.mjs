import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadMediaSessionSource() {
  const directory = mkdtempSync(join(tmpdir(), 'pulseframe-media-session-'));
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['audio-dsp', 'art-reactivity', 'drop-detector']) {
    writeFileSync(join(directory, name + '.mjs'), readFileSync(new URL(`../lib/${name}.mjs`, import.meta.url)));
  }
  const names = ['audio-analysis-config', 'audio-features', 'live-sound', 'local-image', 'media-session'];
  for (const name of names) {
    const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
      .replace(/from ["'](\.\/[^"']+)["']/g, (_, path) => `from '${path.endsWith('.mjs') ? path : path + '.mjs'}'`)
      .replace(/import\(["'](\.\/[^"']+)["']\)/g, (_, path) => `import('${path.endsWith('.mjs') ? path : path + '.mjs'}')`);
    writeFileSync(join(directory, name + '.mjs'), js);
  }
  return import(pathToFileURL(resolve(directory, 'media-session.mjs')).href);
}
