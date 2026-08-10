/* tslint:disable */
/* eslint-disable */

/**
 * Phonemization result returned to JavaScript.
 *
 * Contains `phoneme_ids` (ready for ONNX inference) and
 * `prosody_features` (flattened `[N*3]` array of A1/A2/A3 values).
 */
export class PhonemizeResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Number of phoneme IDs.
     */
    readonly phonemeCount: number;
    /**
     * phoneme_ids as Int32Array in JavaScript.
     * Values are in the 0–1000 range so i32 is sufficient.
     */
    readonly phonemeIds: Int32Array;
    /**
     * Prosody features as Int32Array (flattened [N*3]: a1,a2,a3 repeating).
     */
    readonly prosodyFeatures: Int32Array;
}

/**
 * WASM-compatible 8-language phonemizer with bundled Japanese dictionary.
 *
 * Usage from JavaScript:
 * ```js
 * import init, { WasmPhonemizer } from './piper_plus_wasm.js';
 * await init();
 * const phonemizer = new WasmPhonemizer(JSON.stringify(config));
 * const result = phonemizer.phonemize("こんにちは");
 * console.log(result.phonemeIds);       // Int32Array
 * console.log(result.prosodyFeatures);  // Int32Array
 * phonemizer.free(); // optional explicit cleanup
 * ```
 */
export class WasmPhonemizer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Detect the primary language of the given text.
     */
    detectLanguage(text: string): string;
    /**
     * Get the list of supported languages.
     *
     * Returns the language codes from the model's `language_id_map`
     * (e.g. `["ja", "en", "zh", ...]`).
     */
    getSupportedLanguages(): string[];
    /**
     * Create a new phonemizer from a config.json string.
     *
     * The config must contain `phoneme_id_map` and `language_id_map`.
     *
     * # Errors
     *
     * Returns a JavaScript `Error` with a `.code` property:
     * - `CONFIG_PARSE_ERROR` — invalid JSON or missing required fields
     * - `UNSUPPORTED_LANGUAGE` — a language in `language_id_map` could not be initialised
     * - `INTERNAL_ERROR` — unexpected failure
     */
    constructor(config_json: string);
    /**
     * Phonemize text and return phoneme IDs + prosody features.
     *
     * `language` is an optional language code hint (e.g. `"ja"`, `"en"`).
     * When provided, a warning is logged if auto-detection yields a different
     * language. Currently auto-detection is always used for the actual
     * phonemization; the parameter is reserved for future forced-language
     * support.
     *
     * # Errors
     *
     * Returns a JavaScript `Error` with a `.code` property:
     * - `EMPTY_INPUT` — text is empty or whitespace-only
     * - `PHONEMIZE_ERROR` — the G2P pipeline failed
     */
    phonemize(text: string, language?: string | null): PhonemizeResult;
    /**
     * Load external Chinese pinyin dictionaries from JSON bytes.
     *
     * This replaces the initial PassthroughPhonemizer for Chinese with a
     * full ChinesePhonemizer backed by the provided pinyin dictionaries.
     *
     * - `single_json` — JSON bytes for single-character pinyin dict
     *   (e.g. `{"19968": "yi1", "19969": "ding1,zheng4", ...}`)
     * - `phrase_json` — JSON bytes for phrase pinyin dict
     *   (e.g. `{"一丁不識": [["yī"], ["dīng"], ...], ...}`)
     *
     * Typically fetched from a CDN and cached in IndexedDB.
     *
     * # Errors
     *
     * Returns `CONFIG_PARSE_ERROR` if the dictionary JSON is invalid.
     */
    setChineseDictionary(single_json: Uint8Array, phrase_json: Uint8Array): void;
}

/**
 * Get the API version string.
 */
export function getApiVersion(): string;

/**
 * Called automatically when the WASM module is instantiated.
 * Sets up the panic hook for better error messages in the browser console.
 */
export function init_panic_hook(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_phonemizeresult_free: (a: number, b: number) => void;
    readonly __wbg_wasmphonemizer_free: (a: number, b: number) => void;
    readonly getApiVersion: () => [number, number];
    readonly phonemizeresult_phonemeCount: (a: number) => number;
    readonly phonemizeresult_phonemeIds: (a: number) => [number, number];
    readonly phonemizeresult_prosodyFeatures: (a: number) => [number, number];
    readonly wasmphonemizer_detectLanguage: (a: number, b: number, c: number) => [number, number];
    readonly wasmphonemizer_getSupportedLanguages: (a: number) => [number, number];
    readonly wasmphonemizer_new: (a: number, b: number) => [number, number, number];
    readonly wasmphonemizer_phonemize: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasmphonemizer_setChineseDictionary: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly init_panic_hook: () => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
