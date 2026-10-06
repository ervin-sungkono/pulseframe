import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { loadSources } from './load-source.mjs';

const temp = mkdtempSync(join(tmpdir(), 'pulseframe-preview-test-'));
process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
const modules = await loadSources();
globalThis.__previewTestRuntime = {
  analysisFps: modules['audio-analysis-config'].ANALYSIS_FPS,
  visualizer: modules.visualizer,
};
writeFileSync(join(temp, 'audio-analysis-config.mjs'),
  'export const ANALYSIS_FPS = globalThis.__previewTestRuntime.analysisFps;');
writeFileSync(join(temp, 'visualizer.mjs'),
  'const visualizer = globalThis.__previewTestRuntime.visualizer; export const createAudioReactiveState = visualizer.createAudioReactiveState; export const soundResponse = visualizer.soundResponse;');
const source = readFileSync(new URL('../lib/preview-state.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  .replace(/from ["']\.\/audio-analysis-config["']/g, "from './audio-analysis-config.mjs'")
  .replace(/from ["']\.\/visualizer["']/g, "from './visualizer.mjs'");
const helperFile = join(temp, 'preview-state.mjs');
writeFileSync(helperFile, compiled);
const { advancePreviewResponse, createPreviewResponseWarmer } = await import(pathToFileURL(helperFile).href);

function makeEnvelope(index, bands) {
  const rms = .04 + (index % 19) * .002;
  return {
    rms,
    rmsDb: 20 * Math.log10(rms),
    bassDb: -42 + (index % 23),
    middleDb: -47 + (index % 29),
    highDb: -58 + (index % 31),
    bassHitDb: -38 + (index % 17),
    ringBassDb: -35 + (index % 21),
    bands,
  };
}

function makeHarness({ envelopes, chunkSize = 48, yieldControl = async () => {} }) {
  const settings = structuredClone(modules['customizer-config'].DEFAULT_SETTINGS);
  const media = {};
  const snapshot = {
    generation: 1,
    media,
    duration: envelopes.length / modules['audio-analysis-config'].ANALYSIS_FPS,
    sound: { envelopes },
    features: { at: time => envelopes[Math.min(envelopes.length - 1,
      Math.floor(time * modules['audio-analysis-config'].ANALYSIS_FPS))] ?? null },
  };
  const applied = [];
  const warmer = createPreviewResponseWarmer({
    getSnapshot: () => snapshot,
    getSettings: () => settings,
    apply: result => applied.push(result),
    chunkSize,
    yieldControl,
  });
  return { settings, snapshot, applied, warmer };
}

test('preview warmer matches full five-minute response replay and final analysis frame', async () => {
  const left = Float32Array.from({ length: 96 }, (_, i) => .08 + .2 * Math.sin(i * .13));
  const right = Float32Array.from({ length: 96 }, (_, i) => .06 + .16 * Math.cos(i * .11));
  const bands = [left, right];
  const envelopes = Array.from({ length: 9000 }, (_, i) => makeEnvelope(i, bands));
  let yieldCount = 0;
  const { settings, snapshot, applied, warmer } = makeHarness({
    envelopes,
    yieldControl: async () => { yieldCount++; },
  });

  const result = await warmer.warm(300, 1);

  assert.ok(result);
  assert.equal(result.time, 300);
  assert.equal(result.generation, 1);
  assert.equal(applied.length, 1);
  assert.equal(yieldCount, Math.ceil(9000 / 48) - 1);

  const reference = modules.visualizer.warmSoundResponse(envelopes, settings, 300);
  const frame = snapshot.features.at(300);
  modules.visualizer.soundResponse(frame, settings, reference.state,
    (300 - reference.lastTime) * 1000);
  assert.deepEqual(result.state, reference.state);
});

test('a seek warm catches up every analysis frame elapsed during playback', async () => {
  const bands = [new Float32Array(96).fill(.2), new Float32Array(96).fill(.1)];
  const envelopes = Array.from({ length: 180 }, (_, i) => makeEnvelope(i, bands));
  const { settings, snapshot, warmer } = makeHarness({ envelopes });

  const result = await warmer.warm(4, 1);
  assert.ok(result);
  const caughtUpTo = advancePreviewResponse(result.state, snapshot, settings, 4, 5);
  assert.equal(caughtUpTo, 5);

  const reference = modules.visualizer.warmSoundResponse(envelopes, settings, 5);
  const frame = snapshot.features.at(5);
  modules.visualizer.soundResponse(frame, settings, reference.state,
    (5 - reference.lastTime) * 1000);
  assert.deepEqual(result.state, reference.state);
});

for (const scenario of ['cancel', 'settings', 'generation']) {
  test(`preview warmer rejects stale work after ${scenario} changes`, async () => {
      const bands = [new Float32Array(96).fill(.2), new Float32Array(96).fill(.1)];
    const envelopes = Array.from({ length: 120 }, (_, i) => makeEnvelope(i, bands));
    const gates = [];
    const { settings, snapshot, applied, warmer } = makeHarness({
      envelopes,
      yieldControl: signal => new Promise(resolve => {
        const release = () => {
          signal.removeEventListener('abort', release);
          resolve();
        };
        gates.push(release);
        signal.addEventListener('abort', release, { once: true });
      }),
    });

    const pending = warmer.warm(4, 1);
    assert.equal(gates.length, 1);
    if (scenario === 'cancel') warmer.cancel();
    else if (scenario === 'settings') settings.sensitivity += .25;
    else snapshot.generation++;
    gates[0]();

    assert.equal(await pending, null);
    assert.equal(applied.length, 0);
  });
}
