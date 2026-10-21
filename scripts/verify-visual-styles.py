#!/usr/bin/env python3
"""Capture tolerant visual references and benchmark native Canvas renderers.

Requires Python 3.10+ and Playwright for Python (plus Chromium). No application
dependency is added. Restart Vite after source edits so direct probe imports do
not observe a different hot-reload module instance from the renderer.
The script expects the Vite app to be served at --base-url;
all captures and timing output default to /tmp.

Examples:
  python3 scripts/verify-visual-styles.py
  python3 scripts/verify-visual-styles.py --base-url http://127.0.0.1:5180/ --output /tmp/visual-styles
  python3 scripts/verify-visual-styles.py --update-references
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import math
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / 'app' / 'tests' / 'fixtures' / 'visual-style-reference.json'
OUT = Path('/tmp/pulseframe-visual-styles')
SIGNATURE_MAE_LIMIT = 3.0
BOUNDS_TOLERANCE = 1

SETUP_JS = r"""async () => {
  const [
    { drawVisualization, makeParticles, createAudioReactiveState, ringBandAmplitude },
    { DEFAULT_SETTINGS, BUILTIN_LOOKS },
    { PcmFeatures },
    { PreparedFrequencyHistory, RollingFrequencyHistory, bandEnergy },
    { buildRadialSpectrumGeometry },
    { writeLiquidBlobGeometry },
    { styleResponseHistory },
    { createTerrainSampleBuffer, terrainResolution, sampleTerrain, projectTerrain },
  ] = await Promise.all([
    import('/lib/visual/visualizer.ts'),
    import('/lib/visual/customizer-config.ts'),
    import('/lib/audio/pcm-features.ts'),
    import('/lib/visual/styles/frequency-history.ts'),
    import('/lib/visual/styles/radial-spectrum.ts'),
    import('/lib/visual/styles/liquid-blob.ts'),
    import('/lib/visual/styles/audio-response.ts'),
    import('/lib/visual/styles/spectral-terrain.ts'),
  ]);
  const sampleRate = 48000;
  const durationSeconds = 6;
  const sampleCount = sampleRate * durationSeconds;
  const audioNames = ['silence', 'bass', 'mid', 'high', 'impulse', 'high_intensity', 'low_intensity'];
  const modes = ['ring', 'spectrum', 'edges', 'radial', 'blob', 'terrain'];
  const componentSets = {
    silence: [],
    bass: [[82.41, 0.36]],
    mid: [[1000, 0.35]],
    high: [[6200, 0.35]],
    high_intensity: [[82.41, 0.55], [1000, 0.44], [6200, 0.32]],
    low_intensity: [[82.41, 0.025], [1000, 0.02], [6200, 0.015]],
  };
  const signalFor = (name, channel) => {
    const samples = new Float32Array(sampleCount);
    const channelPhase = channel * 0.19;
    const components = componentSets[name];
    for (let i = 0; i < sampleCount; i++) {
      const t = i / sampleRate;
      let value = 0;
      if (name === 'impulse') {
        // Repeating deterministic low/mid/high bursts with 75 ms exponential decay.
        for (let event = 0.2; event < durationSeconds; event += 0.75) {
          const local = t - event;
          if (local >= 0 && local < 0.075) {
            const envelope = Math.exp(-local * 47);
            value += envelope * (
              0.52 * Math.sin(2 * Math.PI * 82.41 * local + channelPhase) +
              0.25 * Math.sin(2 * Math.PI * 220 * local + channelPhase) +
              0.12 * Math.sin(2 * Math.PI * 4200 * local + channelPhase)
            );
          }
        }
      } else {
        for (const [frequency, amplitude] of components)
          value += amplitude * Math.sin(2 * Math.PI * frequency * t + channelPhase);
      }
      samples[i] = value;
    }
    return samples;
  };
  const audio = {};
  const prep = {};
  const featureCheck = {};
  const histories = {};
  const oneFrame = (frame) => ({
    rms: frame.rms,
    rmsDb: frame.rmsDb,
    bassDb: frame.bassDb,
    bassHitDb: frame.bassHitDb,
    ringBassDb: frame.ringBassDb,
    middleDb: frame.middleDb,
    highDb: frame.highDb,
    bands: frame.bands.map((channel) => channel.slice()),
  });
  for (const name of audioNames) {
    const synthesisStart = performance.now();
    const samples = [signalFor(name, 0), signalFor(name, 1)];
    const synthesisMs = performance.now() - synthesisStart;
    const analysisStart = performance.now();
    const pcm = new PcmFeatures(samples, sampleRate, 0, 'js');
    const frames = [];
    for (let index = 0; index < durationSeconds * 30; index++)
      frames.push(oneFrame(pcm.at((index + 1) / 30, false)));
    const analysisMs = performance.now() - analysisStart;
    const backendMode = pcm.backendMode;
    pcm.dispose();
    audio[name] = frames;
    histories[name] = new PreparedFrequencyHistory(frames);
    prep[name] = { synthesisMs, analysisMs, backendMode, frameCount: frames.length };
    const probe = frames[30] ?? frames[frames.length - 1];
    const averagedBands = probe.bands[0].map((value, index) => (value + (probe.bands[1][index] ?? 0)) / 2);
    const bandPeakIndex = averagedBands.reduce((best, value, index) => value > averagedBands[best] ? index : best, 0);
    featureCheck[name] = {
      rms: probe.rms, rmsDb: probe.rmsDb, bassDb: probe.bassDb,
      middleDb: probe.middleDb, highDb: probe.highDb, bandPeakIndex,
      peakBand: averagedBands[bandPeakIndex], bandCount: averagedBands.length,
    };
  }
  const percentile = (values, q) => {
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.max(0, Math.min(ordered.length - 1, Math.ceil(q * ordered.length) - 1))];
  };
  const stats = (values) => ({
    p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95),
    meanMs: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    timedFrames: values.length,
  });
  const makeSettings = (mode, compositing, changes = {}) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings, changes);
    settings.mode = mode;
    if (changes.radialOptions) settings.radialOptions = { ...DEFAULT_SETTINGS.radialOptions, ...changes.radialOptions };
    if (changes.blobOptions) settings.blobOptions = { ...DEFAULT_SETTINGS.blobOptions, ...changes.blobOptions };
    if (changes.terrainOptions) settings.terrainOptions = { ...DEFAULT_SETTINGS.terrainOptions, ...changes.terrainOptions };
    if (!compositing) {
      settings.particles = false;
      settings.trails = false;
      settings.beatRays = false;
      settings.dropEffects = false;
      settings.glitch = false;
    }
    return settings;
  };
  const makeCanvas = (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create native CanvasRenderingContext2D');
    return { canvas, ctx };
  };
  const drawOne = (ctx, settings, particles, audioState, history, frequency, wave, caseName, index) => {
    const frames = audio[caseName];
    drawVisualization(ctx, settings, frequency, wave, particles,
      (index + 1) / 30, 1000 / 30, null, null, audioState, sampleRate,
      durationSeconds, [], { sound: frames[index % frames.length], history, drop: 0 });
  };
  const renderRun = (mode, caseName, compositing, width, height) => {
    const { ctx } = makeCanvas(width, height);
    const settings = makeSettings(mode, compositing);
    const particles = makeParticles(settings.particleCount);
    const audioState = createAudioReactiveState();
    const history = new PreparedFrequencyHistory(audio[caseName]);
    const frequency = new Uint8Array(1024);
    const wave = new Uint8Array(4096);
    const samples = [];
    for (let index = 0; index < 150; index++) {
      const start = performance.now();
      drawOne(ctx, settings, particles, audioState, history, frequency, wave, caseName, index);
      const elapsed = performance.now() - start;
      if (index >= 30) samples.push(elapsed);
    }
    return { ...stats(samples), historyCacheFramesAfterRun: history.cachedFrames };
  };
  const hashCanvasPixels = (ctx, width, height) => {
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index++) hash = Math.imul(hash ^ pixels[index], 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  };
  const signature8 = (ctx, width, height) => {
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const bytes = new Uint8Array(8 * 8 * 3);
    const cellWidth = width / 8;
    const cellHeight = height / 8;
    const cellPixels = cellWidth * cellHeight;
    const occupied = [];
    let output = 0;
    for (let gy = 0; gy < 8; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        let red = 0, green = 0, blue = 0;
        for (let y = gy * cellHeight; y < (gy + 1) * cellHeight; y++) {
          for (let x = gx * cellWidth; x < (gx + 1) * cellWidth; x++) {
            const offset = (y * width + x) * 4;
            red += pixels[offset]; green += pixels[offset + 1]; blue += pixels[offset + 2];
          }
        }
        red = Math.round(red / cellPixels);
        green = Math.round(green / cellPixels);
        blue = Math.round(blue / cellPixels);
        bytes[output++] = red; bytes[output++] = green; bytes[output++] = blue;
        const maximum = Math.max(red, green, blue);
        const chroma = maximum - Math.min(red, green, blue);
        if (maximum >= 20 && chroma >= 8) occupied.push([gx, gy]);
      }
    }
    let bounds = null;
    if (occupied.length) {
      const xs = occupied.map(([x]) => x), ys = occupied.map(([, y]) => y);
      bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    return { rgb8: btoa(String.fromCharCode(...bytes)), bounds8: bounds };
  };
  const renderPng = (mode, caseName, aspectName, width, height) => {
    const { canvas, ctx } = makeCanvas(width, height);
    const settings = makeSettings(mode, true);
    const particles = makeParticles(settings.particleCount);
    const audioState = createAudioReactiveState();
    const history = new PreparedFrequencyHistory(audio[caseName]);
    const frequency = new Uint8Array(1024);
    const wave = new Uint8Array(4096);
    // Preserve the original legacy frame; new styles receive a full 5-second history.
    const screenshotIndex = ['ring', 'spectrum', 'edges'].includes(mode) ? 30 : 150;
    for (let index = 0; index < screenshotIndex; index++)
      drawOne(ctx, settings, particles, audioState, history, frequency, wave, caseName, index);
    const time = (screenshotIndex + 1) / 30;
    drawOne(ctx, settings, particles, audioState, history, frequency, wave, caseName, screenshotIndex);
    const signature = signature8(ctx, width, height);
    return {
      dataUrl: canvas.toDataURL('image/png'), width, height,
      pixelFnv1a32: hashCanvasPixels(ctx, width, height),
      rgb8: signature.rgb8, bounds8: signature.bounds8,
      aspectName, mode, caseName, screenshotEnvelopeIndex: screenshotIndex,
      screenshotEnvelopeTimeSeconds: time, settingsProfile: 'DEFAULT_SETTINGS with selected mode',
      historyCacheFrames: history.cachedFrames,
      flags: { particles: settings.particles, trails: settings.trails, beatRays: settings.beatRays,
        dropEffects: settings.dropEffects, glitch: settings.glitch },
    };
  };
  const maxChanges = {
    radial: {
      visualScale: 1.5, glow: 2.5,
      radialOptions: { barCount: 160, innerRadius: 40, maxBarLength: 35, barWidth: 100,
        roundness: 100, direction: 'mirrored', rotationSpeed: 100, variant: 'both' },
    },
    blob: {
      visualScale: 1.5, glow: 2.5,
      blobOptions: { size: 150, deformation: 100, fluidity: 100, detail: 'high',
        bassExpansion: 100, internalGlow: 100, idleMotion: 'active' },
    },
    terrain: {
      visualScale: 1.5, glow: 2.5,
      terrainOptions: { height: 100, historySeconds: 10, density: 'high', perspective: 'high',
        travelSpeed: 200, wireOpacity: 100, surfaceFill: 100 },
    },
  };
  const builtinIds = { radial: 'orbit', blob: 'fluid-dreams', terrain: 'neon-horizon' };
  const renderSpecialPng = (mode, kind, aspectName, width, height) => {
    const { canvas, ctx } = makeCanvas(width, height);
    let settings;
    let builtinId = null;
    if (kind === 'max_controls') settings = makeSettings(mode, true, maxChanges[mode]);
    else {
      builtinId = builtinIds[mode];
      const found = BUILTIN_LOOKS.find((look) => look.id === builtinId);
      if (!found) throw new Error(`Missing built-in look ${builtinId}`);
      settings = structuredClone(found.settings);
    }
    const particles = makeParticles(settings.particleCount);
    const audioState = createAudioReactiveState();
    const caseName = 'high_intensity';
    const history = new PreparedFrequencyHistory(audio[caseName]);
    const frequency = new Uint8Array(1024);
    const wave = new Uint8Array(4096);
    for (let index = 0; index < 150; index++) drawOne(ctx, settings, particles, audioState, history, frequency, wave, caseName, index);
    drawOne(ctx, settings, particles, audioState, history, frequency, wave, caseName, 150);
    return {
      dataUrl: canvas.toDataURL('image/png'), width, height, aspectName, mode, kind, builtinId,
      caseName, pixelFnv1a32: hashCanvasPixels(ctx, width, height),
      screenshotEnvelopeIndex: 150, screenshotEnvelopeTimeSeconds: 151 / 30,
      controls: mode === 'radial' ? settings.radialOptions : mode === 'blob' ? settings.blobOptions : settings.terrainOptions,
      visualScale: settings.visualScale, glow: settings.glow,
    };
  };
  const geometryFrame = (mode, caseName, index, history, settings, width, height) => {
    const env = audio[caseName][index];
    const time = (index + 1) / 30;
    const current = new Float32Array(96);
    const previous = new Float32Array(96);
    history.read(time, current, settings.quietThreshold);
    history.read(time - 0.15, previous, settings.quietThreshold);
    const bass = bandEnergy(current, 0, 0.27, settings.sensitivity * settings.bassBoost);
    const mid = bandEnergy(current, 0.27, 0.7, settings.sensitivity);
    const treble = bandEnergy(current, 0.7, 1, settings.sensitivity);
    const priorBass = bandEnergy(previous, 0, 0.27, settings.sensitivity * settings.bassBoost);
    const energy = Math.max(bass, mid, treble);
    return {
      width, height, time, sampleRate, settings, reducedMotion: false, fittedLogo: false,
      captionHeight: 0,
      audio: {
        activity: Math.max(0, Math.min(1, (env.rms - settings.quietThreshold) / 0.018)),
        bass, mid, treble, energy, impact: Math.max(0, Math.min(1, (bass - priorBass) * 2)),
        bands: [current], bandLayers: [[current]], ringMix: 1,
      },
      history,
    };
  };
  const geometryRun = (mode, caseName, width, height) => {
    const settings = makeSettings(mode, true);
    const history = new PreparedFrequencyHistory(audio[caseName]);
    const frames = Array.from({ length: 150 }, (_, index) => geometryFrame(mode, caseName, index, history, settings, width, height));
    const radialSamples = [], blobSamples = [], terrainSampleSamples = [], terrainProjectSamples = [];
    const blobTarget = new Float32Array(160 * 2);
    let terrainBuffer = null;
    let terrainPoints = null;
    let terrainShape = null;
    if (mode === 'terrain') {
      terrainShape = terrainResolution(settings.terrainOptions.density);
      terrainBuffer = createTerrainSampleBuffer(terrainShape.columns, terrainShape.rows);
      terrainPoints = new Float32Array(terrainShape.columns * terrainShape.rows * 2);
    }
    for (let index = 0; index < 150; index++) {
      const frame = frames[index];
      if (mode === 'radial') {
        const start = performance.now();
        buildRadialSpectrumGeometry({ width, height, time: frame.time, reducedMotion: frame.reducedMotion,
          bands: frame.audio.bands, sensitivity: settings.sensitivity, visualScale: settings.visualScale,
          glow: settings.glow }, settings.radialOptions);
        if (index >= 30) radialSamples.push(performance.now() - start);
      } else if (mode === 'blob') {
        const start = performance.now();
        writeLiquidBlobGeometry(blobTarget, frame, settings.blobOptions);
        if (index >= 30) blobSamples.push(performance.now() - start);
      } else {
        const { columns, rows } = terrainShape;
        const sampleStart = performance.now();
        sampleTerrain(styleResponseHistory(frame.history), frame.audio.bands, frame.time, settings.terrainOptions.historySeconds,
          columns, rows, settings.quietThreshold, terrainBuffer);
        const sampleMs = performance.now() - sampleStart;
        const projectStart = performance.now();
        projectTerrain(terrainBuffer.levels, columns, rows, width, height, {
          height: settings.terrainOptions.height, visualScale: settings.visualScale,
          sensitivity: settings.sensitivity, perspective: settings.terrainOptions.perspective,
          captionHeight: frame.captionHeight,
        }, terrainPoints, terrainBuffer.depths);
        const projectMs = performance.now() - projectStart;
        if (index >= 30) {
          terrainSampleSamples.push(sampleMs);
          terrainProjectSamples.push(projectMs);
        }
      }
    }
    return mode === 'radial'
      ? { geometryApi: stats(radialSamples), preparedHistoryCacheFrames: history.cachedFrames }
      : mode === 'blob'
        ? { geometryApi: stats(blobSamples), preparedHistoryCacheFrames: history.cachedFrames }
        : { historySampleApi: stats(terrainSampleSamples), projectionApi: stats(terrainProjectSamples),
            preparedHistoryCacheFrames: history.cachedFrames, rows: terrainShape.rows, columns: terrainShape.columns };
  };
  const renderGeometryRuns = (caseNames, width, height) => {
    const output = {};
    for (const mode of ['radial', 'blob', 'terrain']) {
      output[mode] = {};
      for (const caseName of caseNames) output[mode][caseName] = geometryRun(mode, caseName, width, height);
    }
    return output;
  };
  const createMemoryProbe = (mode) => {
    const changes = mode === 'terrain' ? { terrainOptions: { density: 'high', historySeconds: 10 } } : {};
    const settings = makeSettings(mode, false, changes);
    const { canvas, ctx } = makeCanvas(1280, 720);
    const particles = makeParticles(settings.particleCount);
    const audioState = createAudioReactiveState();
    const caseName = 'high_intensity';
    const frames = audio[caseName];
    const history = new PreparedFrequencyHistory(frames);
    const rollingHistory = new RollingFrequencyHistory();
    const frequency = new Uint8Array(1024);
    const wave = new Uint8Array(4096);
    let count = 0;
    return {
      drawFrames(frameCount) {
        for (let frame = 0; frame < frameCount; frame++) {
          const index = count % frames.length;
          rollingHistory.record((count + 1) / 30, frames[index]);
          const time = (index + 1) / 30;
          drawVisualization(ctx, settings, frequency, wave, particles, time, 1000 / 30,
            null, null, audioState, sampleRate, durationSeconds, [],
            { sound: frames[index], history, drop: 0 });
          count++;
        }
        return { drawCount: count, historyCacheFrames: history.cachedFrames,
          rollingHistoryCacheFrames: rollingHistory.cachedFrames,
          styleResponseCacheFrames: mode === 'blob' || mode === 'terrain' ? styleResponseHistory(history).cachedFrames : 0,
          canvasPixels: canvas.width * canvas.height };
      },
    };
  };
  window.__styleFinal = {
    sampleRate, durationSeconds, audioNames, modes, prep, featureCheck, maxChanges, builtinIds,
    renderRun, renderPng, renderSpecialPng, renderGeometryRuns, createMemoryProbe,
  };
  return {
    audioNames, modes, prep, featureCheck,
    defaultSettings: {
      particles: DEFAULT_SETTINGS.particles, trails: DEFAULT_SETTINGS.trails,
      beatRays: DEFAULT_SETTINGS.beatRays, dropEffects: DEFAULT_SETTINGS.dropEffects,
      glitch: DEFAULT_SETTINGS.glitch, backdrop: DEFAULT_SETTINGS.backdrop,
      glow: DEFAULT_SETTINGS.glow, visualScale: DEFAULT_SETTINGS.visualScale,
      radialOptions: DEFAULT_SETTINGS.radialOptions, blobOptions: DEFAULT_SETTINGS.blobOptions,
      terrainOptions: DEFAULT_SETTINGS.terrainOptions, particleCount: DEFAULT_SETTINGS.particleCount,
    },
    builtins: BUILTIN_LOOKS.filter((look) => Object.values(builtinIds).includes(look.id)).map(({ id, name, settings }) => ({
      id, name, mode: settings.mode, radialOptions: settings.radialOptions,
      blobOptions: settings.blobOptions, terrainOptions: settings.terrainOptions,
    })),
    maxControlSettings: maxChanges,
  };
}"""

BENCH_JS = r"""({ modes, cases, compositing, width, height }) => {
  const api = window.__styleFinal;
  const output = {};
  for (const mode of modes) {
    output[mode] = {};
    for (const caseName of cases) output[mode][caseName] = api.renderRun(mode, caseName, compositing, width, height);
  }
  return output;
}"""
PNG_JS = r"""({ mode, caseName, aspectName, width, height }) =>
  window.__styleFinal.renderPng(mode, caseName, aspectName, width, height)"""
SPECIAL_PNG_JS = r"""({ mode, kind, aspectName, width, height }) =>
  window.__styleFinal.renderSpecialPng(mode, kind, aspectName, width, height)"""
GEOMETRY_JS = r"""({ cases, width, height }) =>
  window.__styleFinal.renderGeometryRuns(cases, width, height)"""
MEMORY_SETUP_JS = r"""(mode) => {
  window.__memoryProbe = window.__styleFinal.createMemoryProbe(mode);
  return true;
}"""
MEMORY_RUN_JS = r"""(frameCount) => window.__memoryProbe.drawFrames(frameCount)"""


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')


def capture_image(out: Path, item: dict, relative: Path, manifest: list[dict]) -> dict:
    data_url = item.pop('dataUrl')
    signature = None
    if 'rgb8' in item:
        signature = {'rgb8': item.pop('rgb8'), 'bounds8': item.pop('bounds8')}
    image_data = base64.b64decode(data_url.split(',', 1)[1])
    target = out / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(image_data)
    manifest.append({**item, 'path': str(relative), 'pngBytes': len(image_data),
        'pngSha256': hashlib.sha256(image_data).hexdigest()})
    return signature or {}


def cell_bounds_within_tolerance(actual: list[int] | None, expected: list[int] | None) -> bool:
    if actual is None or expected is None:
        return actual == expected
    return len(actual) == len(expected) == 4 and all(
        abs(left - right) <= BOUNDS_TOLERANCE for left, right in zip(actual, expected))


def compare_references(actual: dict, references: dict) -> dict:
    expected_cases = references.get('cases', {})
    actual_keys, expected_keys = set(actual), set(expected_cases)
    cases = []
    for key in sorted(actual_keys | expected_keys):
        if key not in actual or key not in expected_cases:
            cases.append({'case': key, 'passed': False,
                'error': 'missing actual capture' if key not in actual else 'missing reference'})
            continue
        current, reference = actual[key], expected_cases[key]
        rgb = base64.b64decode(current['rgb8'])
        expected = base64.b64decode(reference['rgb8'])
        mae = sum(abs(left - right) for left, right in zip(rgb, expected)) / max(1, min(len(rgb), len(expected)))
        bounds_ok = cell_bounds_within_tolerance(current['bounds8'], reference.get('bounds8'))
        passed = len(rgb) == len(expected) and mae <= SIGNATURE_MAE_LIMIT and bounds_ok
        cases.append({'case': key, 'passed': passed, 'rgbMae': round(mae, 4),
            'rgbLimit': SIGNATURE_MAE_LIMIT, 'bounds8': current['bounds8'],
            'expectedBounds8': reference.get('bounds8'), 'boundsToleranceCells': BOUNDS_TOLERANCE,
            **({'error': 'signature length mismatch'} if len(rgb) != len(expected) else {})})
    failures = [item for item in cases if not item['passed']]
    return {'passed': not failures, 'caseCount': len(cases), 'failedCount': len(failures), 'cases': cases}


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, min(len(ordered) - 1, math.ceil(q * len(ordered)) - 1))]


def write_timings(out: Path, metadata: dict) -> None:
    fields = ['scenario', 'mode', 'audio_case', 'api', 'p50_ms', 'p95_ms', 'mean_ms', 'timed_frames']
    with (out / 'timings.csv').open('w', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        for scenario, block in metadata['benchmarks'].items():
            if block is None: continue
            for mode, cases in block.items():
                for case, stats in cases.items():
                    writer.writerow({'scenario': scenario, 'mode': mode, 'audio_case': case, 'api': 'drawVisualization',
                        'p50_ms': f"{stats['p50Ms']:.5f}", 'p95_ms': f"{stats['p95Ms']:.5f}",
                        'mean_ms': f"{stats['meanMs']:.5f}", 'timed_frames': stats['timedFrames']})
        for mode, cases in metadata['geometryOnly'].items():
            for case, data in cases.items():
                for api, stats in data.items():
                    if not isinstance(stats, dict) or 'p50Ms' not in stats: continue
                    writer.writerow({'scenario': 'geometry_only_desktop_unthrottled', 'mode': mode,
                        'audio_case': case, 'api': api, 'p50_ms': f"{stats['p50Ms']:.5f}",
                        'p95_ms': f"{stats['p95Ms']:.5f}", 'mean_ms': f"{stats['meanMs']:.5f}",
                        'timed_frames': stats['timedFrames']})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='http://127.0.0.1:5180/')
    parser.add_argument('--output', default=str(OUT), help='directory for PNG captures and benchmark output')
    parser.add_argument('--update-references', action='store_true', help='rewrite the committed visual signatures')
    parser.add_argument('--skip-mobile', action='store_true')
    args = parser.parse_args()
    out = Path(args.output).expanduser().resolve()
    (out / 'png').mkdir(parents=True, exist_ok=True)
    browser_errors: list[str] = []
    with sync_playwright() as p:
        chromium_path = Path('/usr/bin/chromium')
        browser = p.chromium.launch(headless=True,
            executable_path=str(chromium_path) if chromium_path.exists() else None,
            args=['--no-sandbox', '--disable-dev-shm-usage'])
        context = browser.new_context(viewport={'width': 1280, 'height': 720}, device_scale_factor=1)
        page = context.new_page()
        page.on('pageerror', lambda error: browser_errors.append(str(error)))
        page.goto(args.base_url, wait_until='networkidle', timeout=120000)
        setup = page.evaluate(SETUP_JS)
        modes = setup['modes']
        cases = setup['audioNames']
        dimensions = {'16x9': (1280, 720), '9x16': (720, 1280), '1x1': (960, 960)}
        png_manifest = []
        signatures = {}
        for mode in modes:
            for case_name in cases:
                for aspect, (width, height) in dimensions.items():
                    item = page.evaluate(PNG_JS, {'mode': mode, 'caseName': case_name,
                        'aspectName': aspect, 'width': width, 'height': height})
                    signature = capture_image(out, item, Path('png') / mode / aspect / f'{case_name}.png', png_manifest)
                    key = f'{mode}/{aspect}/{case_name}'
                    signatures[key] = {'width': width, 'height': height, **signature}
        qa_manifest = []
        for mode in ('radial', 'blob', 'terrain'):
            for kind in ('max_controls', 'builtin_polished'):
                for aspect, (width, height) in dimensions.items():
                    item = page.evaluate(SPECIAL_PNG_JS, {'mode': mode, 'kind': kind,
                        'aspectName': aspect, 'width': width, 'height': height})
                    capture_image(out, item, Path('png') / 'qa' / kind / mode / f'{aspect}.png', qa_manifest)
        page.set_viewport_size({'width': 1280, 'height': 720})
        desktop_isolated = page.evaluate(BENCH_JS, {'modes': modes, 'cases': cases,
            'compositing': False, 'width': 1280, 'height': 720})
        desktop_composited = page.evaluate(BENCH_JS, {'modes': modes, 'cases': cases,
            'compositing': True, 'width': 1280, 'height': 720})
        geometry = page.evaluate(GEOMETRY_JS, {'cases': cases, 'width': 1280, 'height': 720})

        cdp = context.new_cdp_session(page)
        cdp.send('HeapProfiler.enable')
        memory_probe = {}
        for mode in ('radial', 'blob', 'terrain'):
            page.evaluate(MEMORY_SETUP_JS, mode)
            observations = []
            for step, frames in (('baseline', 0), ('after1200', 1200), ('after2400', 1200), ('after3600', 1200)):
                if frames:
                    page.evaluate(MEMORY_RUN_JS, frames)
                cdp.send('HeapProfiler.collectGarbage')
                heap = cdp.send('Runtime.getHeapUsage')
                probe = page.evaluate('() => window.__memoryProbe.drawFrames(0)')
                observations.append({'step': step, 'heap': heap, **probe})
            memory_probe[mode] = {
                'observations': observations,
                'retainedGrowthBytesByInterval': [
                    observations[index]['heap']['usedSize'] - observations[index - 1]['heap']['usedSize']
                    for index in range(1, len(observations))
                ],
                'note': 'Observational JS heap readings after explicit CDP GC; Chromium on one managed Linux host, not a GPU or cross-device memory claim.',
            }
        cdp.send('HeapProfiler.disable')

        mobile_isolated = mobile_composited = None
        if not args.skip_mobile:
            cdp.send('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 844,
                'deviceScaleFactor': 1, 'mobile': True})
            cdp.send('Emulation.setTouchEmulationEnabled', {'enabled': True, 'maxTouchPoints': 1})
            cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
            mobile_isolated = page.evaluate(BENCH_JS, {'modes': modes, 'cases': cases,
                'compositing': False, 'width': 1280, 'height': 720})
            mobile_composited = page.evaluate(BENCH_JS, {'modes': modes, 'cases': cases,
                'compositing': True, 'width': 1280, 'height': 720})
            cdp.send('Emulation.setCPUThrottlingRate', {'rate': 1})
            cdp.send('Emulation.clearDeviceMetricsOverride', {})
        cdp.detach()
        browser.close()

    comparison = None
    if args.update_references:
        reference_data = {
            'schemaVersion': 1,
            'signature': '8x8 row-major RGB block averages, rounded to nearest byte and base64 encoded',
            'occupiedBounds': 'inclusive 8x8 cell bounds where max(R,G,B)>=20 and chroma>=8; one-cell tolerance',
            'maxMeanAbsoluteErrorRgb': SIGNATURE_MAE_LIMIT,
            'boundsToleranceCells': BOUNDS_TOLERANCE,
            'cases': signatures,
        }
        REFERENCE.parent.mkdir(parents=True, exist_ok=True)
        REFERENCE.write_text(json.dumps(reference_data, sort_keys=True, separators=(',', ':')) + '\n')
    elif REFERENCE.exists():
        comparison = compare_references(signatures, json.loads(REFERENCE.read_text()))
        write_json(out / 'comparison.json', comparison)
    else:
        comparison = {'passed': False, 'caseCount': 0, 'failedCount': 1,
            'cases': [{'case': str(REFERENCE), 'passed': False, 'error': 'reference fixture is missing; rerun with --update-references'}]}

    for mode in ('blob', 'terrain'):
        cache_frames = memory_probe[mode]['observations'][-1]['styleResponseCacheFrames']
        if not 0 < cache_frames <= 768:
            raise SystemExit(f'{mode}: response cache instrumentation is inactive or unbounded; restart Vite after source edits and rerun')

    metadata = {
      'generatedAtUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
      'sourceRenderer': 'app/lib/visual/visualizer.ts drawVisualization → app/lib/visual/styles/registry.ts',
      'sourceAudio': 'PcmFeatures JavaScript backend, generated before timing; PreparedFrequencyHistory instantiated once per draw run and reused throughout its frames',
      'browser': '/usr/bin/chromium, headless Playwright Chromium',
      'host': 'Managed Linux execution host; desktop render canvas is 1280x720 at deviceScaleFactor=1',
      'canvasContext': 'HTMLCanvasElement.getContext("2d") default attributes; timings are synchronous renderer-call wall time including Canvas API commands and no forced readback',
      'timedFrames': 120, 'warmupFrames': 30,
      'analysis': 'PCM synthesis and PcmFeatures analysis are separate in preparation; no PCM analysis occurs inside timed renderer calls.',
      'renderBenchDimensions': {'width': 1280, 'height': 720, 'pixels': 921600},
      'pngDimensions': {name: {'width': wh[0], 'height': wh[1], 'pixels': wh[0] * wh[1]} for name, wh in dimensions.items()},
      'audioCases': {
        'silence': 'zero PCM, stereo, 48 kHz, 6 s',
        'bass': '82.41 Hz sine, amplitude 0.36, stereo, 48 kHz, 6 s',
        'mid': '1 kHz sine, amplitude 0.35, stereo, 48 kHz, 6 s',
        'high': '6.2 kHz sine, amplitude 0.35, stereo, 48 kHz, 6 s',
        'impulse': 'repeating 75 ms decaying 82/220/4200 Hz bursts every 750 ms, stereo, 48 kHz, 6 s',
        'high_intensity': '82.41 Hz/1 kHz/6.2 kHz at amplitudes 0.55/0.44/0.32, stereo, 48 kHz, 6 s',
        'low_intensity': 'same tones at amplitudes 0.025/0.02/0.015, stereo, 48 kHz, 6 s',
      },
      'defaultSettings': setup['defaultSettings'], 'builtins': setup['builtins'],
      'maxControlSettings': setup['maxControlSettings'], 'preparation': setup['prep'],
      'featureProbes': setup['featureCheck'],
      'benchmarks': {
        'desktopUnthrottledIsolated': desktop_isolated,
        'desktopUnthrottledDefaultCompositing': desktop_composited,
        'mobileSimulation4xCpuIsolated': mobile_isolated,
        'mobileSimulation4xCpuDefaultCompositing': mobile_composited,
      },
      'geometryOnly': geometry,
      'retainedMemoryProbe': memory_probe,
      'pngs': png_manifest, 'qaPngs': qa_manifest, 'browserErrors': browser_errors,
      'mobileSimulationLabel': 'Chromium mobile device metrics 390x844, mobile mode and touch emulation, CPU throttling rate 4x, rendering 1280x720 canvas on a desktop host; not physical mobile hardware.',
    }
    metadata['referenceComparison'] = comparison
    metadata['outputDirectory'] = str(out)
    metadata['updateReferences'] = args.update_references
    (out / 'baseline.json').write_text(json.dumps(metadata, indent=2, sort_keys=True) + '\n')
    write_timings(out, metadata)
    print(json.dumps({'output': str(out), 'pngCount': len(png_manifest), 'qaPngCount': len(qa_manifest),
      'defaultSettings': setup['defaultSettings'], 'builtins': setup['builtins'],
      'benchmarks': metadata['benchmarks'], 'geometryOnly': geometry, 'browserErrors': browser_errors,
      'retainedMemoryProbe': memory_probe, 'referenceComparison': comparison,
      'referencePath': str(REFERENCE), 'metadataPath': str(out / 'baseline.json')}, indent=2))
    if browser_errors:
        raise SystemExit(f'{len(browser_errors)} page errors; see {out / "baseline.json"}')
    if comparison is not None and not comparison['passed']:
        raise SystemExit(f'visual comparison failed for {comparison["failedCount"]} case(s); see {out / "comparison.json"}')


if __name__ == '__main__':
    main()
