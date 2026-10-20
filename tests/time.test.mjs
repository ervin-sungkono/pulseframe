import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../lib/time.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { formatTimestamp, parseTimestamp } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

test("formatTimestamp keeps the editor's coarse and precise display formats", () => {
  assert.equal(formatTimestamp(65.26), "1:05");
  assert.equal(formatTimestamp(65.26, true), "1:05.3");
  assert.equal(formatTimestamp(3600), "60:00");
  assert.equal(formatTimestamp(-1, true), "0:00.0");
  assert.equal(formatTimestamp(Number.NaN), "0:00");
});

test("parseTimestamp accepts seconds and minutes:seconds and rejects malformed input", () => {
  assert.equal(parseTimestamp(" 65.25 "), 65.25);
  assert.equal(parseTimestamp("1:05.25"), 65.25);
  assert.equal(parseTimestamp("0:90"), 90);
  for (const input of ["", "1:", ":1", "1::2", "-1:02", "1:2:3", "Infinity"])
    assert.equal(parseTimestamp(input), null, `expected ${JSON.stringify(input)} to be rejected`);
});
