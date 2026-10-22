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
    const ctx = {
      save() {},
      restore() {},
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
      roundRect(x, y, width, height) {
        bars.push({ x, y, width, height });
      },
      fill() {
        assert.equal(this.fillStyle, gradients.at(-1));
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
    assert.equal(gradients.length, bars.length);
    for (let i = 0; i < bars.length; i++) {
      const top = i < bars.length / 2;
      const { coordinates, stops } = gradients[i];
      assert.deepEqual(coordinates, [0, top ? 0 : 720, 0, top ? bars[i].height : bars[i].y]);
      assert.deepEqual(stops, [
        [0, DEFAULT_SETTINGS.primary],
        [0.55, DEFAULT_SETTINGS.secondary],
        [1, DEFAULT_SETTINGS.secondary],
      ]);
      assert.ok(bars[i].height >= 3 && bars[i].height <= 720 * 0.38);
    }
  }
});
