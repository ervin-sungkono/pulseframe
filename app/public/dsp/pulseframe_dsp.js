let wasm;

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_0.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}
/**
 * @returns {string}
 */
export function core_version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.core_version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * @returns {number}
 */
export function feature_schema_version() {
    const ret = wasm.feature_schema_version();
    return ret >>> 0;
}

const FrameDspFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_framedsp_free(ptr >>> 0, 1));
/**
 * Reusable, scalar f64 analysis for the trailing 4096-sample audio frame.
 *
 * JavaScript owns the memory containing the exposed pointers for the lifetime
 * of this instance. All buffers are allocated in `new` and retain their
 * addresses until `free`; `analyze` does not resize or replace them.
 */
export class FrameDsp {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FrameDspFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_framedsp_free(ptr, 0);
    }
    /**
     * @param {number} sample_rate
     * @param {number} channel_count
     */
    constructor(sample_rate, channel_count) {
        const ret = wasm.framedsp_new(sample_rate, channel_count);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        FrameDspFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Pointer to channel-major Float32 input (`channel_count * FFT_SIZE`).
     * Fill it with trailing samples and leading zeros before calling analyze.
     * @returns {number}
     */
    input_ptr() {
        const ret = wasm.framedsp_input_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    input_len() {
        const ret = wasm.framedsp_input_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Feature order: rms, rmsDb, bassDb, bassHitDb, ringBassDb, middleDb, highDb.
     * @returns {number}
     */
    features_ptr() {
        const ret = wasm.framedsp_features_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    features_len() {
        const ret = wasm.framedsp_features_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Channel-major bands, 96 values per channel.
     * @returns {number}
     */
    bands_ptr() {
        const ret = wasm.framedsp_bands_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    bands_len() {
        const ret = wasm.framedsp_bands_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Channel-major Float64 magnitudes, 2049 values per channel.
     * @returns {number}
     */
    amplitudes_ptr() {
        const ret = wasm.framedsp_amplitudes_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    amplitudes_len() {
        const ret = wasm.framedsp_amplitudes_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Channel-major Float32 dB values, 2049 values per channel.
     * @returns {number}
     */
    db_ptr() {
        const ret = wasm.framedsp_db_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    db_len() {
        const ret = wasm.framedsp_db_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    sample_rate() {
        const ret = wasm.framedsp_sample_rate(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    channel_count() {
        const ret = wasm.framedsp_channel_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Compute calibrated 4096 and impact 1024 spectra, RMS and legacy bands.
     * This function uses only constructor-allocated buffers.
     */
    analyze() {
        wasm.framedsp_analyze(this.__wbg_ptr);
    }
}

const TemporalDspFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_temporaldsp_free(ptr >>> 0, 1));
/**
 * Optional stateful spectral-flux and tempo analysis.
 *
 * `input_ptr` addresses one chronological 2048-sample, mono window whose
 * exclusive end is given to `observe`. Call once per 512-sample hop. A
 * repeated, backwards, or non-adjacent sample position clears detector state
 * before that frame is consumed. Output order is spectral flux, onset time in
 * seconds (or -1), onset strength, coarse tempo BPM (or 0), beat phase, tempo
 * confidence, and causal latency in seconds. Tempo can be half/double
 * ambiguous; confidence is reduced when a related period is also strong.
 */
export class TemporalDsp {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TemporalDspFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_temporaldsp_free(ptr, 0);
    }
    /**
     * @param {number} sample_rate
     */
    constructor(sample_rate) {
        const ret = wasm.temporaldsp_new(sample_rate);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        TemporalDspFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Pointer to the chronological Float32 input window (2048 samples).
     * @returns {number}
     */
    input_ptr() {
        const ret = wasm.temporaldsp_input_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    input_len() {
        const ret = wasm.temporaldsp_input_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Pointer to the seven Float64 output metrics.
     * @returns {number}
     */
    output_ptr() {
        const ret = wasm.temporaldsp_output_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    output_len() {
        const ret = wasm.framedsp_features_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    sample_rate() {
        const ret = wasm.temporaldsp_sample_rate(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Analyze one causal window ending at `end_sample`.
     *
     * Consecutive calls must advance by exactly one 512-sample hop. This
     * method performs no heap allocation after construction.
     * @param {number} end_sample
     */
    observe(end_sample) {
        wasm.temporaldsp_observe(this.__wbg_ptr, end_sample);
    }
    /**
     * Clear all sequential detector state. The next observation is a warm-up
     * frame and reports zero flux, no onset, and unknown tempo.
     */
    reset() {
        wasm.temporaldsp_reset(this.__wbg_ptr);
    }
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_0;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };
    imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_throw = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };

    return imports;
}

function __wbg_init_memory(imports, memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('pulseframe_dsp_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
