/* @ts-self-types="./mdpa_core.d.ts" */

/**
 * Streaming MDPA parser for `parseMdpaFile` (accepts raw UTF-8 byte chunks or lines).
 */
class WasmMdpaStreamParser {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmMdpaStreamParserFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmmdpastreamparser_free(ptr, 0);
    }
    /**
     * @param {Uint8Array | number[]} chunk
     */
    feedChunk(chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmmdpastreamparser_feedChunk(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} line
     */
    feedLine(line) {
        const ptr0 = passStringToWasm0(line, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmmdpastreamparser_feedLine(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {WasmParsedMdpa}
     */
    finish() {
        const ret = wasm.wasmmdpastreamparser_finish(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmParsedMdpa.__wrap(ret[0]);
    }
    constructor() {
        const ret = wasm.wasmmdpastreamparser_new();
        this.__wbg_ptr = ret;
        WasmMdpaStreamParserFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) WasmMdpaStreamParser.prototype[Symbol.dispose] = WasmMdpaStreamParser.prototype.free;
exports.WasmMdpaStreamParser = WasmMdpaStreamParser;

/**
 * Streaming summary scanner (`MdpaSummaryScanner`).
 */
class WasmMdpaSummaryScanner {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmMdpaSummaryScannerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmmdpasummaryscanner_free(ptr, 0);
    }
    /**
     * @param {Uint8Array | number[]} chunk
     */
    feedChunk(chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmmdpasummaryscanner_feedChunk(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} line
     */
    feedLine(line) {
        const ptr0 = passStringToWasm0(line, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmmdpasummaryscanner_feedLine(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {string}
     */
    finishJson() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.wasmmdpasummaryscanner_finishJson(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    constructor() {
        const ret = wasm.wasmmdpasummaryscanner_new();
        this.__wbg_ptr = ret;
        WasmMdpaSummaryScannerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) WasmMdpaSummaryScanner.prototype[Symbol.dispose] = WasmMdpaSummaryScanner.prototype.free;
exports.WasmMdpaSummaryScanner = WasmMdpaSummaryScanner;

/**
 * Builder for serializing an `MdpaModel` to UTF-8 bytes without JSON-encoding numeric arrays.
 */
class WasmMdpaWriter {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmMdpaWriterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmmdpawriter_free(ptr, 0);
    }
    /**
     * @param {Int32Array | number[]} entity_ids
     * @param {Int32Array | number[] | null | undefined} property_ids
     * @param {Int32Array | number[]} connectivity
     */
    addBlock(entity_ids, property_ids, connectivity) {
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passArray32ToWasm0(entity_ids, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = isLikeNone(property_ids) ? 0 : passArray32ToWasm0(property_ids, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passArray32ToWasm0(connectivity, wasm.__wbindgen_malloc);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 4, 4); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
            throw e;
        }
        wasm.wasmmdpawriter_addBlock(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
    }
    /**
     * @param {Int32Array | number[]} ids
     * @param {Float64Array | number[]} values
     * @param {Uint8Array | number[] | null} [fixed]
     */
    addField(ids, values, fixed) {
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passArray32ToWasm0(ids, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArrayF64ToWasm0(values, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = isLikeNone(fixed) ? 0 : passArray8ToWasm0(fixed, wasm.__wbindgen_malloc);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
            throw e;
        }
        wasm.wasmmdpawriter_addField(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
    }
    /**
     * @param {Int32Array | number[]} ids
     */
    addSubpartIds(ids) {
        const ptr0 = passArray32ToWasm0(ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmmdpawriter_addSubpartIds(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {Uint8Array}
     */
    buildBytes() {
        const ret = wasm.wasmmdpawriter_buildBytes(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {string} meta_json
     */
    constructor(meta_json) {
        const ptr0 = passStringToWasm0(meta_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmmdpawriter_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WasmMdpaWriterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Int32Array | number[]} node_ids
     * @param {Float32Array | number[]} coords
     */
    setNodes(node_ids, coords) {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArray32ToWasm0(node_ids, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArrayF32ToWasm0(coords, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
            throw e;
        }
        wasm.wasmmdpawriter_setNodes(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
}
if (Symbol.dispose) WasmMdpaWriter.prototype[Symbol.dispose] = WasmMdpaWriter.prototype.free;
exports.WasmMdpaWriter = WasmMdpaWriter;

/**
 * Result of parsing an MDPA document. Holds typed arrays in WASM linear memory
 * until extracted via bulk-copy getters and freed.
 */
class WasmParsedMdpa {
    static __wrap(ptr) {
        const obj = Object.create(WasmParsedMdpa.prototype);
        obj.__wbg_ptr = ptr;
        WasmParsedMdpaFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmParsedMdpaFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmparsedmdpa_free(ptr, 0);
    }
    /**
     * @param {number} idx
     * @returns {Int32Array}
     */
    blockConnectivity(idx) {
        const ret = wasm.wasmparsedmdpa_blockConnectivity(this.__wbg_ptr, idx);
        return ret;
    }
    /**
     * @param {number} idx
     * @returns {Int32Array}
     */
    blockEntityIds(idx) {
        const ret = wasm.wasmparsedmdpa_blockEntityIds(this.__wbg_ptr, idx);
        return ret;
    }
    /**
     * @param {number} idx
     * @returns {Int32Array | undefined}
     */
    blockPropertyIds(idx) {
        const ret = wasm.wasmparsedmdpa_blockPropertyIds(this.__wbg_ptr, idx);
        return ret;
    }
    /**
     * @returns {Float32Array}
     */
    coords() {
        const ret = wasm.wasmparsedmdpa_coords(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} idx
     * @returns {Uint8Array | undefined}
     */
    fieldFixed(idx) {
        const ret = wasm.wasmparsedmdpa_fieldFixed(this.__wbg_ptr, idx);
        return ret;
    }
    /**
     * @param {number} idx
     * @returns {Int32Array}
     */
    fieldIds(idx) {
        const ret = wasm.wasmparsedmdpa_fieldIds(this.__wbg_ptr, idx);
        return ret;
    }
    /**
     * @param {number} idx
     * @returns {Float64Array}
     */
    fieldValues(idx) {
        const ret = wasm.wasmparsedmdpa_fieldValues(this.__wbg_ptr, idx);
        return ret;
    }
    /**
     * @returns {string}
     */
    metaJson() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.wasmparsedmdpa_metaJson(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {Int32Array}
     */
    nodeIds() {
        const ret = wasm.wasmparsedmdpa_nodeIds(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} flat_idx
     * @returns {Int32Array}
     */
    subpartIds(flat_idx) {
        const ret = wasm.wasmparsedmdpa_subpartIds(this.__wbg_ptr, flat_idx);
        return ret;
    }
}
if (Symbol.dispose) WasmParsedMdpa.prototype[Symbol.dispose] = WasmParsedMdpa.prototype.free;
exports.WasmParsedMdpa = WasmParsedMdpa;

/**
 * Parse an entire UTF-8 MDPA buffer in one shot.
 * @param {Uint8Array | number[]} bytes
 * @returns {WasmParsedMdpa}
 */
function parseMdpaBytes(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parseMdpaBytes(ptr0, len0);
    return WasmParsedMdpa.__wrap(ret);
}
exports.parseMdpaBytes = parseMdpaBytes;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_from_slice_355c10c5d8f2addb: function(arg0, arg1) {
            const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_aaf85a9746711968: function(arg0, arg1) {
            const ret = new Float64Array(getArrayF64FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_b8daf545a41c6aa0: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_e0c60a796e12bb7c: function(arg0, arg1) {
            const ret = new Int32Array(getArrayI32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./mdpa_core_bg.js": import0,
    };
}

const WasmMdpaStreamParserFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmmdpastreamparser_free(ptr, 1));
const WasmMdpaSummaryScannerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmmdpasummaryscanner_free(ptr, 1));
const WasmMdpaWriterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmmdpawriter_free(ptr, 1));
const WasmParsedMdpaFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmparsedmdpa_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
function decodeText(bytes) {
    return cachedTextDecoder.decode(bytes);
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/mdpa_core_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
