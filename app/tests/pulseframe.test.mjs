import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "./load-source.mjs";
import { FFTAnalyzer, generateDemo } from "../lib/audio/audio-dsp.mjs";
const modules = await loadSources();
const { PcmFeatures, findDropEvents, dropEnvelope, audibleMediaTime, prepareSound } =
  modules["audio-features"];
const { ANALYSIS_FPS, ANALYSIS_SIZE } = modules["audio-analysis-config"];
const { DEFAULT_LOGO_AUTO_FIT, DEFAULT_LOGO_FIT_SCALE, DEFAULT_LOGO_PLACEMENTS } =
  modules["visual-settings-model"];
const { settingsSchema, migrateSettings } = modules["visual-settings"];
const { DEFAULT_SETTINGS } = modules["customizer-config"];
const {
  createAudioReactiveState,
  audioResponse,
  soundResponse,
  warmSoundResponse,
  drawVisualization,
  ringMagnitude,
  edgeBarResponse,
  edgeBarLayout,
  spectrumLayout,
  sampleBarBand,
  makeParticles,
  coverCrop,
} = modules.visualizer;
const settings = {
  mode: "ring",
  spectrumRoundness: 100,
  spectrumReflection: 45,
  ringLayers: 3,
  ringRearOpacity: 30,
  ringMirror: false,
  ringFocus: "bass",
  glitch: false,
  glitchStrength: 0.35,
  particleMode: "stardust",
  particleFlow: "drift",
  backdrop: "clean",
  primary: "#9b72ff",
  secondary: "#61e5ff",
  background: "#080c20",
  sensitivity: 1.3,
  quietThreshold: 0.006,
  bassBoost: 1,
  responseStyle: "balanced",
  atmosphere: 1,
  particleCount: 120,
  glow: 0.95,
  visualScale: 1.1,
  motionSpeed: 1,
  particleSize: 1,
  beatRays: true,
  beatLighting: "rays",
  beatLightingIntensity: 65,
  trails: true,
  particles: true,
  videoOpacity: 55,
  backgroundOpacity: 25,
  dropEffects: true,
  logoOpacity: 100,
  logoAutoFit: DEFAULT_LOGO_AUTO_FIT,
  logoFitScale: DEFAULT_LOGO_FIT_SCALE,
  logoPlacements: DEFAULT_LOGO_PLACEMENTS,
  showTrackInfo: false,
  trackTitle: "",
  trackArtist: "",
  infoPosition: "top",
  infoAlign: "left",
  infoSize: 1,
  infoStyle: "shade",
  infoFont: "sans",
  infoWeight: 700,
  infoColor: "#ffffff",
  infoSecondaryColor: "#c8d0e5",
  infoOpacity: 100,
  infoBackground: "#040816",
  infoBackgroundOpacity: 55,
  infoRadius: 16,
  showTimer: false,
};
const tone = (rate, frequency, amplitude = 0.5, seconds = 2) =>
  Float32Array.from(
    { length: rate * seconds },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / rate),
  );
const close = (a, b, epsilon = 0.06) => assert.ok(Math.abs(a - b) < epsilon, `${a} vs ${b}`);

class TestAudioBuffer {
  constructor({ length, sampleRate, numberOfChannels }) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.numberOfChannels = numberOfChannels;
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(channel) {
    return this.data[channel];
  }
  copyToChannel(samples, channel, offset = 0) {
    this.data[channel].set(samples.subarray(0, this.length - offset), offset);
  }
}
test("native WAV decoding preserves sample offsets in bounded exports and full exports reuse PCM", async () => {
  globalThis.AudioBuffer = TestAudioBuffer;
  try {
    const { decodeMediaAudio, sliceAudio, audioSections } = modules["media-audio"];
    const file = modules["demo-file"].makeDemoFile();
    const full = await decodeMediaAudio(file),
      start = 1.013,
      end = 1.527;
    const section = await decodeMediaAudio(file, undefined, start, end);
    assert.equal(sliceAudio(full, 0, full.duration), full);
    assert.equal(section.length, Math.ceil((end - start) * full.sampleRate));
    for (let c = 0; c < 2; c++) {
      const offset = Math.round(start * full.sampleRate);
      assert.deepEqual(
        section.getChannelData(c).subarray(0, 1000),
        full.getChannelData(c).subarray(offset, offset + 1000),
      );
    }
    const pieces = [...audioSections(full, start, 12.527)];
    assert.equal(pieces.length, 3);
    assert.equal(
      pieces.reduce((count, piece) => count + piece.length, 0),
      Math.round(12.527 * full.sampleRate) - Math.round(start * full.sampleRate),
    );
    let offset = Math.round(start * full.sampleRate);
    for (const piece of pieces) {
      assert.ok(piece.duration <= 5);
      assert.deepEqual(
        piece.getChannelData(0),
        full.getChannelData(0).subarray(offset, offset + piece.length),
      );
      offset += piece.length;
    }
    const canceled = new AbortController();
    canceled.abort();
    await assert.rejects(() => decodeMediaAudio(file, canceled.signal), { name: "AbortError" });
  } finally {
    delete globalThis.AudioBuffer;
  }
});
test("live fallback uses pre-volume stereo PCM and disconnects its analysis graph", () => {
  const rate = 48000,
    samples = tone(rate, 80, 0.4, 1).subarray(0, 4096),
    nodes = [];
  const node = () => {
    const value = {
      connect() {},
      disconnect() {
        this.disconnected = true;
      },
    };
    nodes.push(value);
    return value;
  };
  let channel = 0;
  const context = {
    sampleRate: rate,
    createGain: node,
    createChannelSplitter: node,
    createAnalyser: () => {
      const analyzer = node(),
        polarity = channel++ ? -1 : 1;
      analyzer.getFloatTimeDomainData = (buffer) =>
        buffer.set(Float32Array.from(samples, (sample) => sample * polarity));
      return analyzer;
    },
  };
  const live = new modules["live-sound"].LiveSound(context, node());
  const { sound } = live.at(5);
  assert.equal(sound.time, 5);
  assert.ok(sound.bassDb > -20);
  assert.ok(sound.rms > 0.2);
  assert.deepEqual(sound.bands[0], sound.bands[1]);
  live.reset();
  live.dispose();
  assert.ok(nodes.slice(1).every((value) => value.disconnected));
});

test("shared causal PCM is calibrated at 44.1 and 48 kHz", () => {
  for (const rate of [44100, 48000]) {
    const samples = tone(rate, 1000);
    const frame = new PcmFeatures([samples], rate).at(1);
    // Diagnostic peak fitting is explicit; production frames retain calibrated bins.
    const diagnostic = new FFTAnalyzer(ANALYSIS_SIZE).analyze(
      samples,
      rate - ANALYSIS_SIZE / 2,
      rate,
    );
    close(diagnostic.peakDb, -6.0206);
    close(frame.rmsDb, -9.0309);
    assert.ok(frame.middleDb > frame.bassDb + 35);
  }
});
test("opposite-phase stereo retains equal power and independent contours", () => {
  const left = tone(48000, 80),
    right = Float32Array.from(left, (x) => -x);
  const same = new PcmFeatures([left, left], 48000).at(1),
    opposite = new PcmFeatures([left, right], 48000).at(1);
  close(same.rms, opposite.rms, 1e-9);
  close(same.bassDb, opposite.bassDb, 1e-9);
  assert.deepEqual(same.frequency, opposite.frequency);
  assert.deepEqual(same.bands, opposite.bands);
  const oneSided = new PcmFeatures([new Float32Array(left.length), right], 48000).at(1);
  assert.ok(oneSided.rms > 0.2);
  assert.ok(oneSided.bands[1].some((v) => v > 0.5));
});
test("frames cannot react to samples after the playhead", () => {
  const samples = new Float32Array(96000);
  for (let i = 49000; i < 52000; i++) samples[i] = 0.5 * Math.sin((i * 2 * Math.PI * 70) / 48000);
  const analyzer = new PcmFeatures([samples], 48000);
  assert.equal(analyzer.at(1).rms, 0);
  assert.ok(analyzer.at(1.08).bassDb > -25);
});
test("a silent DC-heavy channel cannot replace the audible waveform", () => {
  const toneSamples = tone(48000, 300, 0.1, 1);
  const frame = new PcmFeatures([new Float32Array(48000).fill(0.5), toneSamples], 48000).at(0.8);
  assert.ok(Math.min(...frame.wave) < 120);
  assert.ok(Math.max(...frame.wave) < 145);
});
test("range warm-up uses the actual first-frame interval and handles trailing silence", () => {
  const analyzer = new PcmFeatures([tone(24000, 80, 0.5, 2)], 24000);
  const history = Array.from({ length: 2 * ANALYSIS_FPS }, (_, i) =>
    analyzer.at(i / ANALYSIS_FPS, false),
  );
  const start = 1.01,
    warmed = warmSoundResponse(history, settings, start);
  const lastIndex = Math.ceil(start * ANALYSIS_FPS) - 1;
  assert.equal(warmed.lastTime, lastIndex / ANALYSIS_FPS);
  const sequential = createAudioReactiveState();
  for (let i = 0; i <= lastIndex; i++)
    soundResponse(history[i], settings, sequential, i ? 1000 / ANALYSIS_FPS : 0);
  assert.deepEqual(warmed.state, sequential);
  const later = warmSoundResponse(history, settings, 6);
  assert.ok(later.state.activity < 1e-7);
  assert.ok(later.state.energy < 1e-7);
});
test("paused sound settings can rebuild a held frame without advancing its timeline", () => {
  const analyzer = new PcmFeatures([tone(24000, 70, 0.01, 2)], 24000);
  const history = Array.from({ length: ANALYSIS_FPS }, (_, i) =>
    analyzer.at(i / ANALYSIS_FPS, false),
  );
  const quiet = warmSoundResponse(history, { ...settings, quietThreshold: 0.1 }, 1).state;
  const active = warmSoundResponse(history, { ...settings, quietThreshold: 0 }, 1).state;
  assert.equal(quiet.activity, 0);
  assert.ok(active.activity > 0.3);
  const before = active.activity;
  soundResponse(analyzer.at(1), settings, active, 0);
  assert.equal(active.activity, before);
});
test("shared analysis config keeps feature timing and legacy schema fallbacks stable", async () => {
  assert.equal(ANALYSIS_FPS, 30);
  assert.equal(ANALYSIS_SIZE, 4096);
  assert.equal(new PcmFeatures([new Float32Array(ANALYSIS_SIZE)], 48000).at(0).size, ANALYSIS_SIZE);
  const audio = new TestAudioBuffer({
    length: Math.round(1.01 * 24000),
    sampleRate: 24000,
    numberOfChannels: 1,
  });
  const prepared = await prepareSound(audio);
  assert.equal(prepared.envelopes.length, Math.ceil(audio.duration * ANALYSIS_FPS));
  assert.equal(DEFAULT_SETTINGS.ringMirror, true);
  assert.equal(DEFAULT_SETTINGS.ringFocus, "full");
  const legacy = settingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ringMirror: undefined,
    ringFocus: undefined,
  });
  assert.equal(legacy.ringMirror, false);
  assert.equal(legacy.ringFocus, "bass");
  const migrated = migrateSettings(legacy);
  assert.equal(migrated.ringMirror, false);
  assert.equal(migrated.ringFocus, "bass");
});
test("silence, DC and inaudible noise do not cause deformation; kicks do", () => {
  for (const samples of [
    new Float32Array(48000),
    new Float32Array(48000).fill(0.2),
    tone(48000, 60, 0.0001, 1),
  ]) {
    const state = createAudioReactiveState();
    const response = soundResponse(
      new PcmFeatures([samples], 48000).at(0.8),
      settings,
      state,
      2000,
    );
    assert.equal(response.activity, 0);
    assert.equal(response.energy, 0);
    assert.ok(state.bands.every((b) => b.every((v) => v === 0)));
  }
  const kick = new Float32Array(48000);
  for (let i = 24000; i < 28000; i++)
    kick[i] = 0.7 * Math.exp(-(i - 24000) / 2400) * Math.sin((2 * Math.PI * 65 * i) / 48000);
  const state = createAudioReactiveState(),
    response = soundResponse(new PcmFeatures([kick], 48000).at(0.55), settings, state, 33);
  assert.ok(response.bassPulse > 0.1);
  assert.ok(response.energy > 0.1);
});
test("the live analyser fallback eases motion separately and holds its envelope at zero delta", () => {
  const state = createAudioReactiveState();
  const loudFrequency = new Uint8Array(2048).fill(255);
  const loudWave = Uint8Array.from({ length: 4096 }, (_, index) => (index % 2 ? 255 : 0));
  const silentFrequency = new Uint8Array(2048);
  const silentWave = new Uint8Array(4096).fill(128);
  const response = audioResponse(
    loudFrequency,
    loudWave,
    settings.quietThreshold,
    settings.sensitivity,
    state,
    1000 / 30,
    48000,
    settings.bassBoost,
    settings.responseStyle,
  );
  assert.ok(state.motionPulse > 0 && state.motionPulse < response.bassPulse);

  for (let frame = 1; frame < 30; frame++)
    audioResponse(
      loudFrequency,
      loudWave,
      settings.quietThreshold,
      settings.sensitivity,
      state,
      1000 / 30,
      48000,
      settings.bassBoost,
      settings.responseStyle,
    );
  assert.ok(state.motionPulse > 0.5);

  const held = state.motionPulse;
  audioResponse(
    loudFrequency,
    loudWave,
    settings.quietThreshold,
    settings.sensitivity,
    state,
    0,
    48000,
    settings.bassBoost,
    settings.responseStyle,
  );
  assert.equal(state.motionPulse, held);

  for (let frame = 0; frame < 180; frame++)
    audioResponse(
      silentFrequency,
      silentWave,
      settings.quietThreshold,
      settings.sensitivity,
      state,
      1000 / 30,
      48000,
      settings.bassBoost,
      settings.responseStyle,
    );
  assert.ok(state.motionPulse < 0.02);
});
test("drop events use fixed source time, retain cut history, and end exactly", async () => {
  const events = await findDropEvents(generateDemo(24000, 32), 24000);
  assert.ok(
    events.some((time) => time >= 15 && time < 17),
    String(events),
  );
  const start = events[0] + 0.1;
  assert.ok(dropEnvelope(events, start) > 0);
  assert.equal(dropEnvelope(events, events[0] + 0.9), 0);
  assert.equal(dropEnvelope(events, events[0] - 0.01), 0);
});
test("audible clock correction never advances the media clock and pause holds position", () => {
  const context = {
    currentTime: 10,
    outputLatency: 0.08,
    getOutputTimestamp: () => ({ contextTime: 9.9, performanceTime: 1000 }),
  };
  close(audibleMediaTime({ paused: false, currentTime: 5 }, context, 1000), 4.9, 1e-8);
  assert.equal(audibleMediaTime({ paused: true, currentTime: 5 }, context, 1000), 5);
});

function fakeCanvas(width, height) {
  const draws = [],
    coords = [],
    operations = [],
    stack = [],
    gradient = () => ({ addColorStop() {} });
  const ctx = {
    canvas: { width, height },
    globalAlpha: 1,
    filter: "none",
    save() {
      stack.push({ globalAlpha: this.globalAlpha, filter: this.filter });
    },
    restore() {
      Object.assign(this, stack.pop());
    },
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    measureText: (text) => ({ width: text.length * 10 }),
    drawImage(...args) {
      draws.push({ filter: this.filter, opacity: this.globalAlpha, args });
    },
    stroke() {
      draws.push({ stroke: true });
    },
    fill(rule) {
      draws.push({ fill: true, rule, opacity: this.globalAlpha, style: this.fillStyle });
    },
  };
  for (const name of [
    "beginPath",
    "closePath",
    "clearRect",
    "fillRect",
    "rect",
    "arc",
    "roundRect",
    "moveTo",
    "lineTo",
    "quadraticCurveTo",
    "bezierCurveTo",
    "translate",
    "transform",
    "rotate",
    "scale",
    "clip",
    "fillText",
  ])
    ctx[name] = (...args) => {
      operations.push({ name, args });
      for (const value of args) if (typeof value === "number") coords.push(value);
    };
  return { ctx, draws, coords, operations };
}
test("audio-reactive rendering applies motionPulse rather than the faster hit contour", () => {
  const w = 1280,
    h = 720;
  const active = {
    ...settings,
    motionPreset: "orbit",
    motionBehavior: "audio-reactive",
    motionAmount: 100,
    motionSpeed: 1,
    cameraShake: false,
    particles: false,
    trails: false,
    beatRays: false,
  };
  const sound = new PcmFeatures([new Float32Array(48000)], 48000, 0, "js").at(0.8);
  const state = createAudioReactiveState();
  state.activity = 1;
  state.ringPulse = 1;
  state.motionPulse = 0.25;
  state.ringMix = 1;
  const { ctx, operations } = fakeCanvas(w, h);

  drawVisualization(
    ctx,
    active,
    sound.frequency,
    sound.wave,
    [],
    2,
    0,
    null,
    null,
    state,
    48000,
    1,
    [],
    { sound },
  );

  const firstTranslate = operations.find((operation) => operation.name === "translate");
  const expected = modules.motion.ringMotion(2, w, h, active, state.motionPulse);
  const hitPose = modules.motion.ringMotion(2, w, h, active, state.ringPulse);
  assert.ok(firstTranslate, "object transform should translate the ring group");
  assert.ok(Math.abs(firstTranslate.args[0] - (w / 2 + expected.x)) < 1e-9);
  assert.ok(Math.abs(firstTranslate.args[1] - (h / 2 + expected.y)) < 1e-9);
  assert.ok(Math.hypot(expected.x - hitPose.x, expected.y - hitPose.y) > 10);
});
test("camera shake reaches all five registered styles after motion integration", () => {
  const sound = new PcmFeatures([tone(48000, 80, 0.4, 1)], 48000, 0, "js").at(0.8);
  for (const mode of ["ring", "spectrum", "edges", "radial", "terrain"]) {
    const active = {
      ...DEFAULT_SETTINGS,
      mode,
      cameraShake: true,
      cameraShakeAmount: 100,
      motionPreset: "orbit",
      particles: false,
      trails: false,
      beatRays: false,
    };
    const state = createAudioReactiveState();
    const { ctx, operations, coords } = fakeCanvas(1280, 720);
    drawVisualization(
      ctx,
      active,
      sound.frequency,
      sound.wave,
      [],
      2,
      1000,
      null,
      null,
      state,
      48000,
      1,
      [],
      { sound },
    );
    const camera = modules.motion.cameraMotion(
      2,
      1280,
      720,
      active,
      state.ringPulse,
      state.activity,
    );
    const firstTranslate = operations.find((operation) => operation.name === "translate");
    assert.ok(camera.scale > 1, `${mode}: audible bass should activate the camera`);
    close(firstTranslate.args[0], 640 + camera.x);
    close(firstTranslate.args[1], 360 + camera.y);
    assert.ok(coords.every(Number.isFinite), mode);
    assert.equal(ctx.globalAlpha, 1, `${mode}: canvas state is restored`);
  }
});

test("all three styles remain visible in silence across every export ratio", () => {
  const sound = new PcmFeatures([new Float32Array(48000)], 48000).at(0.8);
  for (const mode of ["ring", "spectrum", "edges"])
    for (const [w, h] of [
      [1280, 720],
      [720, 1280],
      [1080, 1080],
    ]) {
      const { ctx, draws, coords } = fakeCanvas(w, h);
      drawVisualization(
        ctx,
        { ...settings, mode },
        sound.frequency,
        sound.wave,
        makeParticles(300),
        0.8,
        33,
        null,
        null,
        createAudioReactiveState(),
        48000,
        1,
        [],
        { sound },
      );
      assert.ok(
        draws.some((d) => d.stroke || d.fill),
        mode,
      );
      assert.ok(coords.every(Number.isFinite), mode);
    }
});
test("background opacity and drop blur are composited only on image layer", () => {
  const image = { width: 900, height: 1600, naturalWidth: 900, naturalHeight: 1600 };
  for (const drop of [0, 1]) {
    const { ctx, draws } = fakeCanvas(1280, 720);
    drawVisualization(
      ctx,
      settings,
      new Uint8Array(2048),
      new Uint8Array(4096).fill(128),
      makeParticles(0),
      1,
      0,
      null,
      null,
      createAudioReactiveState(),
      48000,
      2,
      [],
      { background: image, drop },
    );
    assert.equal(draws[0].opacity, 0.25);
    assert.equal(draws[0].filter, drop ? "blur(5px)" : "none");
    assert.equal(ctx.filter, "none");
    assert.ok(draws[0].args[3] >= 1280);
    assert.ok(draws[0].args[4] >= 720);
  }
  const { ctx, draws } = fakeCanvas(720, 720);
  drawVisualization(
    ctx,
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
    2,
    [],
    { background: image, drop: 1, reducedMotion: true },
  );
  assert.equal(draws[0].filter, "none");
  assert.deepEqual(coverCrop(1600, 900, 900, 900), { x: 350, y: 0, width: 900, height: 900 });
});
test("new projects retain background and old v1 projects remain readable", async () => {
  const { EXPORT_FRAME_RATES } = modules["export-settings"];
  const { makeProjectFile, readProjectFile } = modules["project-file"];
  const media = new File(["original-media"], "song.wav", { type: "audio/wav" }),
    background = new File(["background-bytes"], "scene.png", { type: "image/png" });
  const editedSettings = {
    ...settings,
    ringLayers: 4,
    ringRearOpacity: 15,
    ringMirror: true,
    ringFocus: "full",
    spectrumRoundness: 85,
    spectrumReflection: 35,
    infoStyle: "card",
    infoFont: "serif",
    infoAlign: "right",
    glitch: true,
    glitchStrength: 0.6,
    beatLighting: "edges",
    beatLightingIntensity: 80,
    logoFitScale: { ...DEFAULT_LOGO_FIT_SCALE, ring: 90 },
  };
  const content = {
    format: "square",
    resolution: 1440,
    frameRate: 60,
    videoCompression: true,
    range: [1, 4],
    settings: editedSettings,
    subtitles: [{ id: "a", start: 1, end: 2, text: "hello" }],
    media,
    logo: null,
    background,
  };
  const blob = makeProjectFile(content),
    opened = await readProjectFile(new File([blob], "new.pulseframe"));
  for (const frameRate of EXPORT_FRAME_RATES) {
    const restored = await readProjectFile(
      new File([makeProjectFile({ ...content, frameRate })], "fps.pulseframe"),
    );
    assert.equal(restored.frameRate, frameRate);
  }
  assert.equal(opened.resolution, 1440);
  assert.equal(opened.videoCompression, true);
  assert.equal(opened.frameRate, 60);
  assert.equal(await opened.background.text(), "background-bytes");
  assert.equal(await opened.media.text(), "original-media");
  assert.equal(opened.settings.mode, "ring");
  assert.equal(opened.settings.ringLayers, 4);
  assert.equal(opened.settings.logoFitScale.ring, 90);
  assert.equal(opened.settings.ringRearOpacity, 15);
  assert.equal(opened.settings.ringMirror, true);
  assert.equal(opened.settings.glitch, true);
  assert.equal(opened.settings.glitchStrength, 0.6);
  assert.equal(opened.settings.spectrumRoundness, 85);
  assert.equal(opened.settings.spectrumReflection, 35);
  assert.equal(opened.settings.infoStyle, "card");
  assert.equal(opened.settings.infoFont, "serif");
  assert.equal(opened.settings.infoAlign, "right");
  assert.equal(opened.settings.ringFocus, "full");
  assert.equal(opened.settings.beatLighting, "edges");
  assert.equal(opened.settings.beatLightingIntensity, 80);
  const oldSettings = structuredClone(settings);
  oldSettings.mode = "halo";
  oldSettings.logoPlacements.halo = { x: 45, y: 48, size: 30 };
  oldSettings.logoAutoFit.halo = false;
  delete oldSettings.backgroundOpacity;
  delete oldSettings.dropEffects;
  delete oldSettings.ringLayers;
  delete oldSettings.logoFitScale;
  delete oldSettings.logoAutoFit.ring;
  delete oldSettings.logoPlacements.ring;
  for (const key of [
    "ringRearOpacity",
    "ringMirror",
    "ringFocus",
    "glitch",
    "glitchStrength",
    "beatLighting",
    "beatLightingIntensity",
  ])
    delete oldSettings[key];
  const manifest = {
    version: 1,
    format: "landscape",
    profile: "standard",
    range: [0, 4],
    settings: oldSettings,
    subtitles: [],
    media: { name: media.name, type: media.type, size: media.size },
    logo: null,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest)),
    header = new Uint8Array(8);
  header.set(new TextEncoder().encode("PF01"));
  new DataView(header.buffer).setUint32(4, bytes.length, true);
  const old = await readProjectFile(new File([header, bytes, media], "old.pulseframe"));
  assert.equal(old.resolution, 720);
  assert.equal(old.videoCompression, false);
  assert.equal(old.frameRate, 30);
  assert.equal(old.background, null);
  assert.equal(old.settings.mode, "ring");
  assert.equal(old.migratedStyle, "halo");
  assert.deepEqual(old.settings.logoPlacements.ring, { x: 45, y: 48, size: 30 });
  assert.equal(old.settings.dropEffects, false);
  assert.equal(old.settings.logoAutoFit.ring, false);
  assert.equal(old.settings.beatLighting, "rays");
  assert.equal(old.settings.beatLightingIntensity, 65);
  assert.equal(old.settings.ringLayers, 3);
  assert.deepEqual(old.settings.logoFitScale, DEFAULT_LOGO_FIT_SCALE);
  assert.equal(old.settings.ringRearOpacity, 30);
  assert.equal(old.settings.ringMirror, false);
  assert.equal(old.settings.glitch, false);
  assert.equal(old.settings.glitchStrength, 0.35);
  assert.equal(old.settings.ringFocus, "bass");
  await assert.rejects(
    () => readProjectFile(new File([blob.slice(0, blob.size - 1)], "broken.pulseframe")),
    /missing or damaged/,
  );
});

test("fitted logos fill the actual circular aperture and only scale down in every aspect ratio", () => {
  const image = { width: 1600, height: 900 };
  for (const mode of ["ring"])
    for (const [w, h] of [
      [1280, 720],
      [720, 1280],
      [1080, 1080],
    ]) {
      const fullDiameter = Math.min(w, h) * (0.205 * 0.88 * 2) * settings.visualScale;
      for (const scale of [50, 75, 100, 150]) {
        const { ctx, draws, coords } = fakeCanvas(w, h);
        const current = {
          ...settings,
          mode,
          logoFitScale: { ...DEFAULT_LOGO_FIT_SCALE, [mode]: scale },
        };
        drawVisualization(
          ctx,
          current,
          new Uint8Array(2048),
          new Uint8Array(4096).fill(128),
          [],
          1,
          0,
          null,
          image,
          createAudioReactiveState(),
        );
        const logo = draws.find((draw) => draw.args?.[0] === image);
        assert.ok(logo);
        close(logo.args[7], (fullDiameter * Math.min(scale, 100)) / 100, 1e-8);
        close(logo.args[8], logo.args[7], 1e-8);
        close(logo.args[5] + logo.args[7] / 2, w / 2, 1e-8);
        close(logo.args[6] + logo.args[8] / 2, h / 2, 1e-8);
        assert.ok(coords.every(Number.isFinite));
      }
    }
});
test("Pulse Ring paints the selected number of solid layers with a clear center", () => {
  for (const ringLayers of [1, 2, 3, 4]) {
    const { ctx, draws, coords } = fakeCanvas(1280, 720);
    drawVisualization(
      ctx,
      { ...settings, ringLayers },
      new Uint8Array(2048),
      new Uint8Array(4096).fill(128),
      [],
      1,
      0,
      null,
      null,
      createAudioReactiveState(),
    );
    const layers = draws.filter((draw) => draw.fill && draw.rule === "evenodd");
    assert.equal(layers.length, ringLayers);
    assert.equal(layers.at(-1).opacity, 1);
    assert.ok(layers.slice(0, -1).every((layer) => layer.opacity > 0 && layer.opacity <= 0.3));
    assert.ok(layers.every((layer) => typeof layer.style === "object"));
    assert.ok(coords.every(Number.isFinite));
  }
});

test("Pulse Ring mirrors unequal stereo channels without seams in both wave focuses", () => {
  const bands = [
    Float32Array.from({ length: 96 }, (_, i) => 0.2 + 0.5 * Math.sin((i / 95) * Math.PI) ** 2),
    new Float32Array(96).fill(0.1),
  ];
  for (const focus of ["auto", "bass", "full"]) {
    for (let i = 1; i < 120; i++)
      close(
        ringMagnitude(bands, i / 240, 1.3, true, focus),
        ringMagnitude(bands, 1 - i / 240, 1.3, true, focus),
        1e-12,
      );
    assert.ok(
      ringMagnitude(bands, 0.25, 1.3, false, focus) > ringMagnitude(bands, 0.75, 1.3, false, focus),
    );
    for (const pole of [0, 0.5])
      close(
        ringMagnitude(bands, pole - 1e-6, 1.3, false, focus),
        ringMagnitude(bands, pole + 1e-6, 1.3, false, focus),
        1e-8,
      );
  }
});
test("loud sound retains movement contrast while measured PCM remains unchanged", () => {
  const frames = [0.25, 0.5, 0.8].map((amplitude) =>
    new PcmFeatures([tone(48000, 80, amplitude)], 48000).at(0.8),
  );
  const before = structuredClone(frames),
    energy = frames.map(
      (frame) => soundResponse(frame, settings, createAudioReactiveState(), 2000).energy,
    );
  assert.ok(energy[0] < energy[1] && energy[1] < energy[2]);
  assert.ok(energy[2] < 1);
  assert.deepEqual(frames, before);
});
test("glitch bursts are deterministic, adjustable and absent in silence or reduced motion", () => {
  const { glitchPulse } = modules.glitch;
  const time = Array.from({ length: 600 }, (_, i) => i / 30).find(
    (t) => glitchPulse(t, 0.8, 0.7, 1, 0.5) > 0,
  );
  assert.ok(time !== undefined);
  const pulse = glitchPulse(time, 0.8, 0.7, 1, 0.5);
  assert.equal(glitchPulse(time, 0.8, 0.7, 1, 0.5), pulse);
  close(glitchPulse(time, 0.8, 0.7, 1, 1), pulse * 2, 1e-12);
  assert.equal(glitchPulse(time, 0.8, 0.7, 0, 1), 0);
  assert.equal(glitchPulse(time, 0, 0, 1, 1), 0);
  let snapshots = 0;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      snapshots++;
    }
    getContext() {
      return { clearRect() {}, drawImage() {} };
    }
  };
  try {
    const sound = new PcmFeatures([tone(48000, 80)], 48000).at(0.8);
    for (const reducedMotion of [true, false]) {
      const { ctx, draws } = fakeCanvas(1280, 720);
      drawVisualization(
        ctx,
        { ...settings, glitch: true },
        sound.frequency,
        sound.wave,
        [],
        time,
        2000,
        null,
        null,
        createAudioReactiveState(),
        48000,
        20,
        [],
        { sound, reducedMotion },
      );
      assert.equal(draws.filter((draw) => draw.args).length, reducedMotion ? 0 : 6);
      assert.equal(ctx.globalAlpha, 1);
    }
    assert.equal(snapshots, 1);
  } finally {
    delete globalThis.OffscreenCanvas;
  }
});

test("short bass impacts use a causal faster window at both sample rates", () => {
  for (const rate of [44100, 48000]) {
    const kick = new Float32Array(rate);
    for (let i = Math.round(rate * 0.5); i < Math.round(rate * 0.55); i++)
      kick[i] = 0.6 * Math.sin(2 * Math.PI * 70 * (i / rate - 0.5));
    const analyzer = new PcmFeatures([kick], rate);
    assert.equal(analyzer.at(0.5).bassHitDb, -160);
    const attack = analyzer.at(0.515);
    assert.ok(attack.bassHitDb > attack.bassDb + 6);
    const release = analyzer.at(0.58);
    assert.equal(release.bassHitDb, -160);
    assert.ok(release.bassDb > -55);
    const opposite = new PcmFeatures([kick, Float32Array.from(kick, (x) => -x)], rate).at(0.515);
    close(opposite.bassHitDb, attack.bassHitDb, 1e-8);
  }
});
test("ring impact settles on sustained bass and transparent layers trail the main contour", () => {
  const analyzer = new PcmFeatures([tone(48000, 70, 0.4)], 48000),
    state = createAudioReactiveState();
  const pulses = [];
  for (let i = 0; i < 1.5 * ANALYSIS_FPS; i++) {
    soundResponse(analyzer.at(i / ANALYSIS_FPS), settings, state, i ? 1000 / ANALYSIS_FPS : 0);
    pulses.push(state.ringPulse);
  }
  assert.ok(Math.max(...pulses.slice(0, 8)) > state.ringPulse * 2);
  assert.ok(state.ringPulse > 0 && state.ringPulse < 0.25);
  const fresh = createAudioReactiveState();
  soundResponse(analyzer.at(1), settings, fresh, 33);
  const max = (array) => Math.max(...array);
  assert.ok(max(fresh.ringBands[0][0]) > max(fresh.ringBands[3][0]));
  const quiet = new PcmFeatures([new Float32Array(48000)], 48000).at(0.8);
  soundResponse(quiet, settings, fresh, 2000);
  assert.ok(fresh.ringPulse < 1e-8);
  assert.ok(max(fresh.ringBands[0][0]) < 1e-8);
});
test("bass wave focus follows bass while full sound also represents treble", () => {
  const maxima = (frequency, focus) => {
    const frame = new PcmFeatures([tone(48000, frequency, 0.4)], 48000).at(1);
    const state = createAudioReactiveState();
    soundResponse(frame, settings, state, 2000);
    return Math.max(
      ...Array.from({ length: 160 }, (_, i) =>
        ringMagnitude(state.ringBands[0], i / 160, 1.3, true, focus),
      ),
    );
  };
  assert.ok(maxima(70, "bass") > 0.3);
  assert.ok(maxima(6000, "bass") < 0.01);
  assert.ok(maxima(6000, "full") > 0.3);
});

test("Auto ring focus follows audible non-bass passages and keeps quiet audio gated", () => {
  for (const rate of [44100, 48000])
    for (const frequency of [70, 300, 1000, 6000]) {
      const frame = new PcmFeatures([tone(rate, frequency, 0.2)], rate).at(1);
      const state = createAudioReactiveState();
      soundResponse(frame, { ...settings, ringFocus: "auto" }, state, 2000);
      assert.ok(state.ringMix >= 0 && state.ringMix <= 1);
      if (frequency <= 300) assert.ok(state.ringMix < 0.01, `${frequency}: ${state.ringMix}`);
      else assert.ok(state.ringMix > 0.99, `${frequency}: ${state.ringMix}`);
      const magnitude = Math.max(
        ...Array.from({ length: 160 }, (_, i) =>
          ringMagnitude(
            state.ringBands[0],
            i / 160,
            1.3,
            true,
            "auto",
            Math.min(16000, rate / 2),
            state.ringMix,
          ),
        ),
      );
      assert.ok(magnitude > 0.2, `${frequency}: ${magnitude}`);
    }
  const state = createAudioReactiveState(),
    bright = new PcmFeatures([tone(48000, 5000, 0.2)], 48000).at(1);
  soundResponse(bright, settings, state, 33);
  assert.ok(state.ringMix > 0 && state.ringMix < 0.3);
  const before = state.ringMix;
  soundResponse(bright, settings, state, 0);
  assert.equal(state.ringMix, before);
  const quiet = new PcmFeatures([tone(48000, 6000, 0.0001)], 48000).at(1);
  soundResponse(quiet, settings, state, 2000);
  assert.ok(state.ringBands[0][0].every((v) => v < 1e-8));
});
test("Auto retains brighter contours when vocals or treble coexist with steady bass", () => {
  const bass = tone(48000, 70, 0.2),
    high = tone(48000, 6000, 0.4);
  const mixed = Float32Array.from(bass, (value, i) => value + high[i]);
  const frame = new PcmFeatures([mixed], 48000).at(1),
    state = createAudioReactiveState();
  soundResponse(frame, settings, state, 2000);
  assert.ok(state.ringMix > 0.8);
  const highPosition = Math.log(6000 / 35) / Math.log(16000 / 35) / 2;
  const auto = ringMagnitude(
    state.ringBands[0],
    highPosition,
    1.3,
    true,
    "auto",
    16000,
    state.ringMix,
  );
  const bassOnly = ringMagnitude(state.ringBands[0], highPosition, 1.3, true, "bass");
  assert.ok(auto > bassOnly + 0.2);
});
test("Spectrum is centered, symmetric and unclipped across ratios, scales and maximum audio", () => {
  for (const [w, h] of [
    [1280, 720],
    [720, 1280],
    [1080, 1080],
    [360, 203],
  ])
    for (const visualScale of [0.5, 1.1, 1.5]) {
      const layout = spectrumLayout(w, h, visualScale, 2.5);
      close(layout.x + layout.zone / 2, w / 2, 1e-8);
      assert.equal(layout.centerY, h / 2);
      assert.ok(layout.x >= layout.margin - 1e-8);
      assert.ok(layout.centerY + layout.maxHalf <= h - layout.margin + 1e-8);
      assert.ok(layout.centerY - layout.maxHalf >= layout.margin - 1e-8);
      const bands = [new Float32Array(96).fill(1), new Float32Array(96).fill(1)];
      const sound = {
        rms: 0.7,
        rmsDb: -3,
        bassDb: -3,
        ringBassDb: -3,
        middleDb: -3,
        highDb: -3,
        bands,
      };
      const { ctx, operations } = fakeCanvas(w, h);
      drawVisualization(
        ctx,
        {
          ...settings,
          mode: "spectrum",
          visualScale,
          glow: 2.5,
          trails: false,
          particles: false,
          beatRays: false,
        },
        new Uint8Array(2048),
        new Uint8Array(4096).fill(128),
        [],
        1,
        2000,
        null,
        null,
        createAudioReactiveState(),
        48000,
        2,
        [],
        { sound },
      );
      const bars = operations.filter((op) => op.name === "roundRect");
      assert.equal(bars.length, layout.count * 2);
      for (const {
        args: [x, y, bw, bh],
      } of bars) {
        close(y + bh / 2, h / 2, 1e-8);
        assert.ok(x >= layout.margin - 1e-8);
        assert.ok(x + bw <= w - layout.margin + 1e-8);
        assert.ok(y >= layout.margin - 1e-8);
        assert.ok(y + bh <= h - layout.margin + 1e-8);
      }
      assert.equal(
        operations.some((op) => op.name === "scale"),
        false,
      );
      for (let i = 0; i < bars.length / 2; i++)
        close(bars[i].args[3], bars.at(-1 - i).args[3], 1e-8);
    }
});
test("Spectrum represents narrow bass, voice and treble tones even at small render sizes", () => {
  for (const frequency of [70, 300, 1000, 6000, 14000]) {
    const sound = new PcmFeatures([tone(48000, frequency, 0.2)], 48000).at(1);
    const { ctx, operations } = fakeCanvas(360, 640);
    drawVisualization(
      ctx,
      { ...settings, mode: "spectrum", trails: false, particles: false, beatRays: false },
      sound.frequency,
      sound.wave,
      [],
      1,
      2000,
      null,
      null,
      createAudioReactiveState(),
      48000,
      2,
      [],
      { sound },
    );
    assert.ok(
      Math.max(...operations.filter((op) => op.name === "roundRect").map((op) => op.args[3])) > 40,
      String(frequency),
    );
  }
});
test("Spectrum keeps fitted logos and caption lanes clear without moving its axis", () => {
  const bands = [new Float32Array(96).fill(1)],
    sound = { rms: 0.7, rmsDb: -3, bassDb: -3, middleDb: -3, highDb: -3, bands };
  for (const [w, h] of [
    [1280, 720],
    [720, 1280],
    [1080, 1080],
  ]) {
    const image = { width: 500, height: 500 },
      { ctx, operations } = fakeCanvas(w, h);
    drawVisualization(
      ctx,
      {
        ...settings,
        mode: "spectrum",
        visualScale: 1.5,
        trails: false,
        particles: false,
        beatRays: false,
      },
      new Uint8Array(2048),
      new Uint8Array(4096).fill(128),
      [],
      1,
      2000,
      null,
      image,
      createAudioReactiveState(),
      48000,
      2,
      [{ id: "x", start: 0, end: 2, text: "caption" }],
      { sound },
    );
    const short = Math.min(w, h),
      bars = operations
        .filter((op) => op.name === "roundRect")
        .slice(0, spectrumLayout(w, h, 1.5, settings.glow).count * 2);
    for (const {
      args: [, y, , bh],
    } of bars) {
      assert.ok(y > h * 0.21 + short * 0.085);
      assert.ok(
        y + bh < h - Math.max(22, short * 0.055) - Math.max(24, Math.round(short * 0.046)) * 1.85,
      );
      close(y + bh / 2, h / 2, 1e-8);
    }
  }
});
test("lighting variations are adjustable, silent and reduced-motion safe, and deterministic", () => {
  const { drawBeatLighting } = modules["beat-lighting"];
  const snapshots = [];
  for (const beatLighting of ["rays", "aura", "beams", "edges"]) {
    const config = { ...settings, beatLighting };
    const draw = (pulse, intensity = 65, reduced = false) => {
      const { ctx, operations } = fakeCanvas(1280, 720);
      drawBeatLighting(
        ctx,
        1280,
        720,
        { ...config, beatLightingIntensity: intensity },
        pulse,
        3,
        reduced,
      );
      return operations;
    };
    assert.deepEqual(draw(0), []);
    assert.deepEqual(draw(0.8, 0), []);
    assert.deepEqual(draw(0.8, 65, true), []);
    const active = draw(0.8);
    assert.ok(active.length);
    assert.deepEqual(draw(0.8), active);
    snapshots.push(JSON.stringify(active));
  }
  assert.equal(new Set(snapshots).size, 4);
});
test("all retired project modes migrate to supported styles and retain the selected logo layout", async () => {
  const { makeProjectFile, readProjectFile } = modules["project-file"];
  const media = new File(["media"], "song.wav", { type: "audio/wav" });
  for (const [mode, target] of [
    ["halo", "ring"],
    ["tunnel", "ring"],
    ["bloom", "ring"],
    ["wave", "spectrum"],
    ["aurora", "spectrum"],
  ]) {
    const layout = { x: 42, y: 37, size: 28 };
    const projectSettings = {
      ...settings,
      mode,
      ringFocus: "auto",
      beatLighting: "beams",
      logoAutoFit: { ...DEFAULT_LOGO_AUTO_FIT, [mode]: false },
      logoFitScale: { ...DEFAULT_LOGO_FIT_SCALE, [mode]: 75 },
      logoPlacements: { ...DEFAULT_LOGO_PLACEMENTS, [mode]: layout },
    };
    const blob = makeProjectFile({
      settings: projectSettings,
      media,
      logo: null,
      background: null,
      format: "portrait",
      profile: "standard",
      range: [0, 1],
      subtitles: [],
    });
    const opened = await readProjectFile(new File([blob], "test.pulseframe"));
    assert.equal(opened.settings.mode, target);
    assert.equal(opened.settings.ringFocus, "auto");
    assert.equal(opened.settings.beatLighting, "beams");
    assert.equal(opened.settings.logoAutoFit[target], false);
    assert.equal(opened.settings.logoFitScale[target], 75);
    assert.deepEqual(opened.settings.logoPlacements[target], layout);
    assert.deepEqual(Object.keys(opened.settings.logoPlacements).sort(), [
      "edges",
      "radial",
      "ring",
      "spectrum",
      "terrain",
    ]);
  }
});

test("bottom details and subtitles do not collapse a landscape Spectrum", () => {
  const sound = {
    rms: 0.7,
    rmsDb: -3,
    bassDb: -3,
    middleDb: -3,
    highDb: -3,
    bands: [new Float32Array(96).fill(1)],
  };
  const config = {
    ...settings,
    mode: "spectrum",
    visualScale: 1.5,
    infoPosition: "bottom",
    infoSize: 1.5,
    showTrackInfo: true,
    showTimer: true,
    trackTitle: "A song",
    trackArtist: "An artist",
    trails: false,
    particles: false,
    beatRays: false,
  };
  for (const text of ["One caption line", "A very long caption ".repeat(15)]) {
    const { ctx, operations } = fakeCanvas(1280, 720);
    drawVisualization(
      ctx,
      config,
      new Uint8Array(2048),
      new Uint8Array(4096).fill(128),
      [],
      1,
      2000,
      null,
      null,
      createAudioReactiveState(),
      48000,
      2,
      [{ id: "x", start: 0, end: 2, text }],
      { sound },
    );
    const count = spectrumLayout(1280, 720, 1.5, settings.glow).count,
      bars = operations.filter((op) => op.name === "roundRect").slice(0, count * 2);
    assert.ok(Math.min(...bars.map((op) => op.args[3])) > 80);
    const textRow = operations.find((op) => op.name === "fillText");
    assert.ok(Math.max(...bars.map((op) => op.args[1] + op.args[3])) < textRow.args[2]);
  }
});

test("bar sampling preserves flat spectra and interpolates fractional frequency positions", () => {
  const flat = new Float32Array(96).fill(0.6);
  for (const width of [0, 1 / 71, 2 / 71, 1 / 31, 1])
    for (const position of [0, 0.013, 0.5, 0.987, 1])
      close(sampleBarBand(flat, position, width), 0.6, 1e-7);
  assert.equal(sampleBarBand(undefined, 0.5, 0.1), 0);
  assert.equal(sampleBarBand(new Float32Array(), 0.5, 0.1), 0);
  assert.equal(sampleBarBand(new Float32Array([0.5]), 0.5, 0.1), 0.5);
  const ramp = Float32Array.from({ length: 96 }, (_, i) => i / 95);
  for (const position of [0.123, 0.456, 0.789])
    for (const width of [0, 1 / 31, 2 / 71])
      close(sampleBarBand(ramp, position, width), position, 1e-7);
});

test("an isolated frequency peak tapers across bars instead of repeating a three-bar plateau", () => {
  const bands = new Float32Array(96);
  bands[50] = 1;
  const heights = Array.from({ length: 48 }, (_, i) => sampleBarBand(bands, i / 47, 1 / 47));
  assert.ok(heights[24] > 0 && heights[25] > heights[24]);
  assert.ok(heights[26] < heights[24]);
  assert.ok(heights[22] === 0 && heights[27] === 0);
  for (const width of [1 / 31, 1 / 47, 1 / 71])
    for (let index = 45; index <= 55; index++) {
      const position = index / 95;
      close(
        sampleBarBand(bands, position - 1e-8, width),
        sampleBarBand(bands, position + 1e-8, width),
        1e-5,
      );
    }
});

test("bar smoothing tapers repeated bass-bin plateaus while retaining their peak", () => {
  const bands = new Float32Array(96);
  bands.fill(1, 20, 24);
  const heights = Array.from({ length: 72 }, (_, i) => sampleBarBand(bands, i / 71, 1 / 71));
  const peak = Math.max(...heights);
  assert.ok(peak > 0.9);
  assert.equal(heights.filter((height) => Math.abs(height - peak) < 1e-6).length, 1);
  for (let i = 1; i < heights.length - 1; i++)
    assert.ok(
      !(heights[i] > 0.5 && heights[i - 1] === heights[i] && heights[i] === heights[i + 1]),
    );
});

test("Spectrum samples one frequency footprint per bar in each mirrored half", () => {
  const bands = new Float32Array(96);
  bands[50] = 0.8;
  const state = createAudioReactiveState();
  const config = {
    ...settings,
    mode: "spectrum",
    bassBoost: 0,
    particles: false,
    trails: false,
    beatRays: false,
  };
  const { ctx, operations } = fakeCanvas(1280, 720);
  drawVisualization(
    ctx,
    config,
    new Uint8Array(2048),
    new Uint8Array(4096).fill(128),
    [],
    1,
    2000,
    null,
    null,
    state,
    48000,
    2,
    [],
    { sound: { rms: 0.4, rmsDb: -8, bassDb: -160, middleDb: -160, highDb: -160, bands: [bands] } },
  );
  const { count, maxHalf } = spectrumLayout(1280, 720, config.visualScale, config.glow);
  const bars = operations.filter((op) => op.name === "roundRect").slice(0, count);
  const idle = Math.min(maxHalf, Math.max(2, 720 * 0.004));
  for (let i = 0; i < count; i++) {
    const position = Math.abs(i - (count - 1) / 2) / ((count - 1) / 2);
    const value = sampleBarBand(state.ringBands[0][0], position, 2 / (count - 1));
    const expected = idle + (1 - Math.exp(-value * config.sensitivity * 3.8)) * (maxHalf - idle);
    close(bars[i].args[3] / 2, expected, 1e-6);
    close(bars[i].args[3], bars[count - 1 - i].args[3], 1e-8);
  }
});

test("Edge Bars follow opposing linear frequency directions and keep a clear center", () => {
  for (const [w, h] of [
    [1280, 720],
    [720, 1280],
    [1080, 1080],
  ])
    for (const scale of [0.5, 1.1, 1.5]) {
      const layout = edgeBarLayout(w, h, scale, 2.5);
      assert.ok(layout.maxHeight <= h * 0.38);
      assert.ok(layout.x >= layout.margin - 1e-8);
      const bands = [new Float32Array(96)];
      bands[0][0] = 0.8;
      const top = Array.from({ length: layout.count }, (_, i) =>
        edgeBarResponse(bands, i, layout.count, "top", 1.3),
      );
      const bottom = Array.from({ length: layout.count }, (_, i) =>
        edgeBarResponse(bands, i, layout.count, "bottom", 1.3),
      );
      assert.ok(top[0] > 0 && top.at(-1) === 0);
      assert.ok(bottom[0] === 0 && bottom.at(-1) > 0);
      top.forEach((v, i) => close(v, bottom.at(-1 - i), 1e-8));
      const sound = {
        rms: 0.7,
        rmsDb: -3,
        bassDb: -3,
        middleDb: -3,
        highDb: -3,
        bands: [new Float32Array(96).fill(1)],
      };
      const { ctx, operations } = fakeCanvas(w, h);
      drawVisualization(
        ctx,
        {
          ...settings,
          mode: "edges",
          visualScale: scale,
          glow: 2.5,
          trails: false,
          particles: false,
          beatRays: false,
        },
        new Uint8Array(2048),
        new Uint8Array(4096).fill(128),
        [],
        1,
        2000,
        null,
        null,
        createAudioReactiveState(),
        48000,
        2,
        [],
        { sound },
      );
      const bars = operations.filter((op) => op.name === "roundRect");
      assert.equal(bars.length, layout.count * 2);
      for (const {
        args: [x, y, bw, bh],
      } of bars) {
        assert.ok(x >= 0 && x + bw <= w);
        assert.ok(y >= 0 && y + bh <= h);
        assert.ok(y === 0 || y + bh === h);
        assert.ok(bh <= h * 0.38);
      }
    }
});
test("rounded spectrum uses rounded paths without square endpoint highlights and optional reflection", () => {
  const sound = {
    rms: 0.7,
    rmsDb: -3,
    bassDb: -3,
    middleDb: -3,
    highDb: -3,
    bands: [new Float32Array(96).fill(0.5)],
  };
  for (const spectrumReflection of [0, 45, 100])
    for (const spectrumRoundness of [0, 100]) {
      const { ctx, operations } = fakeCanvas(1280, 720);
      drawVisualization(
        ctx,
        {
          ...settings,
          mode: "spectrum",
          spectrumReflection,
          spectrumRoundness,
          trails: false,
          particles: false,
          beatRays: false,
        },
        new Uint8Array(2048),
        new Uint8Array(4096).fill(128),
        [],
        1,
        2000,
        null,
        null,
        createAudioReactiveState(),
        48000,
        2,
        [],
        { sound },
      );
      const bars = operations.filter((op) => op.name === "roundRect"),
        count = spectrumLayout(1280, 720, settings.visualScale, settings.glow).count;
      assert.equal(bars.length, count * (spectrumReflection ? 2 : 1));
      assert.ok(bars.every((op) => (spectrumRoundness ? op.args[4] > 0 : op.args[4] === 0)));
      assert.ok(!operations.some((op) => op.name === "fillRect" && op.args[2] < 20));
    }
});
test("track overlays support background styles, fonts, colors and every placement", () => {
  for (const infoStyle of ["plain", "shade", "card", "accent"])
    for (const infoFont of ["sans", "serif", "mono"])
      for (const infoPosition of ["top", "center", "bottom"])
        for (const infoAlign of ["left", "center", "right"]) {
          const { ctx, operations } = fakeCanvas(720, 1280);
          modules["track-overlay"].drawTrackOverlay(
            ctx,
            720,
            1280,
            {
              ...settings,
              showTrackInfo: true,
              trackTitle: "A title",
              trackArtist: "An artist",
              infoStyle,
              infoFont,
              infoPosition,
              infoAlign,
              infoOpacity: 70,
            },
            20,
            100,
          );
          const texts = operations.filter((op) => op.name === "fillText");
          assert.equal(texts.length, 2);
          assert.ok(
            texts.every(
              (op) => op.args[1] >= 0 && op.args[1] <= 720 && op.args[2] > 0 && op.args[2] < 1280,
            ),
          );
          assert.equal(ctx.globalAlpha, 1);
          if (infoStyle === "card" || infoStyle === "accent")
            assert.ok(operations.some((op) => op.name === "roundRect"));
        }
});
test("presets save the look and applying them preserves the current song labels", () => {
  const { presetStyle, applyPreset } = modules.presets;
  const style = presetStyle({
    ...settings,
    mode: "edges",
    trackTitle: "Old song",
    trackArtist: "Old artist",
    infoStyle: "card",
    infoFont: "serif",
  });
  assert.equal("trackTitle" in style, false);
  assert.equal("trackArtist" in style, false);
  assert.equal(style.infoStyle, "card");
  const applied = applyPreset(
    { ...settings, trackTitle: "Current song", trackArtist: "Current artist" },
    style,
  );
  assert.equal(applied.mode, "edges");
  assert.equal(applied.trackTitle, "Current song");
  assert.equal(applied.trackArtist, "Current artist");
  assert.throws(() => presetStyle({ ...settings, sensitivity: Infinity }), /invalid/);
});

test("Edge Bars leave room for a fitted center logo even at maximum scale and glow", () => {
  for (const [w, h] of [
    [1280, 720],
    [720, 1280],
    [1080, 1080],
  ]) {
    const short = Math.min(w, h),
      clear = short * 0.085 + 2.5 * 16,
      layout = edgeBarLayout(w, h, 1.5, 2.5, clear);
    assert.ok(layout.maxHeight + clear + layout.margin <= h / 2 + 1e-8);
  }
});

test("resolution presets retain aspect ratio, short edge and even encoder dimensions", () => {
  const { EXPORT_RESOLUTIONS, exportDimensions } = modules["export-settings"];
  assert.deepEqual(EXPORT_RESOLUTIONS, [480, 720, 1080, 1440]);
  for (const resolution of EXPORT_RESOLUTIONS) {
    for (const format of ["landscape", "portrait", "square"]) {
      const { width, height } = exportDimensions(format, resolution);
      assert.equal(Math.min(width, height), resolution);
      assert.equal(width % 2, 0);
      assert.equal(height % 2, 0);
      assert.ok(
        Math.abs(
          width / height - (format === "landscape" ? 16 / 9 : format === "portrait" ? 9 / 16 : 1),
        ) < 0.003,
      );
    }
  }
  assert.throws(() => exportDimensions("landscape", 540), /Unsupported/);
});
test("new export defaults and legacy ZIP settings do not opt users into lossy encoding", async () => {
  const { DEFAULT_EXPORT_FRAME_RATE, DEFAULT_EXPORT_RESOLUTION, EXPORT_RESOLUTIONS } =
    modules["export-settings"];
  const { makeProjectFile, readProjectFile } = modules["project-file"];
  const media = new File(["media"], "song.wav", { type: "audio/wav" });
  const blob = makeProjectFile({
    settings,
    media,
    logo: null,
    background: null,
    format: "landscape",
    range: [0, 1],
    subtitles: [],
  });
  const opened = await readProjectFile(new File([blob], "project.pulseframe"));
  assert.equal(opened.videoCompression, false);
  assert.equal(opened.resolution, DEFAULT_EXPORT_RESOLUTION);
  assert.equal(opened.frameRate, DEFAULT_EXPORT_FRAME_RATE);
  const bytes = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const length = new DataView(bytes.buffer).getUint32(4, true);
  const manifest = JSON.parse(await blob.slice(8, 8 + length).text());
  delete manifest.videoCompression;
  delete manifest.resolution;
  manifest.profile = "smaller";
  manifest.losslessCompression = true;
  const data = new TextEncoder().encode(JSON.stringify(manifest));
  new DataView(bytes.buffer).setUint32(4, data.length, true);
  const legacy = await readProjectFile(new File([bytes, data, media], "old.pulseframe"));
  assert.equal(legacy.videoCompression, false);
  assert.equal(legacy.resolution, 480);
  for (const resolution of EXPORT_RESOLUTIONS) {
    const restored = await readProjectFile(
      new File(
        [makeProjectFile({ ...opened, resolution, videoCompression: true })],
        "settings.pulseframe",
      ),
    );
    assert.equal(restored.resolution, resolution);
    assert.equal(restored.videoCompression, true);
  }
});

test("project subtitle validation follows the shared cue and text limits", async () => {
  const { MAX_SUBTITLE_CUES, MAX_SUBTITLE_TEXT_LENGTH } = modules.subtitles;
  const { makeProjectFile, readProjectFile } = modules["project-file"];
  const media = new File(["media"], "song.wav", { type: "audio/wav" });
  const content = {
    settings,
    media,
    logo: null,
    background: null,
    format: "landscape",
    range: [0, 1],
  };
  const acceptedCues = Array.from({ length: MAX_SUBTITLE_CUES }, (_, index) => ({
    id: `cue-${index}`,
    start: 0,
    end: 1,
    text: "x".repeat(index === 0 ? MAX_SUBTITLE_TEXT_LENGTH : 1),
  }));
  const accepted = makeProjectFile({ ...content, subtitles: acceptedCues });
  await assert.doesNotReject(() => readProjectFile(new File([accepted], "valid.pulseframe")));

  const tooMany = makeProjectFile({
    ...content,
    subtitles: [...acceptedCues, { id: "extra", start: 0, end: 1, text: "x" }],
  });
  await assert.rejects(readProjectFile(new File([tooMany], "too-many.pulseframe")));

  const tooLong = makeProjectFile({
    ...content,
    subtitles: [{ id: "long", start: 0, end: 1, text: "x".repeat(MAX_SUBTITLE_TEXT_LENGTH + 1) }],
  });
  await assert.rejects(readProjectFile(new File([tooLong], "too-long.pulseframe")));
});
