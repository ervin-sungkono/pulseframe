/** Static public directories populated by scripts/prepare-lyrics-runtime.mjs. */
export const WHISPER_ORT_ASSET_DIRECTORY = "whisper-ort/";
export const MDX_ORT_ASSET_DIRECTORY = "mdx-ort/";

export type WhisperRuntimeEnvironment = {
  wasm?: {
    wasmPaths?: unknown;
    proxy?: boolean;
    numThreads?: number;
  };
};

export type MdxRuntimeEnvironment = {
  wasm?: {
    wasmPaths?: unknown;
    proxy?: boolean;
    numThreads?: number;
  };
};

export function configureMdxRuntimeAssets(runtime: MdxRuntimeEnvironment) {
  if (!runtime.wasm)
    throw new Error("The vocal-isolation ONNX runtime is unavailable.");
  runtime.wasm.wasmPaths = new URL(
    `${import.meta.env.BASE_URL}${MDX_ORT_ASSET_DIRECTORY}`,
    self.location.href,
  ).href;
  runtime.wasm.proxy = false;
}

/**
 * Configure Transformers.js to use its own ONNX Runtime build. MDX uses the
 * direct onnxruntime-web dependency and a different public directory.
 */
export function configureWhisperRuntimeAssets(
  runtime: WhisperRuntimeEnvironment,
  requestedThreads: number,
) {
  if (!runtime.wasm)
    throw new Error("The Whisper ONNX runtime is unavailable.");
  runtime.wasm.wasmPaths = new URL(
    `${import.meta.env.BASE_URL}${WHISPER_ORT_ASSET_DIRECTORY}`,
    self.location.href,
  ).href;
  runtime.wasm.proxy = false;
  runtime.wasm.numThreads = Math.max(1, Math.floor(requestedThreads));
}
