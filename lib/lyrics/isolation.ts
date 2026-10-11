import * as ORT from "onnxruntime-web/webgpu";
import { getCpuThreadCount, planIsolationBlocks } from "./policy";
import { MDX_CHANNELS, MDX_COMPENSATION, MDX_VALID_LENGTH } from "./mdx-config";
import { KIM_VOCAL_2_MODEL, loadVerifiedModel } from "./model-cache";
import { configureMdxRuntimeAssets, type MdxRuntimeEnvironment } from "./runtime-assets";
import {
  MDX_BLOCK_SAMPLES,
  MDX_MODEL_SHAPE,
  MDX_SAMPLE_RATE,
  MDX_SPECTRUM_SIZE,
  MdxSTFT,
} from "./stft";

export type IsolationBackend = "webgpu" | "wasm" | "mixed";

export type IsolationProgress = {
  completed: number;
  total: number;
  backend: "webgpu" | "wasm";
};

export type IsolationTimings = {
  modelRetrievalMs: number;
  sessionLoadingMs: number;
  spectralEncodeMs: number;
  inferenceMs: number;
  decodeMs: number;
  blendingMs: number;
};

export type IsolationOptions = {
  /** Overlap fraction selected by the local Auto or Quality policy. */
  overlap: 0.25 | 0.5;
  /** A requested ceiling; the module enforces the shared-memory capability check. */
  threads?: number;
  signal: AbortSignal;
  onProgress?: (progress: IsolationProgress) => void;
};

export type IsolationResult = {
  channels: [Float32Array, Float32Array];
  sampleRate: 44_100;
  sourceLength: number;
  blocksCompleted: number;
  backend: IsolationBackend;
  /** Capture stays disabled until repeated physical-browser validation. */
  graphCapture: false;
  notices: string[];
  timings: IsolationTimings;
};

type InferenceBackend = "webgpu" | "wasm";
type Runtime = typeof ORT;
type ModelSession = Awaited<ReturnType<typeof ORT.InferenceSession.create>>;

const PLANAR_TENSOR_SIZE = MDX_SPECTRUM_SIZE * 4;
const BLEND_FLOOR = 0.025;
const SESSION_INITIALIZATION_TIMEOUT_MS = 180_000;
const GRAPH_CAPTURE_NOTICE =
  "ONNX Runtime WebGPU graph capture is disabled pending repeated physical-browser validation.";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Vocal isolation was canceled", "AbortError");
}

function supportsSharedWasmMemory(): boolean {
  if (typeof SharedArrayBuffer === "undefined") return false;
  try {
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return true;
  } catch {
    return false;
  }
}

function getEffectiveWasmThreads(requestedThreads?: number): number {
  const navigatorLike = globalThis.navigator as Navigator | undefined;
  const sharedWasmMemoryAvailable = supportsSharedWasmMemory();
  const available = getCpuThreadCount({
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBufferAvailable: typeof SharedArrayBuffer !== "undefined",
    sharedWasmMemoryAvailable,
    hardwareConcurrency: navigatorLike?.hardwareConcurrency ?? 1,
  });
  if (requestedThreads === undefined || !Number.isFinite(requestedThreads)) return available;
  return Math.max(1, Math.min(available, Math.floor(requestedThreads)));
}

async function hasHighPerformanceWebGpuAdapter(): Promise<boolean> {
  const navigatorLike = globalThis.navigator as
    | (Navigator & {
        gpu?: {
          requestAdapter: (options?: { powerPreference?: string }) => Promise<unknown | null>;
        };
      })
    | undefined;
  const gpu = navigatorLike?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") return false;
  try {
    return (await gpu.requestAdapter({ powerPreference: "high-performance" })) !== null;
  } catch {
    return false;
  }
}

function releaseOutputTensor(value: unknown): void {
  if (value && typeof value === "object" && "dispose" in value) {
    const dispose = (value as { dispose?: () => void }).dispose;
    try {
      dispose?.call(value);
    } catch {
      // Runtime cleanup must not conceal the inference error being handled.
    }
  }
}

async function releaseSession(session: ModelSession | null): Promise<void> {
  if (!session) return;
  try {
    await session.release();
  } catch {
    // Session disposal is best effort after an execution-provider failure.
  }
}

function createBlendWindow(length: number): Float32Array {
  const weights = new Float32Array(length);
  const denominator = Math.max(1, length - 1);
  for (let index = 0; index < length; index += 1) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / denominator);
    weights[index] = Math.max(BLEND_FLOOR, hann);
  }
  return weights;
}

function createBlockInput(source: Float32Array, start: number, target: Float32Array): void {
  target.fill(0);
  const sourceStart = Math.max(0, start);
  const sourceEnd = Math.min(source.length, start + target.length);
  if (sourceEnd <= sourceStart) return;
  const targetStart = sourceStart - start;
  target.set(source.subarray(sourceStart, sourceEnd), targetStart);
}

async function createSession(
  runtime: Runtime,
  model: Uint8Array,
  backend: InferenceBackend,
  threads: number,
): Promise<ModelSession> {
  configureMdxRuntimeAssets(runtime.env as unknown as MdxRuntimeEnvironment);
  runtime.env.wasm.numThreads = threads;
  return runtime.InferenceSession.create(model, {
    executionProviders: [backend],
    graphOptimizationLevel: "all",
    preferredOutputLocation: "cpu",
  });
}

function createSessionWithTimeout(
  runtime: Runtime,
  model: Uint8Array,
  backend: InferenceBackend,
  threads: number,
  signal: AbortSignal,
): Promise<ModelSession> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () =>
      fail(signal.reason ?? new DOMException("Model initialization was canceled", "AbortError"));
    const timeout = setTimeout(
      () => fail(new DOMException("Isolation model initialization timed out", "TimeoutError")),
      SESSION_INITIALIZATION_TIMEOUT_MS,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    void createSession(runtime, model, backend, threads).then(
      (createdSession) => {
        if (settled || signal.aborted) {
          void releaseSession(createdSession);
          if (!settled) onAbort();
          return;
        }
        settled = true;
        cleanup();
        resolve(createdSession);
      },
      (error: unknown) => fail(error),
    );
  });
}

async function runModelBlock(
  session: ModelSession,
  inputName: string,
  outputName: string,
  inputTensor: ORT.Tensor,
  outputBuffer: Float32Array,
): Promise<void> {
  const outputValues = await session.run({ [inputName]: inputTensor });
  const outputTensor = outputValues[outputName];
  if (!outputTensor) throw new Error("Kim Vocal 2 returned no output tensor");
  try {
    const outputData = await outputTensor.getData();
    const outputDims = outputTensor.dims;
    if (
      !(outputData instanceof Float32Array) ||
      outputData.length !== PLANAR_TENSOR_SIZE ||
      outputDims.length !== MDX_MODEL_SHAPE.length ||
      outputDims.some((dimension, index) => dimension !== MDX_MODEL_SHAPE[index])
    ) {
      throw new Error("Kim Vocal 2 returned a tensor with an unexpected shape or data type");
    }
    outputBuffer.set(outputData);
  } finally {
    releaseOutputTensor(outputTensor);
  }
}

/**
 * Separate Kim Vocal 2 vocals inside the processing worker. The model and all
 * audio buffers stay in that worker; only the completed stereo vocal buffers
 * are returned to its caller.
 */
export async function isolateVocals(
  channels: readonly Float32Array[],
  options: IsolationOptions,
): Promise<IsolationResult> {
  if (channels.length !== MDX_CHANNELS) {
    throw new Error("Kim Vocal 2 expects exactly two 44.1 kHz audio channels");
  }
  if (channels[0].length !== channels[1].length) {
    throw new Error("Kim Vocal 2 input channels must have equal sample counts");
  }
  if (options.overlap !== 0.25 && options.overlap !== 0.5) {
    throw new Error("Kim Vocal 2 overlap must be 25% or 50%");
  }
  throwIfAborted(options.signal);

  const sourceLength = channels[0].length;
  const blocks = planIsolationBlocks(sourceLength, options.overlap);
  const vocals: [Float32Array, Float32Array] = [
    new Float32Array(sourceLength),
    new Float32Array(sourceLength),
  ];
  const timings: IsolationTimings = {
    modelRetrievalMs: 0,
    sessionLoadingMs: 0,
    spectralEncodeMs: 0,
    inferenceMs: 0,
    decodeMs: 0,
    blendingMs: 0,
  };
  if (blocks.length === 0) {
    return {
      channels: vocals,
      sampleRate: MDX_SAMPLE_RATE,
      sourceLength,
      blocksCompleted: 0,
      backend: "wasm",
      graphCapture: false,
      notices: [GRAPH_CAPTURE_NOTICE],
      timings,
    };
  }

  const runtime = ORT;
  const notices = [GRAPH_CAPTURE_NOTICE];
  const threads = getEffectiveWasmThreads(options.threads);
  const modelRetrievalStart = performance.now();
  const model = await loadVerifiedModel(KIM_VOCAL_2_MODEL, options.signal);
  timings.modelRetrievalMs = performance.now() - modelRetrievalStart;
  throwIfAborted(options.signal);

  const blendWindow = createBlendWindow(MDX_VALID_LENGTH);
  const weightSums = new Float32Array(sourceLength);
  const blockInputLeft = new Float32Array(MDX_BLOCK_SAMPLES);
  const blockInputRight = new Float32Array(MDX_BLOCK_SAMPLES);
  const blockOutputLeft = new Float32Array(MDX_BLOCK_SAMPLES);
  const blockOutputRight = new Float32Array(MDX_BLOCK_SAMPLES);
  const transform = new MdxSTFT();
  const inputData = new Float32Array(PLANAR_TENSOR_SIZE);
  const modelOutput = new Float32Array(PLANAR_TENSOR_SIZE);
  const planeSize = MDX_SPECTRUM_SIZE;
  const inputRealLeft = inputData.subarray(0, planeSize);
  const inputImagLeft = inputData.subarray(planeSize, planeSize * 2);
  const inputRealRight = inputData.subarray(planeSize * 2, planeSize * 3);
  const inputImagRight = inputData.subarray(planeSize * 3, planeSize * 4);
  const outputRealLeft = modelOutput.subarray(0, planeSize);
  const outputImagLeft = modelOutput.subarray(planeSize, planeSize * 2);
  const outputRealRight = modelOutput.subarray(planeSize * 2, planeSize * 3);
  const outputImagRight = modelOutput.subarray(planeSize * 3, planeSize * 4);
  const inputTensor = new runtime.Tensor("float32", inputData, [...MDX_MODEL_SHAPE]);

  let session: ModelSession | null = null;
  let backend: InferenceBackend = "wasm";
  const completedBackends = new Set<InferenceBackend>();
  let inputName = "";
  let outputName = "";
  let blocksCompleted = 0;

  const initializeSession = async (
    preferred: InferenceBackend,
  ): Promise<{ backend: InferenceBackend; session: ModelSession }> => {
    if (preferred === "webgpu") {
      try {
        return {
          session: await createSessionWithTimeout(
            runtime,
            model,
            "webgpu",
            threads,
            options.signal,
          ),
          backend: "webgpu",
        };
      } catch {
        throwIfAborted(options.signal);
        notices.push("WebGPU could not initialize; vocal isolation continued with WASM.");
      }
    }
    return {
      session: await createSessionWithTimeout(runtime, model, "wasm", threads, options.signal),
      backend: "wasm",
    };
  };

  try {
    const sessionLoadingStart = performance.now();
    const webgpuAvailable = await hasHighPerformanceWebGpuAdapter();
    const initialized = await initializeSession(webgpuAvailable ? "webgpu" : "wasm");
    timings.sessionLoadingMs += performance.now() - sessionLoadingStart;
    session = initialized.session;
    backend = initialized.backend;
    if (!webgpuAvailable) {
      notices.push("A compatible WebGPU adapter was unavailable; vocal isolation ran with WASM.");
    }
    throwIfAborted(options.signal);

    if (!session || session.inputNames.length !== 1 || session.outputNames.length !== 1) {
      throw new Error("The pinned Kim Vocal 2 model must expose one input and one output tensor");
    }
    inputName = session.inputNames[0];
    outputName = session.outputNames[0];

    for (const block of blocks) {
      throwIfAborted(options.signal);
      createBlockInput(channels[0], block.inputStart, blockInputLeft);
      createBlockInput(channels[1], block.inputStart, blockInputRight);
      const spectralEncodeStart = performance.now();
      transform.forward(blockInputLeft, inputRealLeft, inputImagLeft);
      transform.forward(blockInputRight, inputRealRight, inputImagRight);
      timings.spectralEncodeMs += performance.now() - spectralEncodeStart;

      let inferenceStart = performance.now();
      try {
        await runModelBlock(session, inputName, outputName, inputTensor, modelOutput);
        timings.inferenceMs += performance.now() - inferenceStart;
      } catch (error) {
        timings.inferenceMs += performance.now() - inferenceStart;
        throwIfAborted(options.signal);
        if (backend !== "webgpu") throw error;

        await releaseSession(session);
        session = null;
        notices.push(
          "WebGPU inference failed; completed blocks were retained and processing resumed with WASM.",
        );
        const fallbackSessionLoadingStart = performance.now();
        const fallback = await initializeSession("wasm");
        timings.sessionLoadingMs += performance.now() - fallbackSessionLoadingStart;
        session = fallback.session;
        backend = fallback.backend;
        inputName = session.inputNames[0];
        outputName = session.outputNames[0];
        inferenceStart = performance.now();
        try {
          await runModelBlock(session, inputName, outputName, inputTensor, modelOutput);
          timings.inferenceMs += performance.now() - inferenceStart;
        } catch (fallbackError) {
          timings.inferenceMs += performance.now() - inferenceStart;
          throw fallbackError;
        }
      }

      throwIfAborted(options.signal);

      const decodeStart = performance.now();
      transform.inverse(outputRealLeft, outputImagLeft, blockOutputLeft);
      transform.inverse(outputRealRight, outputImagRight, blockOutputRight);
      timings.decodeMs += performance.now() - decodeStart;

      const blendingStart = performance.now();
      for (let offset = 0; offset < block.validLength; offset += 1) {
        const outputOffset = block.validInputOffset + offset;
        const target = block.validStart + offset;
        const weight = blendWindow[offset];
        vocals[0][target] += blockOutputLeft[outputOffset] * MDX_COMPENSATION * weight;
        vocals[1][target] += blockOutputRight[outputOffset] * MDX_COMPENSATION * weight;
        weightSums[target] += weight;
      }
      timings.blendingMs += performance.now() - blendingStart;

      blocksCompleted += 1;
      completedBackends.add(backend);
      try {
        options.onProgress?.({
          completed: blocksCompleted,
          total: blocks.length,
          backend,
        });
      } catch {
        // A progress listener must not invalidate a completed inference block.
      }
    }

    throwIfAborted(options.signal);
    const normalizationStart = performance.now();
    for (let index = 0; index < sourceLength; index += 1) {
      const weight = weightSums[index];
      if (weight > 0) {
        vocals[0][index] /= weight;
        vocals[1][index] /= weight;
      }
    }
    timings.blendingMs += performance.now() - normalizationStart;

    return {
      channels: vocals,
      sampleRate: MDX_SAMPLE_RATE,
      sourceLength,
      blocksCompleted,
      backend:
        completedBackends.size > 1 ? "mixed" : (completedBackends.values().next().value ?? backend),
      graphCapture: false,
      notices,
      timings,
    };
  } finally {
    inputTensor.dispose();
    await releaseSession(session);
    // Model weights and temporary spectra fall out of scope with this job.
  }
}
