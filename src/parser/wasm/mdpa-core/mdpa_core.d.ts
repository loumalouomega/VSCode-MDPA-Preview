/* tslint:disable */
/* eslint-disable */

/**
 * Streaming MDPA parser for `parseMdpaFile` (accepts raw UTF-8 byte chunks or lines).
 */
export class WasmMdpaStreamParser {
    free(): void;
    [Symbol.dispose](): void;
    feedChunk(chunk: Uint8Array | number[]): void;
    feedLine(line: string): void;
    finish(): WasmParsedMdpa;
    constructor();
}

/**
 * Streaming summary scanner (`MdpaSummaryScanner`).
 */
export class WasmMdpaSummaryScanner {
    free(): void;
    [Symbol.dispose](): void;
    feedChunk(chunk: Uint8Array | number[]): void;
    feedLine(line: string): void;
    finishJson(): string;
    constructor();
}

/**
 * Builder for serializing an `MdpaModel` to UTF-8 bytes without JSON-encoding numeric arrays.
 */
export class WasmMdpaWriter {
    free(): void;
    [Symbol.dispose](): void;
    addBlock(entity_ids: Int32Array | number[], property_ids: Int32Array | number[] | null | undefined, connectivity: Int32Array | number[]): void;
    addField(ids: Int32Array | number[], values: Float64Array | number[], fixed?: Uint8Array | number[] | null): void;
    addSubpartIds(ids: Int32Array | number[]): void;
    buildBytes(): Uint8Array;
    constructor(meta_json: string);
    setNodes(node_ids: Int32Array | number[], coords: Float32Array | number[]): void;
}

/**
 * Solver element-quality kernels (Phase 2). One node table, many blocks.
 */
export class WasmMetricsMesh {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Six values per cell: scaledJacobian, skewness, warpage, taper, radiusRatio,
     * measure. `NaN` = not applicable.
     */
    block(connectivity: Int32Array | number[], count: number, stride: number, shape_id: number, need: number, decomp_kind: number, decomp: Int32Array | number[]): Float64Array;
    constructor(node_ids: Int32Array | number[], coords: Float32Array | number[]);
}

/**
 * Result of parsing an MDPA document. Holds typed arrays in WASM linear memory
 * until extracted via bulk-copy getters and freed.
 */
export class WasmParsedMdpa {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    blockConnectivity(idx: number): Int32Array;
    blockEntityIds(idx: number): Int32Array;
    blockPropertyIds(idx: number): Int32Array | undefined;
    coords(): Float32Array;
    fieldFixed(idx: number): Uint8Array | undefined;
    fieldIds(idx: number): Int32Array;
    fieldValues(idx: number): Float64Array;
    metaJson(): string;
    nodeIds(): Int32Array;
    subpartIds(flat_idx: number): Int32Array;
}

/**
 * Boundary-skin extraction (roadmap item 87, Phase 2).
 */
export class WasmSkinExtractor {
    free(): void;
    [Symbol.dispose](): void;
    addSurfaceBlock(vtk_type: number, connectivity: Int32Array | number[], count: number, stride: number): void;
    addVolumeBlock(vtk_type: number, connectivity: Int32Array | number[], count: number, stride: number): void;
    finish(): number;
    groupConnectivity(idx: number): Int32Array;
    groupCount(): number;
    groupEntityIds(idx: number): Int32Array;
    groupFaceCount(idx: number): number;
    groupStride(idx: number): number;
    groupVtkType(idx: number): number;
    constructor(node_ids: Int32Array | number[]);
}

/**
 * Parse an entire UTF-8 MDPA buffer in one shot.
 */
export function parseMdpaBytes(bytes: Uint8Array | number[]): WasmParsedMdpa;
