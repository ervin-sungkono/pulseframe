import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("bounded local audio preparation preserves resampling, cancellation, and duration limits", async (t) => {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });

  try {
    const audio = await vite.ssrLoadModule("/lib/lyrics/audio.ts");
    const policy = await vite.ssrLoadModule("/lib/lyrics/policy.ts");
    const protocol = await vite.ssrLoadModule("/lib/lyrics/worker-protocol.ts");

    await t.test("bounded slices match full-track FIR output at every boundary", async () => {
      const length = 150_123;
      const left = Float32Array.from({ length }, (_, index) => Math.sin(index * 0.013) * 0.7);
      const right = Float32Array.from({ length }, (_, index) => Math.cos(index * 0.009) * 0.4);
      let maxSliceLength = 0;
      let sliceCount = 0;
      const expected = await audio.resampleMono16k([left, right], 44_100);
      const actual = await audio.resampleMono16kFromSlices(length, 44_100, async (offset, size) => {
        sliceCount += 1;
        maxSliceLength = Math.max(maxSliceLength, size);
        return [
          left.subarray(offset, offset + size).slice(),
          right.subarray(offset, offset + size).slice(),
        ];
      });

      assert.deepEqual(actual, expected);
      assert.ok(sliceCount > 2);
      assert.ok(maxSliceLength <= protocol.LOCAL_AUDIO_SLICE_SAMPLES);
      assert.equal(left.byteLength, length * Float32Array.BYTES_PER_ELEMENT);
      assert.equal(right.byteLength, length * Float32Array.BYTES_PER_ELEMENT);
    });

    await t.test("bounded resampling preserves digital silence", async () => {
      const source = new Float32Array(140_000);
      const waveform = await audio.resampleMono16kFromSlices(
        source.length,
        44_100,
        async (offset, size) => [source.subarray(offset, offset + size).slice()],
      );
      assert.ok(waveform.every((sample) => sample === 0));
    });

    await t.test("cancellation stops before requesting another source slice", async () => {
      const controller = new AbortController();
      let requests = 0;
      await assert.rejects(
        audio.resampleMono16kFromSlices(
          140_000,
          8_000,
          async (_offset, size) => {
            requests += 1;
            return [new Float32Array(size)];
          },
          controller.signal,
          (completed) => {
            if (completed > 0) controller.abort();
          },
        ),
        { name: "AbortError" },
      );
      assert.equal(requests, 1);
    });

    await t.test("the ten-minute limit is inclusive and rejects any longer track", () => {
      const common = {
        fileBytes: 1,
        sampleRate: 16_000,
        sampleCount: 9_600_000,
        channelCount: 1,
        retainedBytes: 38_400_000,
        deviceMemoryGiB: 16,
        maxMemoryBytes: 2 * 1024 * 1024 * 1024,
        method: "local",
        isolation: false,
        model: "tiny",
      };
      assert.equal(policy.assessLyricsInput({ ...common, durationMs: 600_000 }).admitted, true);
      const tooLong = policy.assessLyricsInput({ ...common, durationMs: 600_001 });
      assert.equal(tooLong.admitted, false);
      assert.equal(tooLong.reason, "Automatic subtitles support tracks up to ten minutes.");
    });

    await t.test("local admission counts bounded slices instead of a full-rate worker copy", () => {
      const durationMs = 600_000;
      const sampleRate = 384_000;
      const channelCount = 2;
      const retainedBytes =
        (durationMs / 1000) * sampleRate * channelCount * Float32Array.BYTES_PER_ELEMENT;
      const input = {
        fileBytes: 1,
        durationMs,
        sampleRate,
        sampleCount: (durationMs / 1000) * sampleRate,
        channelCount,
        retainedBytes,
        deviceMemoryGiB: 16,
        maxMemoryBytes: 4 * 1024 * 1024 * 1024,
        method: "local",
        isolation: false,
        model: "tiny",
      };
      const admission = policy.assessLyricsInput(input);
      assert.equal(admission.admitted, true);
      assert.ok(admission.estimatedPeakBytes - retainedBytes < 500 * 1024 * 1024);

      const isolationAdmission = policy.assessLyricsInput({ ...input, isolation: true });
      const fullSourceCopy = retainedBytes;
      const mdxStereo = (durationMs / 1000) * 44_100 * 2 * Float32Array.BYTES_PER_ELEMENT;
      assert.ok(
        isolationAdmission.estimatedPeakBytes >= retainedBytes + fullSourceCopy + mdxStereo,
      );
    });
  } finally {
    await vite.close();
  }
});
