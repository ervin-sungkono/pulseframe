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
const { GEMINI_MAX_SEGMENTS_PER_CHUNK } = await import(
  pathToFileURL(join(directory, "lyrics/gemini-contract.mjs")).href
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

function interaction(annotations = [], text = "") {
  return {
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [{ type: "text", text, annotations }],
      },
    ],
  };
}

async function transcribe(providerBody, { languageCode = "" } = {}) {
  const calls = [];
  const request = new Request("https://pulseframe.test/api/lyrics/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": "session-secret" },
    body: JSON.stringify({ ...JSON.parse(payload), languageCode }),
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
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
      return Response.json(providerBody);
    },
  });
  return { response, body: await response.json(), calls };
}

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
  const { response, body, calls } = await transcribe(
    interaction(
      [
        { type: "word_info", text: "Hello", start_offset: "0.100s", end_offset: "0.400s" },
        { type: "word_info", text: "world.", start_offset: "0.500s", end_offset: "0.900s" },
      ],
      "Hello world.",
    ),
    { languageCode: "id-ID" },
  );
  assert.equal(response.status, 200);
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

test("Transcribe extracts missing WordInfo text with UTF-8 byte indices", async () => {
  const { response, body } = await transcribe(
    interaction(
      [
        {
          type: "word_info",
          start_index: 0,
          end_index: 6,
          start_offset: "0s",
          end_offset: "0.050s",
        },
        {
          type: "word_info",
          start_index: 7,
          end_index: 12,
          start_offset: "0.100s",
          end_offset: "0.400s",
        },
        {
          type: "word_info",
          start_index: 12,
          end_index: 13,
          start_offset: "0.500s",
          end_offset: "0.900s",
        },
      ],
      "音楽 hello!",
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(body.segments, [{ startMs: 0, endMs: 900, text: "音楽 hello!" }]);
});

test("Transcribe preserves sub-millisecond word timing", async () => {
  const { response, body } = await transcribe(
    interaction([
      {
        type: "word_info",
        text: "a",
        start_offset: "0.0001s",
        end_offset: "0.0004s",
      },
    ]),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(body.segments, [{ startMs: 0.1, endMs: 0.4, text: "a" }]);
});

test("Transcribe keeps zero-duration punctuation in a timed phrase", async () => {
  const { response, body } = await transcribe(
    interaction([
      { type: "word_info", text: "Hello", start_offset: "0.100s", end_offset: "0.400s" },
      { type: "word_info", text: ",", start_offset: "0.400s", end_offset: "0.400s" },
      { type: "word_info", text: "world.", start_offset: "0.500s", end_offset: "0.900s" },
    ]),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(body.segments, [{ startMs: 100, endMs: 900, text: "Hello, world." }]);
  assert.equal(body.flags.timing, false);
});

test("Transcribe sorts reordered WordInfo annotations by start time", async () => {
  const { response, body } = await transcribe(
    interaction([
      { type: "word_info", text: "world.", start_offset: "0.500s", end_offset: "0.900s" },
      { type: "word_info", text: "Hello", start_offset: "0.100s", end_offset: "0.400s" },
    ]),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(body.segments, [{ startMs: 100, endMs: 900, text: "Hello world." }]);
});

test("Transcribe reports stable issues for malformed timestamped responses", async () => {
  const invalidCases = [
    ["invalid_interaction_shape", { status: "completed", steps: null }],
    ["interaction_not_completed", { status: "in_progress", steps: [] }],
    [
      "no_positive_phrase_timing",
      interaction([{ type: "word_info", text: "point", start_offset: "0.2s", end_offset: "0.2s" }]),
    ],
    [
      "missing_or_invalid_word_timing",
      interaction([{ type: "word_info", text: "PRIVATE_LYRICS", start_offset: "0.100s" }]),
    ],
    [
      "invalid_word_text_indices",
      interaction(
        [
          {
            type: "word_info",
            start_index: 0,
            end_index: 1,
            start_offset: "0.100s",
            end_offset: "0.400s",
          },
        ],
        "éclair",
      ),
    ],
    [
      "invalid_word_text_indices",
      interaction(
        [
          {
            type: "word_info",
            start_index: 0,
            end_index: 99,
            start_offset: "0.100s",
            end_offset: "0.400s",
          },
        ],
        "hello",
      ),
    ],
    ["missing_word_annotations", interaction([], "PRIVATE_LYRICS")],
    [
      "word_timing_out_of_bounds",
      interaction([
        { type: "word_info", text: "reversed", start_offset: "0.400s", end_offset: "0.300s" },
      ]),
    ],
    [
      "word_timing_out_of_bounds",
      interaction([
        { type: "word_info", text: "outside", start_offset: "0.900s", end_offset: "1.101s" },
      ]),
    ],
  ];
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    for (const [responseIssue, providerBody] of invalidCases) {
      const { response, body } = await transcribe(providerBody);
      assert.equal(response.status, 502);
      assert.equal(body.error.code, "invalid_response");
      assert.equal(body.providerAttempts, 1);
      assert.equal(body.responseIssue, responseIssue);
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.doesNotMatch(JSON.stringify(warnings), /session-secret|server-secret|PRIVATE_LYRICS/);
  assert.deepEqual(
    warnings,
    invalidCases.map(([responseIssue]) => [
      "Gemini transcription response rejected",
      { responseIssue, chunkIndex: 0 },
    ]),
  );
});

test("Transcribe rejects too many segments and accepts valid silence", async () => {
  const annotations = Array.from({ length: GEMINI_MAX_SEGMENTS_PER_CHUNK + 1 }, (_, index) => ({
    type: "word_info",
    text: `word${index}.`,
    start_offset: "0.100s",
    end_offset: "0.200s",
  }));
  const tooMany = await transcribe(interaction(annotations));
  assert.equal(tooMany.response.status, 502);
  assert.equal(tooMany.body.responseIssue, "segment_limit_exceeded");
  assert.equal(tooMany.body.providerAttempts, 1);

  const atLimit = await transcribe(
    interaction(annotations.slice(0, GEMINI_MAX_SEGMENTS_PER_CHUNK)),
  );
  assert.equal(atLimit.response.status, 200);
  assert.equal(atLimit.body.segments.length, GEMINI_MAX_SEGMENTS_PER_CHUNK);

  const silence = await transcribe({ status: "completed", steps: [] });
  assert.equal(silence.response.status, 200);
  assert.deepEqual(silence.body.segments, []);
});
