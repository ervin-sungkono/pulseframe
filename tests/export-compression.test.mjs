import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const directory = mkdtempSync(join(tmpdir(), 'pulse-compression-'));
const modulePath = join(directory, 'compression.mjs');
writeFileSync(modulePath, ts.transpileModule(readFileSync(new URL('../lib/export-compression.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText);
const { compressExport } = await import(pathToFileURL(modulePath));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
test('ZIP extraction restores exact bytes and retains UTF-8 filename, CRC and sizes', async () => {
  const original = new TextEncoder().encode('video and audio bytes\n'.repeat(10000));
  const result = await compressExport(new Blob([original]), '音楽.webm', new AbortController().signal, () => {});
  assert.equal(result.compressed, true); assert.ok(result.savedBytes > 0);
  assert.equal(result.filename, '音楽.webm.zip');
  const bytes = new Uint8Array(await result.blob.arrayBuffer()), view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50); assert.equal(view.getUint16(8, true), 8);
  const length = view.getUint16(26, true), size = view.getUint32(18, true), start = 30 + length;
  assert.equal(new TextDecoder().decode(bytes.slice(30, start)), '音楽.webm');
  const restored = inflateRawSync(bytes.slice(start, start + size));
  assert.deepEqual(restored, Buffer.from(original)); assert.equal(view.getUint32(14, true), crc32(restored));
  const central = start + size, end = bytes.length - 22;
  assert.equal(view.getUint32(central, true), 0x02014b50);
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint32(end + 16, true), central);
  assert.equal(view.getUint32(central + 24, true), original.length);
});
test('incompressible and tiny files retain the original playable output', async () => {
  for (const bytes of [randomBytes(200000), new Uint8Array([1, 2, 3])]) {
    const blob = new Blob([bytes]);
    const result = await compressExport(blob, 'video.mp4', new AbortController().signal, () => {});
    assert.equal(result.blob, blob); assert.equal(result.filename, 'video.mp4'); assert.equal(result.savedBytes, 0);
  }
});
test('canceling during compression produces no downloadable result', async () => {
  const controller = new AbortController();
  await assert.rejects(compressExport(new Blob(['frame'.repeat(500000)]), 'video.webm', controller.signal,
    () => controller.abort()), { name: 'AbortError' });
});
test('unsupported browsers safely retain the original file', async () => {
  const native = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = undefined;
    const blob = new Blob(['data']);
    assert.equal((await compressExport(blob, 'video.mp4', new AbortController().signal, () => {})).blob, blob);
  } finally { globalThis.CompressionStream = native; }
});
