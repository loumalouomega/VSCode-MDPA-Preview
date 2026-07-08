/**
 * Shared MdpaModel assembly helpers used by every mesh-file parser
 * (legacy VTK, VTK XML, STL/OBJ/PLY, multiblock).
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable.
 */

import {
  EntityBlock,
  FieldBlockKind,
  FieldData,
  MdpaDiagnostic,
  MdpaModel,
  SubModelPart,
} from "./types";

// VTK cell type ids relevant to normalization
const VERTEX = 1;
const POLY_VERTEX = 2;
const LINE = 3;
const POLY_LINE = 4;
const TRIANGLE = 5;
const TRIANGLE_STRIP = 6;
const POLYGON = 7;
const QUAD = 9;

export interface BlocksResult {
  blocks: EntityBlock[];
  /**
   * Per input cell: how many output cells it produced (1 for a pass-through,
   * >1 when normalization split it, 0 when it was skipped as degenerate).
   * Feed to `expandCellField` to keep cell data aligned.
   */
  expansion: Int32Array;
  /** First unused entity id after the emitted cells. */
  nextEntityId: number;
}

interface StagingBlock {
  cellType: number;
  stride: number;
  name: string;
  entityIds: number[];
  connectivity: number[]; // 1-based
}

/**
 * Groups VTU-style cells (types + end-offsets + 0-based connectivity) into
 * EntityBlocks, one per (cellType, stride) pair, in first-seen order.
 *
 * Cell types the webview cannot draw are normalized into drawable ones:
 * POLY_VERTEX → VERTEX per node, POLY_LINE → LINE segments,
 * POLYGON → TRIANGLE/QUAD/triangle fan, TRIANGLE_STRIP → triangles.
 */
export function buildBlocksFromOffsets(
  types: ArrayLike<number>,
  offsets: ArrayLike<number>,
  connectivity: ArrayLike<number>,
  diagnostics: MdpaDiagnostic[],
  startEntityId = 1
): BlocksResult {
  const nCells = Math.min(types.length, offsets.length);
  if (types.length !== offsets.length) {
    diagnostics.push({
      line: 0,
      message: `Cell type count (${types.length}) differs from offsets count (${offsets.length}); using ${nCells}.`,
    });
  }

  const byKey = new Map<string, StagingBlock>();
  const order: StagingBlock[] = [];
  const strideCountByType = new Map<number, number>();
  const expansion = new Int32Array(nCells);
  let gid = startEntityId;

  const emit = (cellType: number, nodes0: number[]): void => {
    const stride = nodes0.length;
    const key = `${cellType}|${stride}`;
    let blk = byKey.get(key);
    if (!blk) {
      const seen = strideCountByType.get(cellType) ?? 0;
      strideCountByType.set(cellType, seen + 1);
      blk = {
        cellType,
        stride,
        name: seen === 0 ? `VtkCell_${cellType}` : `VtkCell_${cellType}_${stride}n`,
        entityIds: [],
        connectivity: [],
      };
      byKey.set(key, blk);
      order.push(blk);
    }
    blk.entityIds.push(gid++);
    for (const n of nodes0) blk.connectivity.push(n + 1); // 0-based → 1-based
  };

  let connPos = 0;
  for (let c = 0; c < nCells; c++) {
    const end = Math.round(offsets[c]);
    const nodes: number[] = [];
    for (let k = connPos; k < end; k++) {
      nodes.push(Math.round(connectivity[k] ?? 0));
    }
    connPos = end;

    const cellType = Math.round(types[c]);
    const before = gid;

    switch (cellType) {
      case POLY_VERTEX:
        for (const n of nodes) emit(VERTEX, [n]);
        break;
      case POLY_LINE:
        for (let i = 0; i + 1 < nodes.length; i++) {
          emit(LINE, [nodes[i], nodes[i + 1]]);
        }
        break;
      case POLYGON:
        if (nodes.length === 3) {
          emit(TRIANGLE, nodes);
        } else if (nodes.length === 4) {
          emit(QUAD, nodes);
        } else if (nodes.length > 4) {
          for (let i = 1; i + 1 < nodes.length; i++) {
            emit(TRIANGLE, [nodes[0], nodes[i], nodes[i + 1]]);
          }
        }
        break;
      case TRIANGLE_STRIP:
        for (let i = 0; i + 2 < nodes.length; i++) {
          emit(
            TRIANGLE,
            i % 2 === 0
              ? [nodes[i], nodes[i + 1], nodes[i + 2]]
              : [nodes[i + 1], nodes[i], nodes[i + 2]]
          );
        }
        break;
      default:
        if (nodes.length > 0) emit(cellType, nodes);
        break;
    }

    expansion[c] = gid - before;
    if (expansion[c] === 0) {
      diagnostics.push({
        line: 0,
        message: `Cell ${c + 1} (VTK type ${cellType}) has too few nodes and was skipped.`,
      });
    }
  }

  const blocks: EntityBlock[] = order.map((blk) => ({
    kind: "Elements",
    name: blk.name,
    vtkCellType: blk.cellType,
    count: blk.entityIds.length,
    stride: blk.stride,
    entityIds: new Int32Array(blk.entityIds),
    propertyIds: undefined,
    connectivity: new Int32Array(blk.connectivity),
  }));

  return { blocks, expansion, nextEntityId: gid };
}

/**
 * Re-aligns a cell FieldData after cell normalization: tuple i is replicated
 * `expansion[i]` times and ids are renumbered sequentially from the first id.
 */
export function expandCellField(
  field: FieldData,
  expansion: ArrayLike<number>
): FieldData {
  const comp = field.components;
  let total = 0;
  for (let i = 0; i < expansion.length; i++) total += expansion[i];

  const ids = new Int32Array(total);
  const values = new Float64Array(total * comp);
  const firstId = field.ids.length > 0 ? field.ids[0] : 1;
  let out = 0;
  for (let i = 0; i < expansion.length; i++) {
    for (let r = 0; r < expansion[i]; r++) {
      ids[out] = firstId + out;
      for (let k = 0; k < comp; k++) {
        values[out * comp + k] = field.values[i * comp + k] ?? 0;
      }
      out++;
    }
  }
  return { ...field, ids, values };
}

/** Builds a FieldData with synthesized sequential 1-based ids from flat tuples. */
export function fieldFromTuples(
  kind: FieldBlockKind,
  variable: string,
  components: number,
  values: ArrayLike<number>
): FieldData {
  const nTuples = Math.floor(values.length / Math.max(components, 1));
  const ids = new Int32Array(nTuples);
  for (let i = 0; i < nTuples; i++) ids[i] = i + 1;
  const out = new Float64Array(nTuples * components);
  for (let i = 0; i < out.length; i++) out[i] = values[i];
  return { kind, variable, components, ids, values: out };
}

/** Assembles the final MdpaModel: synthesized node ids, bounds, is3D. */
export function finalizeModel(args: {
  nodeCount: number;
  coords: Float32Array;
  nodeIds?: Int32Array;
  blocks: EntityBlock[];
  fields: FieldData[];
  diagnostics: MdpaDiagnostic[];
  subModelParts?: SubModelPart[];
}): MdpaModel {
  const { nodeCount, coords } = args;
  let nodeIds = args.nodeIds;
  if (!nodeIds) {
    nodeIds = new Int32Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) nodeIds[i] = i + 1;
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let hasZ = false;
  for (let i = 0; i < nodeCount; i++) {
    const x = coords[i * 3] ?? 0;
    const y = coords[i * 3 + 1] ?? 0;
    const z = coords[i * 3 + 2] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    if (z !== 0) hasZ = true;
  }
  if (!isFinite(minX)) { minX = 0; maxX = 0; minY = 0; maxY = 0; minZ = 0; maxZ = 0; }

  return {
    nodeCount,
    nodeIds,
    coords,
    blocks: args.blocks,
    subModelParts: args.subModelParts ?? [],
    meta: [],
    fields: args.fields,
    diagnostics: args.diagnostics,
    is3D: hasZ,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}
