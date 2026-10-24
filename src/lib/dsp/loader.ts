import {
  DSP_CORE_VERSION,
  DSP_FEATURE_SCHEMA_VERSION,
  type DspModule,
  type DspModuleBindings,
} from "./contracts";

const INIT_TIMEOUT_MS = 4_000;
const MODULE_URL = "/dsp/pulseframe_dsp.js";
const WASM_URL = "/dsp/pulseframe_dsp_bg.wasm";

let initializedModule: DspModule | null = null;
let initialization: Promise<boolean> | null = null;
let initializationError: Error | null = null;

function isBrowserRuntime() {
  if (typeof window !== "undefined" && typeof document !== "undefined") return true;
  const workerGlobal = globalThis as typeof globalThis & {
    constructor?: { name?: string };
    location?: { href?: string };
    postMessage?: (...args: unknown[]) => void;
  };
  return (
    typeof document === "undefined" &&
    typeof workerGlobal.location?.href === "string" &&
    typeof workerGlobal.postMessage === "function" &&
    /WorkerGlobalScope$/.test(workerGlobal.constructor?.name ?? "")
  );
}

function runtimeBaseUrl() {
  return globalThis.location?.href ?? "";
}

async function loadModule(): Promise<DspModule> {
  const base = runtimeBaseUrl();
  if (!base) throw new Error("The DSP runtime has no browser base URL.");
  const moduleUrl = new URL(MODULE_URL, base);
  const wasmUrl = new URL(WASM_URL, base);
  moduleUrl.searchParams.set("v", DSP_CORE_VERSION);
  wasmUrl.searchParams.set("v", DSP_CORE_VERSION);
  const imported = (await import(/* @vite-ignore */ moduleUrl.href)) as DspModuleBindings;
  if (typeof imported.default !== "function" || typeof imported.FrameDsp !== "function") {
    throw new Error("The DSP WASM module is missing required bindings.");
  }
  const initialized = await imported.default({ module_or_path: wasmUrl });
  if (!initialized?.memory) throw new Error("The DSP WASM module did not expose its memory.");
  const dspModule: DspModule = { ...imported, memory: initialized.memory };
  if (dspModule.feature_schema_version() !== DSP_FEATURE_SCHEMA_VERSION) {
    throw new Error("The DSP WASM feature schema does not match this application.");
  }
  if (dspModule.core_version() !== DSP_CORE_VERSION) {
    throw new Error("The DSP WASM core version does not match this application.");
  }
  return dspModule;
}

async function initializeOnce() {
  if (!isBrowserRuntime()) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const dspModule = await Promise.race([
      loadModule(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The DSP WASM module did not initialize in time.")),
          INIT_TIMEOUT_MS,
        );
      }),
    ]);
    initializedModule = dspModule;
    return true;
  } catch (caught) {
    initializationError =
      caught instanceof Error ? caught : new Error("The DSP WASM module could not be initialized.");
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Internal rollback/benchmark switch; never stored in projects or exposed as a UI setting. */
export function getDspBackendPreference(): "auto" | "js" {
  try {
    return new URL(globalThis.location.href).searchParams.get("dsp") === "js" ? "js" : "auto";
  } catch {
    return "auto";
  }
}

/** Initialize the browser/worker WASM bindings once; callers can continue with JS when it fails. */
export function initializeDsp(): Promise<boolean> {
  if (getDspBackendPreference() === "js") return Promise.resolve(false);
  if (initializedModule) return Promise.resolve(true);
  if (!initialization) initialization = initializeOnce();
  return initialization;
}

/** A synchronous lookup used by frame adapters after candidate preparation awaited initializeDsp(). */
export function getInitializedDspModule(): DspModule | null {
  return initializedModule;
}

export function getDspInitializationError(): Error | null {
  return initializationError;
}
