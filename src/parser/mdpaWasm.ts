/**
 * Runtime loader and zero-JSON-bloat TypeScript wrapper for the `mdpa-core`
 * Rust/WASM crate (roadmap item 87).
 *
 * Large numeric arrays (`nodeIds`, `coords`, `connectivity`, field values,
 * SubModelPart ID lists) cross the JS/WASM boundary as bulk-copied TypedArrays;
 * only small metadata (block headers, SubModelPart tree skeleton, properties,
 * constraints, diagnostics, bounds) uses JSON.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type {
  EntityBlock,
  EntityKind,
  FieldBlockKind,
  FieldData,
  MdpaDiagnostic,
  MdpaModel,
  MetaBlock,
  SubModelPart,
} from "./types";
import type { PropertySet, PropertyValue } from "./propertiesParser";
import type { ConstraintBlock } from "./constraintsParser";
import type { MdpaScanResult } from "./mdpaParser";
import type { MdpaWriteOptions } from "./writers/mdpaWriter";

interface WasmParsedMdpaHandle {
  metaJson(): string;
  nodeIds(): Int32Array;
  coords(): Float32Array;
  blockEntityIds(idx: number): Int32Array;
  blockPropertyIds(idx: number): Int32Array | undefined;
  blockConnectivity(idx: number): Int32Array;
  fieldIds(idx: number): Int32Array;
  fieldValues(idx: number): Float64Array;
  fieldFixed(idx: number): Uint8Array | undefined;
  subpartIds(flatIdx: number): Int32Array;
  free(): void;
}

interface WasmStreamParserHandle {
  feedChunk(chunk: Uint8Array): void;
  feedLine(line: string): void;
  finish(): WasmParsedMdpaHandle;
  free(): void;
}

interface WasmSummaryScannerHandle {
  feedChunk(chunk: Uint8Array): void;
  feedLine(line: string): void;
  finishJson(): string;
  free(): void;
}

interface WasmMdpaWriterHandle {
  setNodes(nodeIds: Int32Array, coords: Float32Array): void;
  addBlock(
    entityIds: Int32Array,
    propertyIds: Int32Array | undefined,
    connectivity: Int32Array
  ): void;
  addField(ids: Int32Array, values: Float64Array, fixed: Uint8Array | undefined): void;
  addSubpartIds(ids: Int32Array): void;
  buildBytes(): Uint8Array;
  free(): void;
}

interface WasmMetricsMeshHandle {
  block(
    connectivity: Int32Array,
    count: number,
    stride: number,
    shapeId: number,
    need: number,
    decompKind: number,
    decomp: Int32Array
  ): Float64Array;
  free(): void;
}

interface WasmSkinExtractorHandle {
  addSurfaceBlock(vtkType: number, connectivity: Int32Array, count: number, stride: number): void;
  addVolumeBlock(vtkType: number, connectivity: Int32Array, count: number, stride: number): void;
  finish(): number;
  groupCount(): number;
  groupVtkType(idx: number): number;
  groupStride(idx: number): number;
  groupFaceCount(idx: number): number;
  groupEntityIds(idx: number): Int32Array;
  groupConnectivity(idx: number): Int32Array;
  free(): void;
}

export interface MdpaWasmModule {
  /** Solver element-quality kernels (roadmap item 87, Phase 2); absent in older builds. */
  WasmMetricsMesh?: new (nodeIds: Int32Array, coords: Float32Array) => WasmMetricsMeshHandle;
  /** Boundary-skin extraction (roadmap item 87, Phase 2); absent in older builds. */
  WasmSkinExtractor?: new (nodeIds: Int32Array) => WasmSkinExtractorHandle;
  parseMdpaBytes(bytes: Uint8Array): WasmParsedMdpaHandle;
  WasmMdpaStreamParser: new () => WasmStreamParserHandle;
  WasmMdpaSummaryScanner: new () => WasmSummaryScannerHandle;
  WasmMdpaWriter: new (metaJson: string) => WasmMdpaWriterHandle;
}

interface RawSubModelPartMeta {
  name: string;
  path: string;
  nodeIdsIdx: number;
  elementIdsIdx: number;
  conditionIdsIdx: number;
  geometryIdsIdx: number;
  constraintIdsIdx: number;
  children: RawSubModelPartMeta[];
}

interface RawPropertySet {
  id: number;
  variables: [string, PropertyValue][];
  tables: PropertySet["tables"];
}

interface RawParsedModelMeta {
  nodeCount: number;
  blocks: {
    kind: EntityKind;
    name: string;
    vtkCellType?: number;
    count: number;
    stride: number;
    hasPropertyIds: boolean;
  }[];
  subModelParts: RawSubModelPartMeta[];
  meta: MetaBlock[];
  fields: {
    kind: FieldBlockKind;
    variable: string;
    components: number;
    hasFixed: boolean;
  }[];
  diagnostics: MdpaDiagnostic[];
  is3D: boolean;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  properties?: RawPropertySet[];
  constraints?: ConstraintBlock[];
}

let cachedMod: MdpaWasmModule | null | undefined;
let resolvedModulePath: string | undefined;

function candidatePaths(): string[] {
  return [
    // Bundled extension / MCP / worker (dist/mdpa-core/mdpa_core.js beside dist/*.js)
    path.join(__dirname, "mdpa-core", "mdpa_core.js"),
    // Direct src/parser/ layout
    path.join(__dirname, "wasm", "mdpa-core", "mdpa_core.js"),
    // Compiled tests (out/parser/ -> src/parser/wasm/mdpa-core/)
    path.resolve(__dirname, "../../src/parser/wasm/mdpa-core/mdpa_core.js"),
    // Fallback to dist/ from out/parser/
    path.resolve(__dirname, "../../dist/mdpa-core/mdpa_core.js"),
  ];
}

export function resolveMdpaWasmPath(): string | undefined {
  if (resolvedModulePath !== undefined) return resolvedModulePath;
  for (const p of candidatePaths()) {
    if (fs.existsSync(p)) {
      resolvedModulePath = p;
      return p;
    }
  }
  return undefined;
}

export function loadMdpaWasm(): MdpaWasmModule | null {
  if (cachedMod !== undefined) return cachedMod;
  const modPath = resolveMdpaWasmPath();
  if (!modPath) {
    cachedMod = null;
    return null;
  }
  try {
    const req = createRequire(modPath);
    cachedMod = req(modPath) as MdpaWasmModule;
    return cachedMod;
  } catch {
    cachedMod = null;
    return null;
  }
}

export function isMdpaWasmAvailable(): boolean {
  return loadMdpaWasm() !== null;
}

function hydrateSubModelPart(
  raw: RawSubModelPartMeta,
  handle: WasmParsedMdpaHandle
): SubModelPart {
  return {
    name: raw.name,
    nodeIds: handle.subpartIds(raw.nodeIdsIdx),
    elementIds: handle.subpartIds(raw.elementIdsIdx),
    conditionIds: handle.subpartIds(raw.conditionIdsIdx),
    geometryIds: handle.subpartIds(raw.geometryIdsIdx),
    constraintIds: handle.subpartIds(raw.constraintIdsIdx),
    path: raw.path,
    children: raw.children.map((c) => hydrateSubModelPart(c, handle)),
  };
}

function hydrateProperties(raws: RawPropertySet[]): PropertySet[] {
  return raws.map((r) => {
    const variables = Object.create(null) as Record<string, PropertyValue>;
    for (const [k, v] of r.variables) {
      variables[k] = v;
    }
    return {
      id: r.id,
      variables,
      tables: r.tables,
    };
  });
}

function hydrateModel(handle: WasmParsedMdpaHandle): MdpaModel {
  try {
    const meta = JSON.parse(handle.metaJson()) as RawParsedModelMeta;
    const nodeIds = handle.nodeIds();
    const coords = handle.coords();

    const blocks: EntityBlock[] = meta.blocks.map((bm, i) => {
      const block: EntityBlock = {
        kind: bm.kind,
        name: bm.name,
        vtkCellType: bm.vtkCellType,
        count: bm.count,
        stride: bm.stride,
        entityIds: handle.blockEntityIds(i),
        connectivity: handle.blockConnectivity(i),
      };
      if (bm.hasPropertyIds) {
        block.propertyIds = handle.blockPropertyIds(i);
      }
      return block;
    });

    const subModelParts = meta.subModelParts.map((p) => hydrateSubModelPart(p, handle));

    const fields: FieldData[] = meta.fields.map((fm, i) => {
      const field: FieldData = {
        kind: fm.kind,
        variable: fm.variable,
        components: fm.components,
        ids: handle.fieldIds(i),
        values: handle.fieldValues(i),
      };
      if (fm.hasFixed) {
        field.fixed = handle.fieldFixed(i);
      }
      return field;
    });

    const model: MdpaModel = {
      nodeCount: meta.nodeCount,
      nodeIds,
      coords,
      blocks,
      subModelParts,
      meta: meta.meta,
      fields,
      diagnostics: meta.diagnostics,
      is3D: meta.is3D,
      bounds: meta.bounds,
      ...(meta.properties ? { properties: hydrateProperties(meta.properties) } : {}),
      ...(meta.constraints ? { constraints: meta.constraints } : {}),
    };
    return model;
  } finally {
    handle.free();
  }
}

export function parseMdpaBytesWasm(bytes: Uint8Array): MdpaModel {
  const mod = loadMdpaWasm();
  if (!mod) throw new Error("mdpa-core WASM module is not available.");
  const handle = mod.parseMdpaBytes(bytes);
  return hydrateModel(handle);
}

export function parseMdpaWasm(text: string): MdpaModel {
  return parseMdpaBytesWasm(Buffer.from(text, "utf8"));
}

export async function parseMdpaFileWasm(
  fsPath: string,
  onProgress?: (phase: "read", bytesRead: number, totalBytes: number) => void,
  signal?: AbortSignal
): Promise<MdpaModel> {
  const mod = loadMdpaWasm();
  if (!mod) throw new Error("mdpa-core WASM module is not available.");
  if (signal?.aborted) throw new Error("cancelled");

  const stat = await fs.promises.stat(fsPath);
  const totalBytes = stat.size;

  return new Promise<MdpaModel>((resolve, reject) => {
    const parser = new mod.WasmMdpaStreamParser();
    let bytesRead = 0;
    let lastProgressBytes = 0;
    let settled = false;
    let freed = false;

    const freeParser = (): void => {
      if (!freed) {
        freed = true;
        parser.free();
      }
    };

    const stream = fs.createReadStream(fsPath, { highWaterMark: 256 * 1024 });

    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        stream.destroy(new Error("cancelled"));
        freeParser();
        reject(new Error("cancelled"));
      }
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    stream.on("data", (chunk: Buffer | string) => {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      parser.feedChunk(buf);
      bytesRead += buf.length;
      if (onProgress && bytesRead - lastProgressBytes >= 2 * 1024 * 1024) {
        lastProgressBytes = bytesRead;
        onProgress("read", bytesRead, totalBytes);
      }
    });

    stream.on("end", () => {
      if (settled) return;
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        settled = true;
        freeParser();
        reject(new Error("cancelled"));
        return;
      }
      if (onProgress) {
        onProgress("read", totalBytes, totalBytes);
      }
      let model: MdpaModel;
      try {
        const handle = parser.finish();
        freeParser();
        model = hydrateModel(handle);
      } catch (err) {
        settled = true;
        freeParser();
        reject(err);
        return;
      }
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve(model);
      };
      if (stream.closed) done();
      else stream.once("close", done);
    });

    stream.on("error", (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      freeParser();
      reject(err);
    });
  });
}

export function scanMdpaBytesWasm(bytes: Uint8Array): MdpaScanResult {
  const mod = loadMdpaWasm();
  if (!mod) throw new Error("mdpa-core WASM module is not available.");
  const scanner = new mod.WasmMdpaSummaryScanner();
  try {
    scanner.feedChunk(bytes);
    return JSON.parse(scanner.finishJson()) as MdpaScanResult;
  } finally {
    scanner.free();
  }
}

export async function scanMdpaFileWasm(
  fsPath: string
): Promise<{ result: MdpaScanResult; bytesRead: number }> {
  const mod = loadMdpaWasm();
  if (!mod) throw new Error("mdpa-core WASM module is not available.");
  return new Promise((resolve, reject) => {
    const scanner = new mod.WasmMdpaSummaryScanner();
    let bytesRead = 0;
    let settled = false;
    let freed = false;
    const freeScanner = (): void => {
      if (!freed) {
        freed = true;
        scanner.free();
      }
    };
    const stream = fs.createReadStream(fsPath, { highWaterMark: 256 * 1024 });
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      scanner.feedChunk(buf);
      bytesRead += buf.length;
    });
    stream.on("end", () => {
      if (settled) return;
      let result: MdpaScanResult;
      try {
        result = JSON.parse(scanner.finishJson()) as MdpaScanResult;
        freeScanner();
      } catch (err) {
        settled = true;
        freeScanner();
        reject(err);
        return;
      }
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve({ result, bytesRead });
      };
      if (stream.closed) done();
      else stream.once("close", done);
    });
    stream.on("error", (err) => {
      if (settled) return;
      settled = true;
      freeScanner();
      reject(err);
    });
  });
}

export function writeMdpaBytesWasm(
  model: MdpaModel,
  opts: Pick<MdpaWriteOptions, "sourceText"> = {}
): Uint8Array {
  const mod = loadMdpaWasm();
  if (!mod) throw new Error("mdpa-core WASM module is not available.");

  const subpartArrays: Int32Array[] = [];
  const collectSubpart = (p: SubModelPart): RawSubModelPartMeta => {
    const nodeIdsIdx = subpartArrays.length;
    subpartArrays.push(p.nodeIds);
    const elementIdsIdx = subpartArrays.length;
    subpartArrays.push(p.elementIds);
    const conditionIdsIdx = subpartArrays.length;
    subpartArrays.push(p.conditionIds);
    const geometryIdsIdx = subpartArrays.length;
    subpartArrays.push(p.geometryIds);
    const constraintIdsIdx = subpartArrays.length;
    subpartArrays.push(p.constraintIds);
    return {
      name: p.name,
      path: p.path,
      nodeIdsIdx,
      elementIdsIdx,
      conditionIdsIdx,
      geometryIdsIdx,
      constraintIdsIdx,
      children: p.children.map(collectSubpart),
    };
  };

  const rawProperties: RawPropertySet[] | undefined = model.properties?.map((set) => {
    const variables: [string, PropertyValue][] = [];
    for (const key of Object.keys(set.variables)) {
      const val = set.variables[key];
      if (val !== undefined) variables.push([key, val]);
    }
    return {
      id: set.id,
      variables,
      tables: set.tables,
    };
  });

  const meta = {
    nodeCount: model.nodeCount,
    blocks: model.blocks.map((b) => ({
      kind: b.kind,
      name: b.name,
      count: b.count,
      stride: b.stride,
    })),
    subModelParts: model.subModelParts.map(collectSubpart),
    fields: model.fields.map((f) => ({
      kind: f.kind,
      variable: f.variable,
      components: f.components,
    })),
    properties: rawProperties,
    constraints: model.constraints,
    sourceText: opts.sourceText,
  };

  const writer = new mod.WasmMdpaWriter(JSON.stringify(meta));
  try {
    writer.setNodes(model.nodeIds, model.coords);
    for (const b of model.blocks) {
      writer.addBlock(b.entityIds, b.propertyIds, b.connectivity);
    }
    for (const f of model.fields) {
      writer.addField(f.ids, f.values, f.fixed);
    }
    for (const arr of subpartArrays) {
      writer.addSubpartIds(arr);
    }
    return writer.buildBytes();
  } finally {
    writer.free();
  }
}

export function writeMdpaWasm(
  model: MdpaModel,
  opts: Pick<MdpaWriteOptions, "sourceText"> = {}
): string {
  const bytes = writeMdpaBytesWasm(model, opts);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}
