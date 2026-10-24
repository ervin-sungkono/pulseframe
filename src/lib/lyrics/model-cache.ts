export type ModelArtifact = {
  url: string;
  revision: string;
  bytes: number;
  sha256: string;
};

export const KIM_VOCAL_2_MODEL: ModelArtifact = {
  url: "https://huggingface.co/Politrees/UVR_resources/resolve/83719e1e624d07842f914d856722af6f463e88cb/models/MDXNet/Kim_Vocal_2.onnx",
  revision: "83719e1e624d07842f914d856722af6f463e88cb",
  bytes: 66_759_214,
  sha256: "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
};

const CACHE_NAME = "pulseframe-lyrics-models-v1";
const CACHE_PREFIX = "/__pulseframe_lyrics_model_cache__/";
export const MODEL_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export type VerifiedModelCacheDependencies = {
  cacheStorage?: CacheStorage;
  fetcher?: typeof fetch;
  subtle?: SubtleCrypto;
  origin?: string;
  timeoutMs?: number;
};

function makeCacheRequest(artifact: ModelArtifact, origin?: string): Request {
  const base = origin ?? globalThis.location?.origin ?? "https://pulseframe.invalid";
  const key = `${artifact.revision}-${artifact.sha256}`;
  return new Request(new URL(`${CACHE_PREFIX}${key}`, base));
}

export async function sha256Hex(bytes: BufferSource, subtle: SubtleCrypto): Promise<string> {
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function validateModelBytes(
  bytes: Uint8Array,
  artifact: ModelArtifact,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<boolean> {
  if (bytes.byteLength !== artifact.bytes) return false;
  // The model loader creates ordinary ArrayBuffer-backed views. The cast keeps
  // current TypeScript typed-array generics from rejecting that known buffer.
  const digest = await sha256Hex(bytes as unknown as BufferSource, subtle);
  return digest === artifact.sha256;
}

/**
 * Load a pinned artifact from Cache API when possible, otherwise download it.
 * Browser cache/quota failures are best effort; incomplete or corrupt weights
 * are always rejected before ONNX Runtime sees them.
 */
export async function loadVerifiedModel(
  artifact: ModelArtifact,
  signal: AbortSignal,
  dependencies: VerifiedModelCacheDependencies = {},
): Promise<Uint8Array> {
  const cacheStorage = dependencies.cacheStorage ?? globalThis.caches;
  const fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
  const subtle = dependencies.subtle ?? globalThis.crypto?.subtle;
  const timeoutMs = dependencies.timeoutMs ?? MODEL_DOWNLOAD_TIMEOUT_MS;

  if (!subtle) throw new Error("Web Crypto is required to verify the local isolation model");
  if (signal.aborted) throw abortError();

  const downloadController = new AbortController();
  const parentAbort = () => downloadController.abort(signal.reason ?? abortError());
  signal.addEventListener("abort", parentAbort, { once: true });
  const timeout = setTimeout(
    () =>
      downloadController.abort(
        new DOMException(
          `Isolation model download timed out after ${timeoutMs} ms`,
          "TimeoutError",
        ),
      ),
    timeoutMs,
  );
  const downloadSignal = downloadController.signal;

  let cache: Cache | null = null;
  const cacheRequest = makeCacheRequest(artifact, dependencies.origin);
  try {
    if (cacheStorage) {
      try {
        cache = await awaitWithSignal(cacheStorage.open(CACHE_NAME), downloadSignal);
        const response = await awaitWithSignal(cache.match(cacheRequest), downloadSignal);
        if (response) {
          try {
            const bytes = await readResponseBytes(response, artifact.bytes, downloadSignal);
            if (await validateModelBytes(bytes, artifact, subtle)) {
              throwIfAborted(downloadSignal);
              return bytes;
            }
          } catch (error) {
            if (downloadSignal.aborted) throw abortReason(downloadSignal, error);
            // A failed or malformed cache entry is treated as a cache miss.
          }
          try {
            await cache.delete(cacheRequest);
          } catch {
            // Storage is optional; fresh validated bytes can still be used.
          }
        }
      } catch (error) {
        if (downloadSignal.aborted) throw abortReason(downloadSignal, error);
        cache = null;
      }
    }

    throwIfAborted(downloadSignal);
    const response = await fetcher(artifact.url, {
      signal: downloadSignal,
      cache: "no-cache",
    });
    if (!response.ok || response.status !== 200) {
      throw new Error(`Isolation model download failed with HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) !== artifact.bytes) {
      throw new Error("Isolation model download has an unexpected content length");
    }
    const bytes = await readResponseBytes(response, artifact.bytes, downloadSignal);
    throwIfAborted(downloadSignal);
    if (!(await validateModelBytes(bytes, artifact, subtle))) {
      throw new Error("Isolation model download failed its pinned size or SHA-256 check");
    }
    throwIfAborted(downloadSignal);

    if (cache) {
      try {
        void cache
          .put(
            cacheRequest,
            new Response(bytes as unknown as BodyInit, {
              status: 200,
              headers: {
                "content-type": "application/octet-stream",
                "content-length": String(bytes.byteLength),
                "x-pulseframe-model-revision": artifact.revision,
                "x-pulseframe-model-sha256": artifact.sha256,
              },
            }),
          )
          .catch(() => undefined);
      } catch {
        // Quota, private browsing, or disabled storage must not block inference.
      }
    }
    return bytes;
  } catch (error) {
    if (downloadSignal.aborted) throw abortReason(downloadSignal, error);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", parentAbort);
  }
}

async function readResponseBytes(
  response: Response,
  expectedBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) !== expectedBytes) {
    throw new Error("Isolation model response has an unexpected content length");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Isolation model response did not expose a bounded byte stream");

  const bytes = new Uint8Array(expectedBytes);
  let offset = 0;
  let cancelRequested = false;
  const cancelReader = (reason?: unknown) => {
    if (cancelRequested) return;
    cancelRequested = true;
    try {
      // Cancellation is best effort. Some Cache API streams do not settle
      // cancel() promptly, so never make it part of this reader's completion.
      void reader.cancel(reason).catch(() => undefined);
    } catch {
      // Preserve the original read, size, or abort error.
    }
  };
  const onAbort = () => cancelReader(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) break;
      if (offset + value.byteLength > expectedBytes) {
        throw new Error("Isolation model response exceeded its pinned byte count");
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } catch (error) {
    cancelReader(error);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative pending read may keep the lock until it settles.
    }
  }
  if (offset !== expectedBytes) {
    throw new Error("Isolation model response ended before its pinned byte count");
  }
  return bytes;
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal, fallback?: unknown): unknown {
  return signal.reason ?? fallback ?? abortError();
}

function abortError(): DOMException {
  return new DOMException("Model download was canceled", "AbortError");
}
