/**
 * Shared helpers for the mesh writers (MDPA, legacy VTK, VTK XML, STL/OBJ/PLY).
 *
 * The writers are the inverse of the parsers: they take an in-memory MdpaModel
 * and serialise it back to a file format.  Pure module: no vscode / DOM / vtk.js
 * imports so it stays Node-testable.
 *
 * Two facts about the model drive most of the logic here:
 *   - `EntityBlock.connectivity` stores **node IDs**, not 0-based indices, so
 *     index-based formats need an id→index remap (`nodeIndexMap`).
 *   - Quadratic cells keep their corner nodes first in VTK ordering, so surface
 *     / boundary extraction only ever looks at the first `cornerCount` nodes.
 */

import { EntityBlock, FieldData, MdpaDiagnostic, MdpaModel } from "../types";
import { VtkCellType as C } from "../geometryMap";

// --- boundary-face tables (corner-index based; mirror meshQuality.ts) --------

const TET_FACES = [
  [0, 1, 2],
  [0, 3, 1],
  [0, 2, 3],
  [1, 3, 2],
];
const HEX_FACES = [
  [0, 1, 2, 3],
  [4, 7, 6, 5],
  [0, 4, 5, 1],
  [1, 5, 6, 2],
  [2, 6, 7, 3],
  [3, 7, 4, 0],
];
const WEDGE_FACES = [
  [0, 1, 2],
  [3, 5, 4],
  [0, 3, 4, 1],
  [1, 4, 5, 2],
  [2, 5, 3, 0],
];
const PYRAMID_FACES = [
  [0, 3, 2, 1],
  [0, 1, 4],
  [1, 2, 4],
  [2, 3, 4],
  [3, 0, 4],
];

export type CellCategory = "point" | "line" | "surface" | "volume" | "unknown";

/** Topological category of a VTK cell type. */
export function cellCategory(type: number | undefined): CellCategory {
  switch (type) {
    case C.VERTEX:
      return "point";
    case C.LINE:
    case C.QUADRATIC_EDGE:
      return "line";
    case C.TRIANGLE:
    case C.QUADRATIC_TRIANGLE:
    case C.QUAD:
    case C.QUADRATIC_QUAD:
    case C.BIQUADRATIC_QUAD:
      return "surface";
    case C.TETRA:
    case C.QUADRATIC_TETRA:
    case C.HEXAHEDRON:
    case C.QUADRATIC_HEXAHEDRON:
    case C.TRIQUADRATIC_HEXAHEDRON:
    case C.WEDGE:
    case C.QUADRATIC_WEDGE:
    case C.PYRAMID:
    case C.QUADRATIC_PYRAMID:
      return "volume";
    default:
      return "unknown";
  }
}

/** Number of corner (linear) nodes for a VTK cell type. */
export function cornerCount(type: number | undefined): number {
  switch (type) {
    case C.VERTEX:
      return 1;
    case C.LINE:
    case C.QUADRATIC_EDGE:
      return 2;
    case C.TRIANGLE:
    case C.QUADRATIC_TRIANGLE:
      return 3;
    case C.QUAD:
    case C.QUADRATIC_QUAD:
    case C.BIQUADRATIC_QUAD:
    case C.TETRA:
    case C.QUADRATIC_TETRA:
      return 4;
    case C.PYRAMID:
    case C.QUADRATIC_PYRAMID:
      return 5;
    case C.WEDGE:
    case C.QUADRATIC_WEDGE:
      return 6;
    case C.HEXAHEDRON:
    case C.QUADRATIC_HEXAHEDRON:
    case C.TRIQUADRATIC_HEXAHEDRON:
      return 8;
    default:
      return 0;
  }
}

/** Corner-index face table for a volume cell type, or null for non-volume. */
export function volumeFaces(type: number | undefined): number[][] | null {
  switch (type) {
    case C.TETRA:
    case C.QUADRATIC_TETRA:
      return TET_FACES;
    case C.HEXAHEDRON:
    case C.QUADRATIC_HEXAHEDRON:
    case C.TRIQUADRATIC_HEXAHEDRON:
      return HEX_FACES;
    case C.WEDGE:
    case C.QUADRATIC_WEDGE:
      return WEDGE_FACES;
    case C.PYRAMID:
    case C.QUADRATIC_PYRAMID:
      return PYRAMID_FACES;
    default:
      return null;
  }
}

/** Maps every node id to its 0-based index in `model.coords`. */
export function nodeIndexMap(model: MdpaModel): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) {
    map.set(model.nodeIds[i], i);
  }
  return map;
}

/** Trims float32 noise: 0.10000000149 → "0.1", integers stay integral. */
export function num(x: number): string {
  if (!isFinite(x)) return "0";
  if (Number.isInteger(x)) return String(x);
  return String(parseFloat(x.toPrecision(7)));
}

/** One kind order so element/condition/geometry cells map deterministically. */
/** The order `buildCellLayout` emits blocks in; `meshioBlockOrder` mirrors it. */
export const KIND_ORDER: EntityBlock["kind"][] = ["Elements", "Conditions", "Geometries"];

export interface LaidOutCell {
  /** VTK cell type id. */
  type: number;
  /** 0-based node indices into `model.coords`. */
  nodes: number[];
  /**
   * The source `EntityBlock`'s name.  Carried so a writer can group cells back
   * by their original block rather than only by (type, stride) — meshioConvert
   * needs it to name the meshio blocks it emits and to build the `Cell` region
   * that makes an Exodus `eb_names` entry (or a MED family) recoverable.
   */
  blockName: string;
  /**
   * Index into the kind-sorted block list — the cell's SOURCE BLOCK identity.
   *
   * `blockName` alone is not unique: `mergeMesh` appends another mesh's blocks
   * with their names intact, so two distinct `EntityBlock`s can share a name,
   * type and stride. Grouping by name then fused them into one meshio block
   * while every consumer walking `model.blocks` still counted two.
   */
  blockIndex: number;
}

export interface CellLayout {
  cells: LaidOutCell[];
  /** entity id → flat cell index, for ElementalData (Elements blocks). */
  elementIdToCell: Map<number, number>;
  /** entity id → flat cell index, for ConditionalData (Conditions blocks). */
  conditionIdToCell: Map<number, number>;
  /**
   * entity id → flat cell index, for Geometries blocks.  No field kind writes
   * through this one (there is no `GeometricalData`); it exists so a
   * SubModelPart's `geometryIds` can be resolved to cells like its elements
   * and conditions are.
   */
  geometryIdToCell: Map<number, number>;
  skipped: number;
}

/**
 * Flattens every block into one ordered cell list (Elements → Conditions →
 * Geometries), remapping connectivity node-ids to 0-based indices.  Cells with
 * an unknown VTK type or a dangling node id are skipped (with a diagnostic).
 */
export function buildCellLayout(
  model: MdpaModel,
  diagnostics: MdpaDiagnostic[]
): CellLayout {
  const idToIndex = nodeIndexMap(model);
  const cells: LaidOutCell[] = [];
  const elementIdToCell = new Map<number, number>();
  const conditionIdToCell = new Map<number, number>();
  const geometryIdToCell = new Map<number, number>();
  let skipped = 0;

  const blocks = [...model.blocks].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  );

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const type = block.vtkCellType;
    if (type === undefined) {
      skipped += block.count;
      diagnostics.push({
        line: 0,
        message: `Block "${block.name}" has no VTK cell type; ${block.count} cell(s) skipped.`,
      });
      continue;
    }
    for (let c = 0; c < block.count; c++) {
      const nodes: number[] = [];
      let ok = true;
      for (let k = 0; k < block.stride; k++) {
        const idx = idToIndex.get(block.connectivity[c * block.stride + k]);
        if (idx === undefined) {
          ok = false;
          break;
        }
        nodes.push(idx);
      }
      if (!ok) {
        skipped++;
        continue;
      }
      const cellIndex = cells.length;
      cells.push({ type, nodes, blockName: block.name, blockIndex: bi });
      const entityId = block.entityIds[c];
      if (block.kind === "Elements") elementIdToCell.set(entityId, cellIndex);
      else if (block.kind === "Conditions") conditionIdToCell.set(entityId, cellIndex);
      else geometryIdToCell.set(entityId, cellIndex);
    }
  }

  return { cells, elementIdToCell, conditionIdToCell, geometryIdToCell, skipped };
}

/**
 * Extracts the drawable outer surface as flat triangle triples (0-based node
 * indices).  Surface cells contribute directly; volume cells contribute the
 * faces that appear exactly once (the boundary).  Only corner nodes are used.
 */
export function surfaceTriangles(
  model: MdpaModel,
  diagnostics: MdpaDiagnostic[],
  opts: { volumeOnly?: boolean } = {}
): number[] {
  const idToIndex = nodeIndexMap(model);
  const surfacePolys: number[][] = [];
  const faceRecords = new Map<string, { poly: number[]; count: number }>();

  const cornerIndices = (block: EntityBlock, c: number, corners: number): number[] | null => {
    const out: number[] = [];
    for (let k = 0; k < corners; k++) {
      const idx = idToIndex.get(block.connectivity[c * block.stride + k]);
      if (idx === undefined) return null;
      out.push(idx);
    }
    return out;
  };

  for (const block of model.blocks) {
    const type = block.vtkCellType;
    const cat = cellCategory(type);
    if (cat !== "surface" && cat !== "volume") continue;
    const corners = Math.min(cornerCount(type) || block.stride, block.stride);
    for (let c = 0; c < block.count; c++) {
      const ci = cornerIndices(block, c, corners);
      if (!ci) continue;
      if (cat === "surface") {
        if (!opts.volumeOnly) surfacePolys.push(ci);
      } else {
        for (const face of volumeFaces(type) ?? []) {
          const poly = face.map((li) => ci[li]);
          const key = [...poly].sort((a, b) => a - b).join(",");
          const rec = faceRecords.get(key);
          if (rec) rec.count++;
          else faceRecords.set(key, { poly, count: 1 });
        }
      }
    }
  }

  const tris: number[] = [];
  const fanTriangulate = (poly: number[]): void => {
    for (let i = 1; i + 1 < poly.length; i++) {
      tris.push(poly[0], poly[i], poly[i + 1]);
    }
  };
  for (const poly of surfacePolys) fanTriangulate(poly);
  for (const rec of faceRecords.values()) {
    if (rec.count === 1) fanTriangulate(rec.poly);
  }
  if (tris.length === 0 && model.blocks.length > 0) {
    diagnostics.push({
      line: 0,
      message: "No surface facets could be extracted for this format.",
    });
  }
  return tris;
}

/**
 * Builds a positional value array for point (nodal) field data of size
 * `nodeCount * components`, placing each record by its node id.  Missing
 * records default to 0.
 */
export function pointFieldArray(field: FieldData, model: MdpaModel): Float64Array {
  const idToIndex = nodeIndexMap(model);
  const comp = field.components;
  const out = new Float64Array(model.nodeCount * comp);
  for (let i = 0; i < field.ids.length; i++) {
    const idx = idToIndex.get(field.ids[i]);
    if (idx === undefined) continue;
    for (let k = 0; k < comp; k++) out[idx * comp + k] = field.values[i * comp + k];
  }
  return out;
}

/**
 * Builds a positional value array for cell (Elemental/Conditional) field data
 * of size `totalCells * components`, placing each record by the matching cell
 * index.  Missing records default to 0.
 */
export function cellFieldArray(
  field: FieldData,
  layout: CellLayout
): Float64Array {
  const comp = field.components;
  const out = new Float64Array(layout.cells.length * comp);
  const map = field.kind === "Conditional" ? layout.conditionIdToCell : layout.elementIdToCell;
  for (let i = 0; i < field.ids.length; i++) {
    const cell = map.get(field.ids[i]);
    if (cell === undefined) continue;
    for (let k = 0; k < comp; k++) out[cell * comp + k] = field.values[i * comp + k];
  }
  return out;
}
