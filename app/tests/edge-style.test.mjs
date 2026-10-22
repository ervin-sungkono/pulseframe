import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./load-source.mjs";

const sources = await loadSources();
const { edgeBars } = sources["edge-bars"];
const { DEFAULT_SETTINGS } = sources["customizer-config"];

test("edge gradients span each visible bar and expose the accent at quiet and loud levels", () => {
  for (const level of [0, 0.02, 0.3, 1]) {
    const gradients = [];
    const bars = [];
    const stack = [];
    const ctx = {
      frame: null,
      save() {
        stack.push(this.frame);
      },
      restore() {
        this.frame = stack.pop();
      },
      transform(a, b, c, d, e, f) {
        assert.deepEqual([a, b, c], [1, 0, 0]);
        this.frame = { scale: d, x: e, y: f };
      },
      beginPath() {},
      createLinearGradient(...coordinates) {
        const gradient = {
          coordinates,
          stops: [],
          addColorStop(...stop) {
            this.stops.push(stop);
          },
        };
        gradients.push(gradient);
        return gradient;
      },
      roundRect(x, y, width, height, corner) {
        assert.equal(this.frame, null, "construct geometry before scaling the paint");
        assert.ok(corner <= Math.min(width, height) / 2);
        bars.push({ x, y, width, height });
      },
      fill() {
        assert.equal(this.fillStyle, gradients.at(-1));
        const bar = bars.at(-1);
        assert.equal(Math.abs(this.frame.scale), bar.height);
        assert.equal(this.frame.x, 0);
        assert.equal(this.frame.y, this.frame.scale > 0 ? 0 : 720);
      },
    };
    edgeBars.draw(
      ctx,
      {
        width: 1280,
        height: 720,
        audio: { bands: [new Float32Array(96).fill(level)] },
        fittedLogo: false,
      },
      DEFAULT_SETTINGS,
    );
    assert.ok(bars.length > 2 && bars.length % 2 === 0);
    assert.equal(gradients.length, 1, "all bars reuse a single normalized gradient");
    assert.equal(stack.length, 0);
    const { coordinates, stops } = gradients[0];
    assert.deepEqual(coordinates, [0, 0, 0, 1]);
    assert.deepEqual(stops, [
      [0, DEFAULT_SETTINGS.primary],
      [0.5, DEFAULT_SETTINGS.primary],
      [1, DEFAULT_SETTINGS.secondary],
    ]);
    const accentCoverage = 1 - stops[2][0] + (stops[2][0] - stops[1][0]) / 2;
    assert.ok(Math.abs(accentCoverage - 0.25) < 1e-8, "smooth blend retains 75:25 color coverage");
    for (let i = 0; i < bars.length; i++) {
      const top = i < bars.length / 2;
      assert.equal(bars[i].y, top ? 0 : 720 - bars[i].height);
      assert.ok(bars[i].height >= 3 && bars[i].height <= 720 * 0.38);
    }
  }
});
