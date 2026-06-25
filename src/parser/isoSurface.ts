// Scalar isosurface extraction for unstructured meshes.
//
// vtk.js ships no general unstructured-grid contour filter (only image marching
// cubes/squares), so we extract the isosurface ourselves. Every volume cell is
// decomposed into tetrahedra and run through marching tetrahedra; 2D / surface-
// only meshes fall back to marching triangles, producing iso-lines.
//
// Pure module: imports only the shared data model and the VTK cell-type ids
// (no DOM, no vtk.js, no vscode) so it runs both inside the webview and in plain
// Node unit tests — mirroring meshQuality.ts.

import { FieldData, MdpaModel } from "./types";
import { VtkCellType } from "./geometryMap";

const C = VtkCellType;

export interface IsoSurfaceResult {
  /** Interpolated crossing points, x,y,z triples in world coordinates. */
  points: Float32Array;
  /** Triangle index triples into `points` (3D volume isosurface). */
  triangles: Uint32Array;
  /** Index pairs into `points` when the input had no volume (iso-lines). */
  lines: Uint32Array;
  /** True when the result is iso-lines (2D / surface-only input). */
  is2D: boolean;
}

type Vec3 = [number, number, number];

// --- cell decomposition into tetrahedra (local-index tables) -------------
// Tables reference the linear corner ordering shared with meshBuilder/meshQuality.
const TET_TETS = [[0, 1, 2, 3]];
const PYRAMID_TETS = [
  [0, 1, 2, 4],
  [0, 2, 3, 4],
];
const WEDGE_TETS = [
  [0, 1, 2, 3],
  [1, 2, 3, 4],
  [2, 3, 4, 5],
];
// Standard 6-tet decomposition around the space diagonal 0-6. Exact for tet
// meshes (the common case for scalar fields); adjacent hexes can leave hairline
// cracks where shared-face diagonals disagree — acceptable for visualization.
const HEX_TETS = [
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
  [0, 5, 1, 6],
];

// Triangle decomposition for marching-triangles (2D / surface fallback).
const TRI_TRIS = [[0, 1, 2]];
const QUAD_TRIS = [
  [0, 1, 2],
  [0, 2, 3],
];

interface CellTopo {
  corners: number;
  tets?: number[][]; // volume decomposition
  tris?: number[][]; // surface decomposition
}

function cellTopo(cellType?: number): CellTopo {
  switch (cellType) {
    case C.TRIANGLE:
    case C.QUADRATIC_TRIANGLE:
      return { corners: 3, tris: TRI_TRIS };
    case C.QUAD:
    case C.QUADRATIC_QUAD:
    case C.BIQUADRATIC_QUAD:
      return { corners: 4, tris: QUAD_TRIS };
    case C.TETRA:
    case C.QUADRATIC_TETRA:
      return { corners: 4, tets: TET_TETS };
    case C.PYRAMID:
    case C.QUADRATIC_PYRAMID:
      return { corners: 5, tets: PYRAMID_TETS };
    case C.WEDGE:
    case C.QUADRATIC_WEDGE:
      return { corners: 6, tets: WEDGE_TETS };
    case C.HEXAHEDRON:
    case C.QUADRATIC_HEXAHEDRON:
    case C.TRIQUADRATIC_HEXAHEDRON:
      return { corners: 8, tets: HEX_TETS };
    default:
      return { corners: 0 };
  }
}

// Reduces a FieldData record to a single scalar (value for scalars, magnitude
// for vectors) keyed by entity/node id.
function scalarByNode(field: FieldData): Map<number, number> {
  const map = new Map<number, number>();
  const { ids, values, components } = field;
  for (let i = 0; i < ids.length; i++) {
    if (components === 1) {
      map.set(ids[i], values[i]);
    } else {
      let sum = 0;
      for (let k = 0; k < components; k++) {
        const v = values[i * components + k];
        sum += v * v;
      }
      map.set(ids[i], Math.sqrt(sum));
    }
  }
  return map;
}

export function computeIsoSurface(
  model: MdpaModel,
  field: FieldData,
  isoValue: number
): IsoSurfaceResult {
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) nodeIndex.set(model.nodeIds[i], i);
  const scalar = scalarByNode(field);

  const coordOf = (nodeId: number): Vec3 | undefined => {
    const idx = nodeIndex.get(nodeId);
    if (idx === undefined) return undefined;
    const o = idx * 3;
    return [model.coords[o], model.coords[o + 1], model.coords[o + 2]];
  };

  // Welded crossing points. Key is the unordered node-id pair; because the
  // interpolation parameter depends only on (idLow, idHigh, isoValue), the same
  // physical edge welds to one point across every cell that touches it.
  const points: number[] = [];
  const edgePoint = new Map<string, number>();

  const crossing = (nA: number, nB: number): number | undefined => {
    const lo = nA < nB ? nA : nB;
    const hi = nA < nB ? nB : nA;
    const key = `${lo}_${hi}`;
    const cached = edgePoint.get(key);
    if (cached !== undefined) return cached;
    const sLo = scalar.get(lo);
    const sHi = scalar.get(hi);
    const cLo = coordOf(lo);
    const cHi = coordOf(hi);
    if (sLo === undefined || sHi === undefined || !cLo || !cHi) return undefined;
    const denom = sHi - sLo;
    const t = denom === 0 ? 0.5 : (isoValue - sLo) / denom;
    const idx = points.length / 3;
    points.push(
      cLo[0] + t * (cHi[0] - cLo[0]),
      cLo[1] + t * (cHi[1] - cLo[1]),
      cLo[2] + t * (cHi[2] - cLo[2])
    );
    edgePoint.set(key, idx);
    return idx;
  };

  const triangles: number[] = [];
  const lines: number[] = [];

  // Does the mesh carry any volume cells we can contour into surfaces?
  let hasVolume = false;
  for (const block of model.blocks) {
    if (cellTopo(block.vtkCellType).tets) {
      hasVolume = true;
      break;
    }
  }

  if (hasVolume) {
    marchVolumes(model, isoValue, scalar, crossing, triangles);
    return {
      points: Float32Array.from(points),
      triangles: Uint32Array.from(triangles),
      lines: new Uint32Array(0),
      is2D: false,
    };
  }

  marchSurfaces(model, isoValue, scalar, crossing, lines);
  return {
    points: Float32Array.from(points),
    triangles: new Uint32Array(0),
    lines: Uint32Array.from(lines),
    is2D: true,
  };
}

// Marching tetrahedra over every volume cell. Emits triangles into `out`.
function marchVolumes(
  model: MdpaModel,
  isoValue: number,
  scalar: Map<number, number>,
  crossing: (a: number, b: number) => number | undefined,
  out: number[]
): void {
  for (const block of model.blocks) {
    const t = cellTopo(block.vtkCellType);
    if (!t.tets) continue;
    for (let i = 0; i < block.count; i++) {
      const base = i * block.stride;
      const corner: number[] = [];
      let ok = true;
      for (let k = 0; k < t.corners; k++) {
        const nid = block.connectivity[base + k];
        if (scalar.get(nid) === undefined) {
          ok = false;
          break;
        }
        corner.push(nid);
      }
      if (!ok) continue;
      for (const tet of t.tets) {
        marchTet(
          corner[tet[0]],
          corner[tet[1]],
          corner[tet[2]],
          corner[tet[3]],
          isoValue,
          scalar,
          crossing,
          out
        );
      }
    }
  }
}

// Sign-based marching tetrahedra: classify the 4 vertices relative to the iso
// value and emit 1 triangle (1 vs 3 split) or 2 triangles (2 vs 2 split).
function marchTet(
  a: number,
  b: number,
  c: number,
  d: number,
  iso: number,
  scalar: Map<number, number>,
  crossing: (x: number, y: number) => number | undefined,
  out: number[]
): void {
  const v = [a, b, c, d];
  const below: number[] = [];
  const above: number[] = [];
  for (const n of v) {
    if (scalar.get(n)! < iso) below.push(n);
    else above.push(n);
  }
  const nb = below.length;

  const emitTri = (p: (number | undefined)[]): void => {
    if (p[0] === undefined || p[1] === undefined || p[2] === undefined) return;
    out.push(p[0], p[1], p[2]);
  };

  if (nb === 1 || nb === 3) {
    // One vertex isolated on its side: triangle across its three edges.
    const apex = nb === 1 ? below[0] : above[0];
    const others = nb === 1 ? above : below;
    emitTri([crossing(apex, others[0]), crossing(apex, others[1]), crossing(apex, others[2])]);
  } else if (nb === 2) {
    // Quad across the four edges between the below-pair and above-pair.
    const [b0, b1] = below;
    const [a0, a1] = above;
    const p00 = crossing(b0, a0);
    const p01 = crossing(b0, a1);
    const p11 = crossing(b1, a1);
    const p10 = crossing(b1, a0);
    emitTri([p00, p01, p11]);
    emitTri([p00, p11, p10]);
  }
  // nb === 0 or 4: tetra entirely on one side, no surface.
}

// Marching triangles over surface cells. Emits line segments into `out`.
function marchSurfaces(
  model: MdpaModel,
  isoValue: number,
  scalar: Map<number, number>,
  crossing: (a: number, b: number) => number | undefined,
  out: number[]
): void {
  for (const block of model.blocks) {
    const t = cellTopo(block.vtkCellType);
    if (!t.tris) continue;
    for (let i = 0; i < block.count; i++) {
      const base = i * block.stride;
      const corner: number[] = [];
      let ok = true;
      for (let k = 0; k < t.corners; k++) {
        const nid = block.connectivity[base + k];
        if (scalar.get(nid) === undefined) {
          ok = false;
          break;
        }
        corner.push(nid);
      }
      if (!ok) continue;
      for (const tri of t.tris) {
        marchTri(
          corner[tri[0]],
          corner[tri[1]],
          corner[tri[2]],
          isoValue,
          scalar,
          crossing,
          out
        );
      }
    }
  }
}

function marchTri(
  a: number,
  b: number,
  c: number,
  iso: number,
  scalar: Map<number, number>,
  crossing: (x: number, y: number) => number | undefined,
  out: number[]
): void {
  const v = [a, b, c];
  const below: number[] = [];
  const above: number[] = [];
  for (const n of v) {
    if (scalar.get(n)! < iso) below.push(n);
    else above.push(n);
  }
  if (below.length === 0 || above.length === 0) return;
  // The isolated vertex is whichever side has exactly one member.
  const apex = below.length === 1 ? below[0] : above[0];
  const others = below.length === 1 ? above : below;
  const p0 = crossing(apex, others[0]);
  const p1 = crossing(apex, others[1]);
  if (p0 === undefined || p1 === undefined) return;
  out.push(p0, p1);
}
