/** ZIP packaging compresses encoded bytes; it never decodes or re-encodes media. */
export type CompressedExport = { blob: Blob; filename: string; savedBytes: number; compressed: boolean };
const ZIP_LIMIT = 0xffffffff;

export function supportsLosslessCompression() {
  try { new CompressionStream("gzip"); return true; } catch { return false; }
}

export async function compressExport(blob: Blob, filename: string, signal: AbortSignal,
  onProgress: (percent: number) => void): Promise<CompressedExport> {
  const original = { blob, filename, savedBytes: 0, compressed: false };
  signal.throwIfAborted();
  if (!supportsLosslessCompression() || blob.size > ZIP_LIMIT || blob.size === 0) return original;
  // Keep the archive member at its root, with a UTF-8 name safe for extraction.
  const safeName = filename.replace(/[\\/\x00-\x1f:*?"<>|]/g, "_");
  const suffix = safeName.match(/\.[a-z0-9]{1,12}$/i)?.[0] ?? "";
  const name = new TextEncoder().encode(safeName.length > 240
    ? safeName.slice(0, 240 - suffix.length) + suffix : safeName);
  const overhead = 30 + 46 + 22 + name.length * 2;
  let consumed = 0, compressedSize = 0;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const stream = blob.stream().pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      consumed += chunk.byteLength;
      onProgress(Math.min(99, Math.round(consumed / blob.size * 100)));
      controller.enqueue(chunk);
    },
  }), { signal }).pipeThrough(new CompressionStream("gzip"), { signal });
  const reader = stream.getReader();
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      compressedSize += value.byteLength;
      // A ZIP cannot save space once the compressed bytes exceed this bound.
      if (compressedSize - 18 + overhead >= blob.size) {
        await reader.cancel(); signal.throwIfAborted(); return original;
      }
      chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    signal.throwIfAborted();
    throw error;
  } finally { reader.releaseLock(); }
  signal.throwIfAborted();
  const gzip = new Blob(chunks);
  const header = new Uint8Array(await gzip.slice(0, 10).arrayBuffer());
  // Native gzip uses a ten-byte header. Reject alternate wrappers safely.
  if (header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 8 || header[3] !== 0 || gzip.size < 18) return original;
  const trailer = new DataView(await gzip.slice(-8).arrayBuffer());
  if (trailer.getUint32(4, true) !== blob.size) return original;
  const payload = gzip.slice(10, -8), crc = trailer.getUint32(0, true);
  const local = new Uint8Array(30), central = new Uint8Array(46), end = new Uint8Array(22);
  const l = new DataView(local.buffer), c = new DataView(central.buffer), e = new DataView(end.buffer);
  l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true);
  c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
  // UTF-8, DEFLATE, and a valid DOS date (1980-01-01).
  l.setUint16(6, 0x800, true); l.setUint16(8, 8, true); l.setUint16(12, 33, true);
  c.setUint16(8, 0x800, true); c.setUint16(10, 8, true); c.setUint16(14, 33, true);
  l.setUint32(14, crc, true); l.setUint32(18, payload.size, true); l.setUint32(22, blob.size, true); l.setUint16(26, name.length, true);
  c.setUint32(16, crc, true); c.setUint32(20, payload.size, true); c.setUint32(24, blob.size, true); c.setUint16(28, name.length, true);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, 1, true); e.setUint16(10, 1, true);
  e.setUint32(12, central.length + name.length, true); e.setUint32(16, local.length + name.length + payload.size, true);
  const archive = new Blob([local, name, payload, central, name, end], { type: "application/zip" });
  signal.throwIfAborted();
  onProgress(100);
  return archive.size < blob.size
    ? { blob: archive, filename: filename + ".zip", savedBytes: blob.size - archive.size, compressed: true }
    : original;
}
