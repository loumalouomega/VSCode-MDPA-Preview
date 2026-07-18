// Mesh-size metrics: nodal size (Kratos NODAL_H) and element size, plus the
// box-and-whisker statistics used by the floating Mesh-size panel.
//
// Pure module: imports only the shared data model and the VTK cell-type ids
// (no DOM, no vtk.js, no vscode) so it can run inside the webview, the MCP
// server, and plain Node unit tests.
//
//   - Nodal size (NODAL_H): a faithful port of Kratos' FindNodalHProcess — for
//     each element, over every pair of its nodes, the distance is taken and the
//     per-node value is the minimum such distance. (For a linear element this is
//     the minimum incident edge length; higher-order geometries include their
//     mid-side nodes, exactly as the Kratos process does.)
//   - Element size (ELEMENT_H): the element characteristic length = the mean of
//     its unique edge lengths (edges recovered from the boundary-face tables,
//     matching meshQuality.ts).
//   - Element box-whisker stats + IQR outliers (elements below Q1-1.5·IQR or
//     above Q3+1.5·IQR) drive the panel's whisker plot and the small/big
//     highlight overlays.

import { DerivedMeshData, FieldData, MdpaModel } from "./types";
import { VtkCellType } from "./geometryMap";

// --- topology -----------------------------------------------------------
type Category = "point" | "line" | "surface" | "volume" | "unknown";
interface Topo {
  corners: number;
  category: Category;
  faces?: number[][];
}

const C = VtkCellType;

// Local copies of the boundary-face tables (kept in sync with
// webview/meshBuilder.ts and meshQuality.ts). Duplicated so this module stays
// free of the vtk.js import that meshBuilder pulls in.
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

function topo(cellType?: number): Topo {
  switch (cellType) {
    case C.VERTEX:
      return { corners: 1, category: "point" };
    case C.LINE:
    case C.QUADRATIC_EDGE:
      return { corners: 2, category: "line" };
    case C.TRIANGLE:
    case C.QUADRATIC_TRIANGLE:
      return { corners: 3, category: "surface", faces: [[0, 1, 2]] };
    case C.QUAD:
    case C.QUADRATIC_QUAD:
    case C.BIQUADRATIC_QUAD:
      return { corners: 4, category: "surface", faces: [[0, 1, 2, 3]] };
    case C.TETRA:
    case C.QUADRATIC_TETRA:
      return { corners: 4, category: "volume", faces: TET_FACES };
    case C.HEXAHEDRON:
    case C.QUADRATIC_HEXAHEDRON:
    case C.TRIQUADRATIC_HEXAHEDRON:
      return { corners: 8, category: "volume", faces: HEX_FACES };
    case C.WEDGE:
    case C.QUADRATIC_WEDGE:
      return { corners: 6, category: "volume", faces: WEDGE_FACES };
    case C.PYRAMID:
    case C.QUADRATIC_PYRAMID:
      return { corners: 5, category: "volume", faces: PYRAMID_FACES };
    default:
      return { corners: 0, category: "unknown" };
  }
}

// --- vector helpers -----------------------------------------------------
type Vec3 = [number, number, number];
function dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Mean of an element's unique edge lengths (its characteristic length).
// Lines use their single segment; surface/volume cells recover edges from the
// perimeter of every face (every element edge lies on at least one face).
function elementMeanEdge(corners: Vec3[], t: Topo): number | undefined {
  if (t.category === "line") {
    if (corners.length < 2) return undefined;
    return dist(corners[0], corners[1]);
  }
  if (!t.faces || corners.length < t.corners) return undefined;
  const edgeLen = new Map<number, number>();
  const keyOf = (i: number, j: number) => (i < j ? i * 64 + j : j * 64 + i);
  for (const face of t.faces) {
    const n = face.length;
    for (let k = 0; k < n; k++) {
      const a = face[k];
      const b = face[(k + 1) % n];
      const key = keyOf(a, b);
      if (!edgeLen.has(key)) edgeLen.set(key, dist(corners[a], corners[b]));
    }
  }
  let sum = 0;
  let count = 0;
  for (const l of edgeLen.values()) {
    sum += l;
    count++;
  }
  return count > 0 ? sum / count : undefined;
}

// --- box-whisker statistics --------------------------------------------
export interface BoxStats {
  count: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
  /** Population standard deviation, sqrt(mean((x-mean)^2)). */
  std: number;
  iqr: number;
  /** Lower / upper Tukey fences (Q1-1.5·IQR / Q3+1.5·IQR), clamped to [min,max]. */
  whiskerLo: number;
  whiskerHi: number;
}

// Linear-interpolation quantile (numpy default), on an already-sorted array.
function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

export function boxStats(values: number[]): BoxStats {
  if (values.length === 0) {
    return {
      count: 0,
      min: NaN,
      q1: NaN,
      median: NaN,
      q3: NaN,
      max: NaN,
      mean: NaN,
      std: NaN,
      iqr: NaN,
      whiskerLo: NaN,
      whiskerHi: NaN,
    };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  let sum = 0;
  for (const v of sorted) sum += v;
  const mean = sum / sorted.length;
  let sq = 0;
  for (const v of sorted) sq += (v - mean) * (v - mean);
  const std = Math.sqrt(sq / sorted.length);
  // Tukey fences, clamped to the data range so the whiskers never overshoot.
  const whiskerLo = Math.max(min, q1 - 1.5 * iqr);
  const whiskerHi = Math.min(max, q3 + 1.5 * iqr);
  return { count: sorted.length, min, q1, median, q3, max, mean, std, iqr, whiskerLo, whiskerHi };
}

// --- result -------------------------------------------------------------
export interface MeshSizeResult {
  /** Nodal size field (Kratos NODAL_H), one value per element-touched node. */
  nodalH: FieldData;
  /** Element size field (mean edge length), one value per analysed element. */
  elementSize: FieldData;
  /** Box-whisker statistics of the element size distribution. */
  elementStats: BoxStats;
  /** Box-whisker statistics of the nodal size distribution. */
  nodalStats: BoxStats;
  /** Element ids below the lower Tukey fence (unusually small elements). */
  smallElementIds: number[];
  /** Element ids above the upper Tukey fence (unusually large elements). */
  bigElementIds: number[];
  elementCount: number;
  analyzedCount: number;
  elementTypes: string[];
}

// --- main entry ---------------------------------------------------------
export function computeMeshSize(model: MdpaModel): MeshSizeResult {
  // nodeId (1-based Kratos id) -> coord index.
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) nodeIndex.set(model.nodeIds[i], i);
  const coordOf = (nodeId: number): Vec3 | undefined => {
    const idx = nodeIndex.get(nodeId);
    if (idx === undefined) return undefined;
    const o = idx * 3;
    return [model.coords[o], model.coords[o + 1], model.coords[o + 2]];
  };

  // Analyse Elements; if a mesh has none, fall back to line/surface/volume cells
  // in any block so condition/geometry-only meshes still report something.
  let blocks = model.blocks.filter((b) => b.kind === "Elements");
  if (blocks.length === 0) {
    blocks = model.blocks.filter((b) => {
      const cat = topo(b.vtkCellType).category;
      return cat === "line" || cat === "surface" || cat === "volume";
    });
  }

  // NODAL_H accumulator: node id -> min pair distance seen so far.
  const nodalH = new Map<number, number>();
  const elementIds: number[] = [];
  const elementSizes: number[] = [];
  const elementTypes = new Set<string>();
  let elementCount = 0;
  let analyzedCount = 0;

  for (const block of blocks) {
    const t = topo(block.vtkCellType);
    elementCount += block.count;
    if (t.category !== "line" && t.category !== "surface" && t.category !== "volume") continue;

    for (let i = 0; i < block.count; i++) {
      const base = i * block.stride;
      // Gather every geometry node of the element (all-pairs NODAL_H uses them
      // all, exactly like Kratos' r_geom loop).
      const ids: number[] = [];
      const pts: Vec3[] = [];
      let ok = true;
      for (let k = 0; k < block.stride; k++) {
        const nid = block.connectivity[base + k];
        const p = coordOf(nid);
        if (!p) {
          ok = false;
          break;
        }
        ids.push(nid);
        pts.push(p);
      }
      if (!ok || pts.length < 2) continue;

      // NODAL_H: min over all node pairs of the element, applied to both endpoints.
      for (let k = 0; k < pts.length - 1; k++) {
        for (let l = k + 1; l < pts.length; l++) {
          const d = dist(pts[k], pts[l]);
          const a = nodalH.get(ids[k]);
          if (a === undefined || d < a) nodalH.set(ids[k], d);
          const b = nodalH.get(ids[l]);
          if (b === undefined || d < b) nodalH.set(ids[l], d);
        }
      }

      // Element size = mean edge length (from the corner nodes / face tables).
      const size = elementMeanEdge(pts.slice(0, Math.max(t.corners, 2)), t);
      if (size === undefined || !(size > 0)) continue;
      analyzedCount++;
      elementTypes.add(block.name);
      elementIds.push(block.entityIds[i]);
      elementSizes.push(size);
    }
  }

  // Element box-whisker + IQR outliers. A size-scaled tolerance keeps float
  // noise (Float32 coords give ~1e-7 relative jitter) from spuriously flagging
  // near-fence elements when the IQR is (near) zero — e.g. a uniform mesh.
  const elementStats = boxStats(elementSizes);
  const eps = 1e-6 * Math.max(1e-30, Math.abs(elementStats.max));
  const smallElementIds: number[] = [];
  const bigElementIds: number[] = [];
  for (let i = 0; i < elementIds.length; i++) {
    const s = elementSizes[i];
    if (s < elementStats.whiskerLo - eps) smallElementIds.push(elementIds[i]);
    else if (s > elementStats.whiskerHi + eps) bigElementIds.push(elementIds[i]);
  }

  // Build the NODAL_H field over the touched nodes, in model node order.
  const nodalIds: number[] = [];
  const nodalValues: number[] = [];
  for (let i = 0; i < model.nodeCount; i++) {
    const nid = model.nodeIds[i];
    const v = nodalH.get(nid);
    if (v !== undefined) {
      nodalIds.push(nid);
      nodalValues.push(v);
    }
  }

  const nodalField: FieldData = {
    kind: "Nodal",
    variable: "NODAL_H",
    components: 1,
    ids: Int32Array.from(nodalIds),
    values: Float64Array.from(nodalValues),
  };
  const elementField: FieldData = {
    kind: "Elemental",
    variable: "ELEMENT_H",
    components: 1,
    ids: Int32Array.from(elementIds),
    values: Float64Array.from(elementSizes),
  };

  return {
    nodalH: nodalField,
    elementSize: elementField,
    elementStats,
    nodalStats: boxStats(nodalValues),
    smallElementIds,
    bigElementIds,
    elementCount,
    analyzedCount,
    elementTypes: Array.from(elementTypes),
  };
}

/**
 * Stores the computed NODAL_H / ELEMENT_H fields on the model's auxiliary
 * `derived` slot (kept off `model.fields`, so it never serializes). Future
 * operations can read `model.derived`.
 */
export function attachMeshSizeToModel(model: MdpaModel, result: MeshSizeResult): void {
  const derived: DerivedMeshData = model.derived ?? {};
  derived.nodalH = result.nodalH;
  derived.elementSize = result.elementSize;
  model.derived = derived;
}

export type MeshSizeTarget = "nodal" | "element" | "both";

/**
 * Pure transform (input never mutated): appends the mesh-size fields to
 * `model.fields` so they persist to the .mdpa on Save and show in the Field
 * dropdown, and also refreshes the in-memory `derived` slot. An existing field
 * of the same kind+variable is replaced. Backs the `writeMeshSizeFields`
 * operation.
 */
export function writeMeshSizeFields(
  model: MdpaModel,
  target: MeshSizeTarget
): { model: MdpaModel; added: number } {
  const result = computeMeshSize(model);
  const toAdd: FieldData[] = [];
  if (target === "nodal" || target === "both") toAdd.push(result.nodalH);
  if (target === "element" || target === "both") toAdd.push(result.elementSize);
  // Drop any prior field of the same kind+variable, then append the fresh one.
  const kept = model.fields.filter(
    (f) => !toAdd.some((a) => a.kind === f.kind && a.variable === f.variable)
  );
  const newModel: MdpaModel = {
    ...model,
    fields: [...kept, ...toAdd],
    derived: { ...(model.derived ?? {}), nodalH: result.nodalH, elementSize: result.elementSize },
  };
  return { model: newModel, added: toAdd.length };
}
