import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { drawVisualization, createAudioReactiveState, warmSoundResponse } = modules.visualizer;
const { PreparedFrequencyHistory } = modules["frequency-history"];
const { DEFAULT_SETTINGS } = modules["customizer-config"];
const { VISUAL_STYLE_RENDERERS } = modules.registry;

function canvasContext() {
  const geometry = [];
  const gradient = { addColorStop() {} };
  const context = new Proxy(
    {
      canvas: { width: 1280, height: 720 },
      measureText(value) {
        return { width: Array.from(value).length * 10 };
      },
    },
    {
      set(target, key, value) {
        if (key === "globalAlpha") geometry.push([key, value]);
        target[key] = value;
        return true;
      },
      get(target, key) {
        if (key in target) return target[key];
        if (String(key).startsWith("create")) return () => gradient;
        return (...args) => {
          if (["rect", "roundRect", "moveTo", "lineTo", "quadraticCurveTo", "arc"].includes(key))
            geometry.push([key, ...args]);
        };
      },
    },
  );
  return { context, geometry };
}

const envelopes = Array.from({ length: 3000 }, (_, index) => ({
  rms: index % 70 < 60 ? 0.2 : 0,
  rmsDb: -12,
  bassDb: -12,
  middleDb: -20,
  highDb: -25,
  bands: [
    Float32Array.from({ length: 96 }, (_, band) => (Math.sin(index * 0.27 + band * 0.4) + 1) / 2),
  ],
}));

test("registry contains exactly the five first-class style IDs", () => {
  assert.deepEqual(Object.keys(VISUAL_STYLE_RENDERERS).sort(), [
    "edges",
    "radial",
    "ring",
    "spectrum",
    "terrain",
  ]);
});

test("new styles share source-time geometry across preview warm-up, clipped export and capture", () => {
  const history = new PreparedFrequencyHistory(envelopes);
  for (const mode of ["radial", "terrain"]) {
    const settings = {
      ...DEFAULT_SETTINGS,
      mode,
      backdrop: "clean",
      particles: false,
      trails: false,
      beatRays: false,
      glitch: false,
      dropEffects: false,
    };
    const sourceTime = 60.5;
    const draw = (state, delta) => {
      const { context, geometry } = canvasContext();
      drawVisualization(
        context,
        settings,
        new Uint8Array(2048),
        new Uint8Array(4096).fill(128),
        [],
        sourceTime,
        delta,
        null,
        null,
        state,
        48000,
        100,
        [],
        { sound: envelopes[Math.floor(sourceTime * 30)], history },
      );
      return geometry;
    };
    const preview = draw(warmSoundResponse(envelopes, settings, sourceTime).state, 0);
    const clipFirstFrame = draw(createAudioReactiveState(), 1000 / 30);
    const pngCapture = draw(createAudioReactiveState(), 0);
    assert.ok(preview.length > 10, mode);
    assert.deepEqual(clipFirstFrame, preview, mode);
    assert.deepEqual(pngCapture, preview, mode);
  }
});

test("single-style rendering forwards onset and timed lyric animation through the shared pipeline", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    mode: "spectrum",
    backdrop: "clean",
    particles: false,
    trails: false,
    beatRays: true,
    beatLighting: "rays",
    beatLightingIntensity: 100,
    glitch: false,
    dropEffects: false,
  };
  const render = (subtitles, extras) => {
    const { context, geometry } = canvasContext();
    drawVisualization(
      context,
      settings,
      new Uint8Array(2048),
      new Uint8Array(4096).fill(128),
      [],
      1,
      0,
      null,
      null,
      createAudioReactiveState(),
      48000,
      10,
      subtitles,
      extras,
    );
    return geometry;
  };

  const noOnset = render([], {}).filter(([name]) => name === "arc").length;
  const withOnset = render([], { onset: 1 }).filter(([name]) => name === "arc").length;
  assert.ok(withOnset > noOnset, "prepared onsets should reach the beat-lighting renderer");

  const cue = {
    id: "line",
    start: 0,
    end: 2,
    text: "one two",
    words: [
      { textStart: 0, textEnd: 3, start: 0, end: 0.75 },
      { textStart: 4, textEnd: 7, start: 0.75, end: 1.5 },
    ],
  };
  const style = {
    animation: "karaoke",
    color: "#ffffff",
    highlightColor: "#b9a2ff",
    fontSize: 0.046,
    position: 0.945,
    background: false,
  };
  const rects = (extras) => render([cue], extras).filter(([name]) => name === "rect").length;
  const staticRects = rects({ lyricStyle: { ...style, animation: "static" } });
  const karaokeRects = rects({ lyricStyle: style });
  assert.ok(karaokeRects > staticRects, "word timing should add highlighted text spans");
});
