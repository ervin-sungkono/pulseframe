import assert from "node:assert/strict";
import test from "node:test";

import { loadSources } from "./load-source.mjs";

const modules = await loadSources();
const { PcmFeatures, findDropEvents, prepareSound } = modules["audio-features"];

class TestAudioBuffer {
  constructor(sampleRate, channels) {
    this.sampleRate = sampleRate;
    this.numberOfChannels = channels.length;
    this.length = channels[0]?.length ?? 0;
    this.duration = this.length / sampleRate;
    this.channels = channels;
  }

  getChannelData(index) {
    return this.channels[index];
  }
}

class FakeWorker {
  static instances = [];
  static mode = "success";

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.messages = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(message, transfer = []) {
    this.messages.push({ message, transfer });
    if (message.type === "start") {
      this.retain = message.retain;
      if (FakeWorker.mode !== "no-ready") {
        queueMicrotask(() =>
          this.emit({
            type: "ready",
            generation: message.generation,
            jobId: message.jobId,
            protocolVersion: message.protocolVersion,
            featureSchemaVersion: message.featureSchemaVersion,
            backend: "js",
          }),
        );
      }
      return;
    }
    if (message.type === "cancel") return;
    if (message.type !== "chunk") return;

    const workerMessage = message;
    const emitChunk = () => {
      const firstCount = FakeWorker.mode === "fail-after-batch" ? 1 : 15;
      let frameStart = workerMessage.frameStart;
      let batchCount = Math.min(firstCount, workerMessage.frameEnd - frameStart);
      const eventFrames = [frameStart].filter((frame) => frame % 60 === 0);
      const response = {
        type: "batch",
        generation: workerMessage.generation,
        jobId: workerMessage.jobId,
        frameStart,
        frameCount: batchCount,
        eventFrames,
      };
      if (FakeWorker.mode === "fail-after-batch") {
        const metrics = new Float64Array(batchCount * 7).fill(123456);
        const bands = new Float32Array(batchCount * workerMessage.samples.length * 96).fill(0.75);
        response.metrics = metrics.buffer;
        response.bands = bands.buffer;
        this.emit(response);
        queueMicrotask(() => this.onerror?.({ message: "simulated worker crash" }));
        return;
      }

      while (frameStart < workerMessage.frameEnd) {
        batchCount = Math.min(15, workerMessage.frameEnd - frameStart);
        const batch = {
          ...response,
          frameStart,
          frameCount: batchCount,
          eventFrames: frameStart % 60 === 0 ? [frameStart] : [],
        };
        if (this.retain) {
          const metrics = new Float64Array(batchCount * 7);
          for (let local = 0; local < batchCount; local += 1) {
            const frame = frameStart + local;
            metrics.set(
              [frame + 1, frame + 2, frame + 3, frame + 4, frame + 5, frame + 6, frame + 7],
              local * 7,
            );
          }
          const bandValues = new Float32Array(batchCount * workerMessage.samples.length * 96);
          for (let local = 0; local < batchCount; local += 1) {
            for (let channel = 0; channel < workerMessage.samples.length; channel += 1) {
              bandValues.fill(
                channel + (frameStart + local) / 1000,
                (local * workerMessage.samples.length + channel) * 96,
                (local * workerMessage.samples.length + channel + 1) * 96,
              );
            }
          }
          batch.metrics = metrics.buffer;
          batch.bands = bandValues.buffer;
        }
        this.emit(batch);
        frameStart += batchCount;
      }
      this.emit({
        type: "chunk-done",
        generation: workerMessage.generation,
        jobId: workerMessage.jobId,
        nextFrame: workerMessage.frameEnd,
      });
    };
    queueMicrotask(emitChunk);
  }

  emit(data) {
    this.onmessage?.({ data });
  }
  terminate() {
    this.terminated = true;
  }
}

function withFakeWorker(mode, action) {
  const original = globalThis.Worker;
  FakeWorker.instances = [];
  FakeWorker.mode = mode;
  globalThis.Worker = FakeWorker;
  return Promise.resolve()
    .then(action)
    .finally(() => {
      if (original === undefined) delete globalThis.Worker;
      else globalThis.Worker = original;
    });
}

test("prepared scans transfer only bounded PCM copies and keep AudioBuffer channel data attached", async () => {
  await withFakeWorker("success", async () => {
    const sampleRate = 48_000;
    const channels = [
      new Float32Array(sampleRate * 8).fill(0.1),
      new Float32Array(sampleRate * 8).fill(-0.1),
    ];
    const originalBuffers = channels.map((channel) => channel.buffer);
    const events = await findDropEvents(channels, sampleRate);
    const worker = FakeWorker.instances[0];
    const chunks = worker.messages.filter((item) => item.message.type === "chunk");

    assert.equal(chunks.length, 3);
    assert.deepEqual(events, [0, 2, 4, 6]);
    for (const { message, transfer } of chunks) {
      assert.equal(message.samples.length, 2);
      assert.equal(transfer.length, 2);
      assert.ok(message.samples.every((buffer, index) => buffer !== originalBuffers[index]));
      assert.ok(
        message.samples.every(
          (buffer) => buffer.byteLength <= (sampleRate * 3 + 4096) * Float32Array.BYTES_PER_ELEMENT,
        ),
      );
      assert.ok(transfer.every((buffer) => message.samples.includes(buffer)));
    }
    assert.ok(
      originalBuffers.every(
        (buffer) => buffer.byteLength === sampleRate * 8 * Float32Array.BYTES_PER_ELEMENT,
      ),
    );
    assert.equal(worker.options.type, "module");
    assert.equal(worker.terminated, true);
  });
});

test("prepared scan keeps returned envelope storage and exact 30 Hz frame positions", async () => {
  await withFakeWorker("success", async () => {
    const sampleRate = 24_000;
    const audio = new TestAudioBuffer(sampleRate, [
      new Float32Array(sampleRate),
      new Float32Array(sampleRate),
    ]);
    const prepared = await prepareSound(audio);

    assert.equal(prepared.envelopes.length, 30);
    assert.equal(prepared.envelopes[0].rms, 1);
    assert.equal(prepared.envelopes[29].highDb, 36);
    assert.equal(prepared.envelopes[17].bands[0].length, 96);
    assert.equal(prepared.envelopes[17].bands[1].length, 96);
    assert.ok(prepared.envelopes[17].bands[0].every((value) => Math.abs(value - 17 / 1000) < 1e-7));
    assert.ok(
      prepared.envelopes[17].bands[1].every((value) => Math.abs(value - (1 + 17 / 1000)) < 1e-7),
    );
    assert.equal(prepared.audio, audio);
  });
});

test("chunk overlap grows enough to preserve the recent RMS window at high sample rates", async () => {
  await withFakeWorker("success", async () => {
    const sampleRate = 384_000;
    const samples = new Float32Array(sampleRate * 3);
    await findDropEvents([samples], sampleRate);
    const chunks = FakeWorker.instances[0].messages.filter((item) => item.message.type === "chunk");

    assert.equal(chunks.length, 2);
    assert.equal(
      chunks[1].message.sourceOffsetSamples,
      sampleRate * 2 - Math.round(sampleRate * 0.02),
    );
    assert.equal(
      chunks[1].message.samples[0].byteLength,
      (sampleRate + Math.round(sampleRate * 0.02)) * Float32Array.BYTES_PER_ELEMENT,
    );
  });
});

test("a worker failure discards partial output and restarts the entire scan on JS", async () => {
  await withFakeWorker("fail-after-batch", async () => {
    const sampleRate = 48_000;
    const audio = new TestAudioBuffer(sampleRate, [new Float32Array(4_800).fill(0.15)]);
    const expected = new PcmFeatures(audio.channels, sampleRate).at(0, false);
    const prepared = await prepareSound(audio);

    assert.equal(prepared.envelopes.length, 3);
    assert.notEqual(prepared.envelopes[0].rms, 123456);
    assert.equal(prepared.envelopes[0].rms, expected.rms);
    assert.equal(FakeWorker.instances[0].terminated, true);
  });
});

test("abort rejects a pending worker initialization and terminates its job", async () => {
  await withFakeWorker("no-ready", async () => {
    const sampleRate = 24_000;
    const audio = new TestAudioBuffer(sampleRate, [new Float32Array(sampleRate)]);
    const controller = new AbortController();
    const pending = prepareSound(audio, controller.signal);
    const worker = FakeWorker.instances[0];
    controller.abort();

    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(worker.terminated, true);
    assert.ok(worker.messages.some(({ message }) => message.type === "cancel"));
  });
});
