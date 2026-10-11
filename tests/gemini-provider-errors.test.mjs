import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = mkdtempSync(join(tmpdir(), "pulseframe-gemini-"));
const require = createRequire(import.meta.url);
for (const name of [
  "subtitles",
  "lyrics/mdx-config",
  "lyrics/policy",
  "lyrics/gemini-languages",
  "lyrics/gemini-contract",
  "lyrics/gemini-server",
]) {
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const output = ts
    .transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.replaceAll('.js"', '.mjs"')
    .replace('from "zod"', `from "${pathToFileURL(require.resolve("zod")).href}"`);
  const target = join(directory, `${name}.mjs`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output);
}
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
const { handleGeminiLyricsRequest } = await import(
  pathToFileURL(join(directory, "lyrics/gemini-server.mjs")).href
);

const wav = Buffer.alloc(44 + 16_000 * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16_000, 24);
wav.writeUInt32LE(32_000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(32_000, 40);

const payload = JSON.stringify({
  chunkIndex: 0,
  totalChunks: 1,
  chunkStartMs: 0,
  chunkDurationMs: 1000,
  sourceDurationMs: 1000,
  preset: "fast",
  recheck: false,
  languageCode: "",
  audioBase64: wav.toString("base64"),
});

test("Gemini failures preserve actionable upstream categories without exposing keys", async () => {
  const cases = [
    [400, "INVALID_ARGUMENT", "invalid_request", 400, false],
    [400, "FAILED_PRECONDITION", "account_precondition", 400, false],
    [402, "RESOURCE_EXHAUSTED", "billing_required", 402, false],
    [429, "RESOURCE_EXHAUSTED", "rate_limit_or_quota", 429, true],
    [503, "UNAVAILABLE", "provider_unavailable", 502, true],
  ];
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    for (const [upstreamStatus, upstreamCode, expectedCode, expectedStatus, retryable] of cases) {
      const request = new Request("https://pulseframe.test/api/lyrics/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": "session-secret" },
        body: payload,
      });
      const response = await handleGeminiLyricsRequest(request, {
        env: { GEMINI_API_KEY: "server-secret" },
        fetcher: async (url, options) => {
          assert.equal(options.headers["x-goog-api-key"], "session-secret");
          if (url.endsWith("/upload/v1beta/files"))
            return new Response(null, {
              status: 200,
              headers: {
                "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/session",
              },
            });
          if (url.endsWith("/upload/session"))
            return Response.json({
              file: {
                name: "files/test",
                uri: "https://generativelanguage.googleapis.com/v1beta/files/test",
              },
            });
          if (options.method === "DELETE") return new Response(null, { status: 200 });
          assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
          const providerRequest = JSON.parse(options.body);
          assert.equal(providerRequest.model, "gemini-3.5-transcribe");
          assert.deepEqual(
            providerRequest.generation_config.transcription_config.language_codes,
            [],
          );
          assert.deepEqual(
            providerRequest.generation_config.transcription_config.mode.timestamp_granularities,
            ["word"],
          );
          return Response.json(
            { error: { status: upstreamCode, message: "Rejected session-secret" } },
            { status: upstreamStatus },
          );
        },
      });
      const body = await response.json();
      assert.equal(response.status, expectedStatus);
      assert.equal(body.error.code, expectedCode);
      assert.equal(body.error.retryable, retryable);
      assert.equal(body.providerAttempts, 1);
      assert.doesNotMatch(JSON.stringify(body), /session-secret|server-secret/);
    }
    assert.doesNotMatch(JSON.stringify(warnings), /session-secret|server-secret/);
  } finally {
    console.warn = originalWarn;
  }
});

test("Transcribe uploads server-side and converts timed words with a language hint", async () => {
  const calls = [];
  const request = new Request("https://pulseframe.test/api/lyrics/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": "session-secret" },
    body: JSON.stringify({ ...JSON.parse(payload), languageCode: "id-ID" }),
  });
  const response = await handleGeminiLyricsRequest(request, {
    fetcher: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/upload/v1beta/files"))
        return new Response(null, {
          headers: {
            "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/session",
          },
        });
      if (url.endsWith("/upload/session"))
        return Response.json({
          file: {
            name: "files/test",
            uri: "https://generativelanguage.googleapis.com/v1beta/files/test",
          },
        });
      if (options.method === "DELETE") return new Response(null);
      return Response.json({
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: "Hello world.",
                annotations: [
                  {
                    type: "word_info",
                    text: "Hello",
                    start_offset: "0.100s",
                    end_offset: "0.400s",
                  },
                  {
                    type: "word_info",
                    text: "world.",
                    start_offset: "0.500s",
                    end_offset: "0.900s",
                  },
                ],
              },
            ],
          },
        ],
      });
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.segments, [{ startMs: 100, endMs: 900, text: "Hello world." }]);
  assert.equal(body.model, "gemini-3.5-transcribe");
  assert.equal(calls.length, 4);
  assert.equal(calls[1].options.body.byteLength, wav.byteLength);
  assert.deepEqual(
    JSON.parse(calls[2].options.body).generation_config.transcription_config.language_codes,
    ["id-ID"],
  );
  assert.equal(calls[3].options.method, "DELETE");
});
