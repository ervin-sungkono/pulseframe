import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

function makeWav(sampleRate, durationMs, byteLength) {
  const wav = Buffer.alloc(byteLength);
  const dataBytes = byteLength - 44;
  wav.write("RIFF", 0);
  wav.writeUInt32LE(byteLength - 8, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  assert.equal((dataBytes / 2 / sampleRate) * 1000, durationMs);
  return wav;
}

function createIncoming(body) {
  const incoming = Readable.from([body]);
  incoming.method = "POST";
  incoming.headers = {
    host: "localhost",
    "content-type": "application/json",
    "content-length": String(body.length),
  };
  return incoming;
}

function createOutgoing() {
  const outgoing = new EventEmitter();
  outgoing.headersSent = false;
  outgoing.writableFinished = false;
  outgoing.writeHead = (statusCode, headers) => {
    outgoing.statusCode = statusCode;
    outgoing.headers = headers;
    outgoing.headersSent = true;
    return outgoing;
  };
  outgoing.end = (body) => {
    outgoing.body = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
    outgoing.writableFinished = true;
  };
  return outgoing;
}

async function invoke(middleware, body) {
  const outgoing = createOutgoing();
  await middleware(createIncoming(body), outgoing);
  return {
    status: outgoing.statusCode,
    headers: outgoing.headers,
    body: JSON.parse(outgoing.body.toString("utf8")),
  };
}

test("lyrics dev API accepts 100-second requests and matches canonical error responses", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });

  try {
    const { lyricsDevApi } = await vite.ssrLoadModule("/lyrics-dev-api.ts");
    const {
      GEMINI_MAX_REQUEST_BYTES,
      GEMINI_MAX_WAV_BYTES,
      GEMINI_SAMPLE_RATE,
      GEMINI_AUDIO_CHUNK_MS,
      geminiTranscriptionRequestSchema,
    } = await vite.ssrLoadModule("/lib/lyrics/gemini-contract.ts");

    let middleware;
    let routeCalls = 0;
    let receivedPayload;
    lyricsDevApi().configureServer({
      middlewares: {
        use(path, handler) {
          assert.equal(path, "/api/lyrics/transcribe");
          middleware = handler;
        },
      },
      ssrLoadModule: async () => ({
        default: {
          fetch: async (request) => {
            routeCalls += 1;
            receivedPayload = await request.json();
            return Response.json({ ok: true });
          },
        },
      }),
    });

    const wav = makeWav(GEMINI_SAMPLE_RATE, GEMINI_AUDIO_CHUNK_MS, GEMINI_MAX_WAV_BYTES);
    const payload = Buffer.from(
      JSON.stringify({
        chunkIndex: 0,
        totalChunks: 1,
        chunkStartMs: 0,
        chunkDurationMs: GEMINI_AUDIO_CHUNK_MS,
        sourceDurationMs: GEMINI_AUDIO_CHUNK_MS,
        preset: "fast",
        recheck: false,
        languageCode: "",
        audioBase64: wav.toString("base64"),
      }),
    );
    assert.ok(payload.length > 4_100_000, "request must exceed the former dev-only cap");
    assert.ok(payload.length < GEMINI_MAX_REQUEST_BYTES);
    const parsedPayload = geminiTranscriptionRequestSchema.safeParse(
      JSON.parse(payload.toString()),
    );
    assert.equal(
      parsedPayload.success,
      true,
      parsedPayload.success ? "" : JSON.stringify(parsedPayload.error.issues),
    );

    const accepted = await invoke(middleware, payload);
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, { ok: true });
    assert.equal(routeCalls, 1);
    assert.equal(geminiTranscriptionRequestSchema.safeParse(receivedPayload).success, true);
    assert.equal(receivedPayload.audioBase64.length, wav.toString("base64").length);

    const tooLarge = await invoke(middleware, Buffer.alloc(GEMINI_MAX_REQUEST_BYTES + 1));
    assert.equal(routeCalls, 1, "oversized requests must be rejected before loading the route");
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(tooLarge.body, {
      error: {
        code: "invalid_request",
        message: "This audio request is too large.",
        retryable: false,
      },
      providerAttempts: 0,
    });
    assert.equal(tooLarge.headers["Cache-Control"], "no-store, max-age=0");

    let failedMiddleware;
    lyricsDevApi().configureServer({
      middlewares: {
        use(_path, handler) {
          failedMiddleware = handler;
        },
      },
      ssrLoadModule: async () => {
        throw new Error("route load failed");
      },
    });
    const failed = await invoke(failedMiddleware, Buffer.from("{}"));
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, {
      error: {
        code: "server_error",
        message: "The Gemini request could not be processed.",
      },
      providerAttempts: 0,
    });
    assert.equal(failed.headers["Cache-Control"], "no-store, max-age=0");
  } finally {
    await vite.close();
  }
});
