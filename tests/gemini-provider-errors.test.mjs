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

const wav = Buffer.alloc(44 + 24_000 * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24_000, 24);
wav.writeUInt32LE(48_000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(48_000, 40);

const payload = JSON.stringify({
  chunkIndex: 0,
  totalChunks: 1,
  chunkStartMs: 0,
  chunkDurationMs: 1000,
  sourceDurationMs: 1000,
  preset: "fast",
  recheck: false,
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
        fetcher: async (_url, options) => {
          assert.equal(options.headers["x-goog-api-key"], "session-secret");
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
