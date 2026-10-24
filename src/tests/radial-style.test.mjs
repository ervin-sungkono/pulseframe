import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./load-source.mjs";
import { generateTestTone } from "../lib/audio/audio-dsp.mjs";

const sources = await loadSources();
const { buildRadialSpectrumGeometry, radialFrequencyPosition, radialSpectrumAperture } =
  sources["radial-spectrum"];
const { DEFAULT_RADIAL_OPTIONS } = sources["style-options"];
const { PcmFeatures } = sources["pcm-features"];

const SAMPLE_RATE = 48_000;

function makeInput(overrides = {}) {
  return {
    width: 1200,
    height: 800,
    time: 0,
    reducedMotion: false,
    bands: [new Float32Array(96)],
    sensitivity: 1.3,
    visualScale: 1.1,
    glow: 0.95,
    ...overrides,
  };
}

function geometry(input = makeInput(), options = DEFAULT_RADIAL_OPTIONS) {
  return buildRadialSpectrumGeometry(input, options);
}

function toneBands(frequency) {
  const [pcm] = generateTestTone(SAMPLE_RATE, 1, frequency, 0.6);
  const analyzer = new PcmFeatures([pcm], SAMPLE_RATE, 0, "js");
  try {
    return analyzer.at(0.5, false).bands.map((channel) => channel.slice());
  } finally {
    analyzer.dispose();
  }
}

function assertFiniteGeometry(result) {
  assert.ok(Number.isFinite(result.centerX));
  assert.ok(Number.isFinite(result.centerY));
  assert.ok(Number.isFinite(result.innerRadius));
  assert.ok(Number.isFinite(result.maxBarLength));
  assert.ok(Number.isFinite(result.maxOuterRadius));
  assert.ok(Number.isFinite(result.rotation));
  for (const bar of result.bars) {
    for (const value of Object.values(bar)) assert.ok(Number.isFinite(value), `${value} is finite`);
  }
}

test("maximum radial options stay inside the circular envelope at every aspect ratio", () => {
  const options = {
    ...DEFAULT_RADIAL_OPTIONS,
    barCount: 160,
    innerRadius: 40,
    maxBarLength: 35,
    barWidth: 100,
    roundness: 100,
  };
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1920],
    [1000, 1000],
    [260, 1300],
  ]) {
    for (const variant of ["outward", "inward", "both"]) {
      const result = geometry(
        makeInput({
          width,
          height,
          glow: 2.5,
          visualScale: 1.5,
          bands: [new Float32Array(96).fill(1)],
        }),
        { ...options, variant },
      );
      const shortEdge = Math.min(width, height);
      assert.equal(result.bars.length, 160);
      assertFiniteGeometry(result);
      assert.ok(result.maxOuterRadius <= shortEdge * 0.44 + 1e-7);
      assert.ok(result.maxOuterRadius + result.glowPadding <= result.availableRadius + 1e-7);
      assert.ok(result.bars.every((bar) => bar.startRadius >= result.innerRadius - 1e-7));
      assert.ok(
        result.bars.every(
          (bar) => bar.endRadius <= result.innerRadius + result.maxBarLength + 1e-7,
        ),
      );
    }
  }
});

test("logo aperture helper matches full geometry without requiring audio bands", () => {
  const options = { ...DEFAULT_RADIAL_OPTIONS, innerRadius: 38, maxBarLength: 35, barCount: 160 };
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1920],
    [1000, 1000],
  ]) {
    const input = { width, height, visualScale: 1.5, glow: 2.5 };
    const fullGeometry = geometry(
      makeInput({ ...input, time: 0, reducedMotion: true, bands: [], sensitivity: 1 }),
      options,
    );
    assert.equal(radialSpectrumAperture(input, options), fullGeometry.innerRadius);
  }
});

test("clockwise bars follow log-band order and mirrored bars pair symmetrically", () => {
  const count = 96;
  const clockwise = Array.from({ length: count }, (_, index) =>
    radialFrequencyPosition(index, count, "clockwise"),
  );
  const mirrored = Array.from({ length: count }, (_, index) =>
    radialFrequencyPosition(index, count, "mirrored"),
  );
  assert.ok(clockwise.every((value, index) => index === 0 || value > clockwise[index - 1]));
  assert.ok(
    mirrored.every((value, index) => Math.abs(value - mirrored[count - index - 1]) < 1e-12),
  );
  assert.ok(mirrored[count / 2 - 1] > 0.98);
  assert.ok(mirrored[0] < 0.02);

  const bands = [Float32Array.from({ length: 96 }, (_, index) => index / 95)];
  const result = geometry(makeInput({ bands }), {
    ...DEFAULT_RADIAL_OPTIONS,
    barCount: count,
    direction: "mirrored",
  });
  assert.ok(result.bars.every((bar, index) => Math.abs(bar.frequency - mirrored[index]) < 1e-12));
  assert.ok(
    result.bars.every(
      (bar, index) => Math.abs(bar.amplitude - result.bars[count - index - 1].amplitude) < 1e-12,
    ),
  );
});

test("actual 32 Hz and 4 kHz PCM tones activate their own radial log-frequency regions", () => {
  const lowBands = toneBands(32);
  const highBands = toneBands(4000);
  const options = { ...DEFAULT_RADIAL_OPTIONS, direction: "clockwise" };
  const low = geometry(makeInput({ bands: lowBands }), options);
  const high = geometry(makeInput({ bands: highBands }), options);
  const peakFrequency = (result) =>
    result.bars.reduce((peak, bar) => (bar.amplitude > peak.amplitude ? bar : peak)).frequency;
  const lowPeak = peakFrequency(low);
  const highPeak = peakFrequency(high);
  assert.ok(lowPeak < 0.12, `32 Hz peak should be near the bass end, got ${lowPeak}`);
  assert.ok(
    highPeak > 0.65 && highPeak < 0.95,
    `4 kHz peak should be high in the log range, got ${highPeak}`,
  );
  assert.ok(highPeak - lowPeak > 0.55);
});

test("silence produces finite, motionless idle bars with a preserved center aperture", () => {
  const shortEdge = 800;
  const result = geometry(
    makeInput({
      width: shortEdge,
      height: 1100,
      bands: [new Float32Array(96), new Float32Array(96)],
    }),
    { ...DEFAULT_RADIAL_OPTIONS, variant: "inward", maxBarLength: 35 },
  );
  assertFiniteGeometry(result);
  assert.ok(result.innerRadius > 0);
  assert.ok(result.bars.every((bar) => bar.amplitude === 0));
  assert.ok(result.bars.every((bar) => bar.length > 0));
  assert.ok(result.bars.every((bar) => bar.startRadius >= result.innerRadius));
  assert.ok(result.bars.every((bar) => bar.endRadius <= result.innerRadius + result.maxBarLength));
});

test("bar roundness uses the full 0–100 percentage range", () => {
  const input = makeInput({ bands: [new Float32Array(96).fill(1)] });
  const radiusFor = (roundness) =>
    geometry(input, { ...DEFAULT_RADIAL_OPTIONS, roundness }).bars[0].cornerRadius;
  const maximum = Math.min(
    geometry(input, { ...DEFAULT_RADIAL_OPTIONS, roundness: 100 }).bars[0].thickness / 2,
    geometry(input, { ...DEFAULT_RADIAL_OPTIONS, roundness: 100 }).bars[0].length / 2,
  );
  assert.equal(radiusFor(0), 0);
  assert.ok(Math.abs(radiusFor(80) - maximum * 0.8) < 1e-12);
  assert.ok(Math.abs(radiusFor(100) - maximum) < 1e-12);
});

test("rotation is absolute-time deterministic at 24, 30, and 60 fps and freezes for reduced motion", () => {
  const options = { ...DEFAULT_RADIAL_OPTIONS, rotationSpeed: 100 };
  const atTwoSeconds = [24, 30, 60].map((fps) => {
    const frames = 2 * fps;
    return geometry(makeInput({ time: frames / fps }), options);
  });
  assert.equal(atTwoSeconds[0].rotation, atTwoSeconds[1].rotation);
  assert.equal(atTwoSeconds[1].rotation, atTwoSeconds[2].rotation);
  assert.equal(atTwoSeconds[0].rotation, (2 * Math.PI) / 30);
  assert.ok(
    atTwoSeconds[0].bars.every((bar, index) => bar.angle === atTwoSeconds[1].bars[index].angle),
  );

  const reduced = geometry(makeInput({ time: 123, reducedMotion: true }), options);
  assert.equal(reduced.rotation, 0);
  assert.equal(reduced.bars[0].angle, -Math.PI / 2);

  for (const time of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
    const extreme = geometry(makeInput({ time }), options);
    assertFiniteGeometry(extreme);
    assert.ok(Math.abs(extreme.rotation) < Math.PI * 2);
  }
});
