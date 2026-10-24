import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
const headers = config.headers.find(({ source }) => source === "/(.*)").headers;
const headerValue = (name) =>
  headers.find(({ key }) => key.toLowerCase() === name.toLowerCase())?.value;

test("production CSP supports app assets without enabling JavaScript eval", () => {
  const policy = headerValue("Content-Security-Policy");
  assert.ok(policy);
  const directives = new Map(
    policy.split(";").map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
  const sources = (name) => directives.get(name);

  assert.deepEqual(sources("default-src"), ["'self'"]);
  assert.deepEqual(sources("base-uri"), ["'self'"]);
  assert.deepEqual(sources("object-src"), ["'none'"]);
  assert.deepEqual(sources("frame-ancestors"), ["'none'"]);
  assert.deepEqual(sources("frame-src"), ["'none'"]);
  assert.deepEqual(sources("form-action"), ["'self'"]);
  assert.deepEqual(sources("script-src"), ["'self'", "'wasm-unsafe-eval'"]);
  assert.ok(!sources("script-src").includes("'unsafe-eval'"));
  assert.deepEqual(sources("style-src"), ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(sources("worker-src"), ["'self'", "blob:"]);
  assert.deepEqual(sources("img-src"), ["'self'", "data:", "blob:"]);
  assert.deepEqual(sources("media-src"), ["'self'", "blob:"]);
  assert.deepEqual(sources("font-src"), ["'self'"]);
  assert.deepEqual(sources("connect-src"), [
    "'self'",
    "https://huggingface.co",
    "https://cdn-lfs.huggingface.co",
    "https://us.aws.cdn.hf.co",
    "https://cas-bridge.xethub.hf.co",
  ]);
});

test("production isolation headers remain configured", () => {
  assert.equal(headerValue("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(headerValue("Cross-Origin-Embedder-Policy"), "credentialless");
});
