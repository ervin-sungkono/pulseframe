import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources({
  modules: [
    "audio-analysis-config",
    "audio-features",
    "visual-settings-model",
    "composition",
    "visual-settings",
    "subtitles",
    "visualizer",
    "render-still",
    "export-settings",
    "track-overlay",
    "glitch",
    "beat-lighting",
    "pcm-features",
    "dsp/contracts",
    "dsp/loader",
    "dsp/wasm-backend",
    "dsp/scan-client",
  ],
});
const {
  compositionSchema,
  createDefaultComposition,
  resolveCompositionBounds,
  setCompositionBounds,
  pointerToCanvas,
  hitTestComposition,
} = modules.composition;
const { DEFAULT_SETTINGS } = (
  await loadSources({ modules: ["customizer-config", "visual-settings-model"] })
)["customizer-config"];

function fakeContext(width, height) {
  const operations = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    canvas: { width, height },
    globalAlpha: 1,
    measureText(text) {
      return { width: String(text).length * 8 };
    },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    save() {},
    restore() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    fillRect() {},
    fillText(text, x, y) {
      operations.push({ text, x, y });
    },
  };
  return { ctx, operations };
}

test("composition validation keeps legacy settings optional and rejects off-canvas bounds", () => {
  assert.equal(
    compositionSchema.safeParse({
      layouts: { base: { artwork: { x: 0.9, y: 0, width: 0.2, height: 0.2 } } },
    }).success,
    false,
  );
  assert.equal(compositionSchema.parse({}).artwork.fit, "cover");
  const legacy = modules["visual-settings"].settingsSchema.parse(DEFAULT_SETTINGS);
  assert.equal(legacy.composition, undefined);
});

test("editing one aspect stores an independent normalized layout", () => {
  const initial = createDefaultComposition();
  const portrait = { x: 0.12, y: 0.22, width: 0.42, height: 0.18 };
  const changed = setCompositionBounds(initial, "portrait", "artwork", portrait);
  assert.deepEqual(changed.layouts.portrait.artwork, portrait);
  assert.equal(changed.layouts.base.artwork, undefined);
  assert.deepEqual(
    resolveCompositionBounds(changed, "landscape", "artwork", {
      x: 0.7,
      y: 0.1,
      width: 0.2,
      height: 0.2,
    }),
    { x: 0.7, y: 0.1, width: 0.2, height: 0.2 },
  );
  assert.deepEqual(
    resolveCompositionBounds(changed, "portrait", "artwork", {
      x: 0.7,
      y: 0.1,
      width: 0.2,
      height: 0.2,
    }),
    portrait,
  );
});

test("pointer mapping accounts for letterboxing and element hit testing follows paint order", () => {
  const point = pointerToCanvas(100, 50, { left: 0, top: 0, width: 200, height: 100 }, 1920, 1080);
  assert.deepEqual(point, { x: 960, y: 540 });
  assert.equal(
    pointerToCanvas(2, 50, { left: 0, top: 0, width: 200, height: 100 }, 1920, 1080),
    null,
  );
  const geometry = {
    background: { x: 0, y: 0, width: 100, height: 100 },
    artwork: { x: 20, y: 20, width: 50, height: 50 },
    captions: { x: 30, y: 30, width: 50, height: 30 },
  };
  assert.equal(hitTestComposition(geometry, { x: 40, y: 40 }), "captions");
  assert.equal(hitTestComposition(geometry, { x: 25, y: 25 }), "artwork");
  assert.equal(hitTestComposition(geometry, { x: 90, y: 90 }), "background");
});

test("canvas selection and track drawing share the resolved track overlay geometry", () => {
  const width = 1280,
    height = 720;
  const { ctx, operations } = fakeContext(width, height);
  const settings = {
    ...DEFAULT_SETTINGS,
    showTrackInfo: true,
    trackTitle: "Canvas geometry",
    trackArtist: "Shared layout",
    infoStyle: "card",
    infoPosition: "top",
  };
  const layout = modules["track-overlay"].trackOverlayLayout(width, height, settings, 0);
  const defaultGeometry = modules.visualizer.visualizationCompositionGeometry(
    ctx,
    width,
    height,
    settings,
    null,
    null,
    [],
    0,
  );
  assert.deepEqual(defaultGeometry.trackInfo, layout.bounds);

  const stored = setCompositionBounds(settings.composition, "landscape", "trackInfo", {
    x: 0.2,
    y: 0.25,
    width: 0.5,
    height: 0.2,
  });
  const edited = { ...settings, composition: stored };
  const selected = modules.visualizer.visualizationCompositionGeometry(
    ctx,
    width,
    height,
    edited,
    null,
    null,
    [],
    0,
  );
  assert.deepEqual(selected.trackInfo, { x: 256, y: 180, width: 640, height: 144 });
  modules["track-overlay"].drawTrackOverlay(
    ctx,
    width,
    height,
    edited,
    0,
    10,
    0,
    selected.trackInfo,
  );
  assert.ok(operations.length > 0);
  assert.ok(operations.every((item) => item.x >= selected.trackInfo.x));
});

test("selected-time still rendering seeks an independent video and leaves preview time untouched", async () => {
  const videos = [];
  const gradient = { addColorStop() {} };
  const makeContext = (canvas) =>
    new Proxy(
      {
        canvas,
        globalAlpha: 1,
        createLinearGradient: () => gradient,
        createRadialGradient: () => gradient,
        measureText: (text) => ({ width: String(text).length * 8 }),
      },
      {
        get(target, property) {
          if (property in target) return target[property];
          return () => {};
        },
      },
    );
  class TemporaryVideo extends EventTarget {
    constructor() {
      super();
      this.duration = 12;
      this.readyState = 0;
      this.videoWidth = 1920;
      this.videoHeight = 1080;
      this._time = 0;
      this._src = "";
      videos.push(this);
    }
    set src(value) {
      this._src = value;
      queueMicrotask(() => {
        this.readyState = 2;
        this.dispatchEvent(new Event("loadedmetadata"));
        this.dispatchEvent(new Event("loadeddata"));
      });
    }
    get src() {
      return this._src;
    }
    set currentTime(value) {
      this._time = value;
      queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
    }
    get currentTime() {
      return this._time;
    }
    pause() {}
    removeAttribute(name) {
      if (name === "src") this._src = "";
    }
    load() {}
  }
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(name) {
        if (name === "video") return new TemporaryVideo();
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => makeContext(canvas),
          toBlob: (callback) => callback(new Blob(["png"], { type: "image/png" })),
        };
        return canvas;
      },
    },
  });
  URL.createObjectURL = () => "blob:still-fixture";
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    const previewVideo = { currentTime: 2.25 };
    const snapshot = {
      file: new File(["video"], "video.mp4", { type: "video/mp4" }),
      video: previewVideo,
      duration: 12,
      sound: null,
      features: null,
      logo: null,
      background: null,
      artwork: null,
    };
    const settings = { ...DEFAULT_SETTINGS, particles: false, beatRays: false, trails: false };
    const blob = await modules["render-still"].renderStillFrame({
      snapshot,
      settings,
      subtitles: [],
      aspect: "landscape",
      time: 5,
      width: 160,
      height: 90,
    });
    assert.equal(blob.type, "image/png");
    assert.equal(previewVideo.currentTime, 2.25);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].currentTime, 5);
    assert.ok(revoked.includes("blob:still-fixture"));
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
