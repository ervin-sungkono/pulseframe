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
    origin: "http://localhost",
    "sec-fetch-site": "same-origin",
    "x-goog-api-key": "session-key-for-test",
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
    root: fileURLToPath(new URL("../..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });

  try {
    const { lyricsDevApi } = await vite.ssrLoadModule("/src/lib/lyrics/dev-api.ts");
    const {
      GEMINI_MAX_REQUEST_BYTES,
      GEMINI_MAX_WAV_BYTES,
      GEMINI_SAMPLE_RATE,
      GEMINI_AUDIO_CHUNK_MS,
      geminiTranscriptionRequestSchema,
    } = await vite.ssrLoadModule("/src/lib/lyrics/gemini-contract.ts");

    let middleware;
    let routeCalls = 0;
    let receivedPayload;
    let receivedHeaders;
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
            receivedHeaders = request.headers;
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
    assert.equal(receivedHeaders.get("origin"), "http://localhost");
    assert.equal(receivedHeaders.get("sec-fetch-site"), "same-origin");
    assert.equal(receivedHeaders.get("x-goog-api-key"), "session-key-for-test");
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

    let timeoutMiddleware;
    lyricsDevApi({ bodyReadTimeoutMs: 10 }).configureServer({
      middlewares: {
        use(_path, handler) {
          timeoutMiddleware = handler;
        },
      },
      ssrLoadModule: async () => {
        throw new Error("a timed-out body must not load the route");
      },
    });
    const hangingIncoming = new Readable({ read() {} });
    hangingIncoming.method = "POST";
    hangingIncoming.headers = {
      host: "localhost",
      "content-type": "application/json",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      "x-goog-api-key": "session-key-for-test",
    };
    const timeoutOutgoing = createOutgoing();
    await timeoutMiddleware(hangingIncoming, timeoutOutgoing);
    assert.equal(timeoutOutgoing.statusCode, 408);
    assert.deepEqual(JSON.parse(timeoutOutgoing.body.toString("utf8")), {
      error: {
        code: "invalid_request",
        message: "This audio request timed out while being received.",
        retryable: false,
      },
      providerAttempts: 0,
    });
  } finally {
    await vite.close();
  }
});
