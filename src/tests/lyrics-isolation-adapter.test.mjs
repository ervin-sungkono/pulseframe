import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

test("Gemini Quality can use the existing subtitle worker without detaching source audio", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pulseframe-isolation-"));
  const originalWorker = globalThis.Worker;
  const workers = [];
  let transferredBuffers = [];
  class FakeWorker {
    listeners = new Map();
    terminated = false;
    constructor(url) {
      assert.match(url.href, /processing\.worker\.ts$/);
      workers.push(this);
    }
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }
    removeEventListener(name) {
      this.listeners.delete(name);
    }
    terminate() {
      this.terminated = true;
    }
    emit(message) {
      queueMicrotask(() => this.listeners.get("message")?.({ data: message }));
    }
    postMessage(message, transfer = []) {
      if (message.type === "start") {
        assert.equal(message.isolationOnly, true);
        assert.equal(message.preset, "quality");
        this.emit({ type: "need-audio", jobId: message.jobId, offset: 0, length: 4 });
      } else if (message.type === "audio-slice") {
        assert.equal(message.channels[0].length, 4);
        transferredBuffers = transfer;
        this.emit({
          type: "isolated",
          jobId: message.jobId,
          channels: [new Float32Array([0.2, 0.3, 0.4, 0.5])],
          sampleRate: 16_000,
          backend: "wasm",
          notices: [],
        });
      }
    }
  }
  globalThis.Worker = FakeWorker;
  try {
    const source = readFileSync(new URL("../lib/lyrics/local-client.ts", import.meta.url), "utf8");
    const output = ts
      .transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      })
      .outputText.replace('./worker-protocol"', './worker-protocol.mjs"');
    writeFileSync(
      join(directory, "worker-protocol.mjs"),
      "export const LOCAL_AUDIO_SLICE_SAMPLES = 65536;",
    );
    const path = join(directory, "local-client.mjs");
    writeFileSync(path, output);
    const { createLocalLyricsAdapter } = await import(pathToFileURL(path).href);
    const adapter = createLocalLyricsAdapter();
    const sourceChannel = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const result = await adapter.isolate(
      { channels: [sourceChannel], sampleRate: 16_000, durationMs: 0.25, retainedBytes: 16 },
      {
        preset: "quality",
        sourceId: "track",
        signal: new AbortController().signal,
        onProgress() {},
      },
    );
    assert.equal(result.backend, "wasm");
    assert.equal(result.sampleRate, 16_000);
    assert.equal(result.channels.length, 1);
    assert.equal(result.channels[0][0], new Float32Array([0.2])[0]);
    assert.equal(sourceChannel.byteLength, 16);
    assert.equal(transferredBuffers.length, 1);
    assert.notEqual(transferredBuffers[0], sourceChannel.buffer);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminated, true);
    adapter.dispose();
  } finally {
    globalThis.Worker = originalWorker;
    rmSync(directory, { recursive: true, force: true });
  }
});
