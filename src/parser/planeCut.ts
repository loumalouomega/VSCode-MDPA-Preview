// Plane cross-section extraction for unstructured volume meshes.
//
// Cutting a convex volume cell with a plane yields a single convex polygon:
// the crossing points of the cell's edges, ordered by angle around their
// centroid in the plane. Emitting one polygon per element (rather than
// marching-tet triangles) preserves the element intersection pattern, so the
// section can be rendered with true per-element edges.
//
// Pure module: imports only the shared data model and the VTK cell-type ids
// (no DOM, no vtk.js, no vscode) so it runs both inside the webview and in
// plain Node unit tests — mirroring isoSurface.ts / meshQuality.ts.

import { MdpaModel } from "./types";
import { VtkCellType } from "./geometryMap";

const C = VtkCellType;

type Vec3 = [number, number, number];

export interface PlaneCutResult {
  /** Edge-crossing points, x,y,z triples in world coordinates, welded per mesh edge. */
  points: Float32Array;
  /** VTK poly connectivity [n, i0..i(n-1), ...] — one convex polygon per cut element. */
  polys: Uint32Array;
  /** Number of polygons in `polys`. */
  polyCount: number;
  /** Per-polygon owning element entity id. */
  cellIds: Int32Array;
  /** Per-point source mesh edge: low node id, high node id, interpolation t (low→high). */
  edgeNodeA: Int32Array;
  edgeNodeB: Int32Array;
  edgeT: Float32Array;
}

// --- cell edge tables (local corner indices) -----------------------------
// Corner ordering matches the linear VTK ordering shared with meshBuilder /
// isoSurface / meshQuality.
const TET_EDGES = [
  [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
];
const PYRAMID_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0], // base
  [0, 4], [1, 4], [2, 4], [3, 4], // to apex
];
const WEDGE_EDGES = [
  [0, 1], [1, 2], [2, 0], // bottom triangle
  [3, 4], [4, 5], [5, 3], // top triangle
  [0, 3], [1, 4], [2, 5], // verticals
];
const HEX_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0], // bottom ring
  [4, 5], [5, 6], [6, 7], [7, 4], // top ring
  [0, 4], [1, 5], [2, 6], [3, 7], // verticals
];

interface CellEdges {
  corners: number;
  edges: number[][];
}

function cellEdges(cellType?: number): CellEdges | undefined {
  switch (cellType) {
    case C.TETRA:
    case C.QUADRATIC_TETRA:
      return { corners: 4, edges: TET_EDGES };
    case C.PYRAMID:
    case C.QUADRATIC_PYRAMID:
      return { corners: 5, edges: PYRAMID_EDGES };
    case C.WEDGE:
    case C.QUADRATIC_WEDGE:
      return { corners: 6, edges: WEDGE_EDGES };
    case C.HEXAHEDRON:
    case C.QUADRATIC_HEXAHEDRON:
    case C.TRIQUADRATIC_HEXAHEDRON:
      return { corners: 8, edges: HEX_EDGES };
    default:
      return undefined; // surface / line / point cells carry no interior
  }
}

/** Two orthonormal vectors [u, v] spanning the plane perpendicular to `nrm`. */
export function planeBasis(nrm: Vec3): [Vec3, Vec3] {
  const seed: Vec3 =
    Math.abs(nrm[0]) <= Math.abs(nrm[1]) && Math.abs(nrm[0]) <= Math.abs(nrm[2])
      ? [1, 0, 0]
      : Math.abs(nrm[1]) <= Math.abs(nrm[2])
      ? [0, 1, 0]
      : [0, 0, 1];
  const dot = seed[0] * nrm[0] + seed[1] * nrm[1] + seed[2] * nrm[2];
  const u: Vec3 = [seed[0] - dot * nrm[0], seed[1] - dot * nrm[1], seed[2] - dot * nrm[2]];
  const uLen = Math.sqrt(u[0] ** 2 + u[1] ** 2 + u[2] ** 2);
  u[0] /= uLen; u[1] /= uLen; u[2] /= uLen;
  const v: Vec3 = [
    nrm[1] * u[2] - nrm[2] * u[1],
    nrm[2] * u[0] - nrm[0] * u[2],
    nrm[0] * u[1] - nrm[1] * u[0],
  ];
  return [u, v];
}

export function computePlaneCut(model: MdpaModel, origin: Vec3, normal: Vec3): PlaneCutResult {
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) nodeIndex.set(model.nodeIds[i], i);

  // Signed distance per node, computed once. Nodes landing exactly on the
  // plane (within a bounds-relative epsilon) are pushed to the positive side;
  // doing it per node keeps welds coherent across all cells touching the node.
  const b = model.bounds;
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const eps = 1e-9 * (diag || 1);
  const dist = new Float64Array(model.nodeCount);
  for (let i = 0; i < model.nodeCount; i++) {
    const o = i * 3;
    let d =
      normal[0] * (model.coords[o] - origin[0]) +
      normal[1] * (model.coords[o + 1] - origin[1]) +
      normal[2] * (model.coords[o + 2] - origin[2]);
    if (Math.abs(d) < eps) d = eps;
    dist[i] = d;
  }

  // Welded crossing points: one per crossed mesh edge, keyed by the unordered
  // node-id pair (same trick as isoSurface.ts).
  const points: number[] = [];
  const edgeNodeA: number[] = [];
  const edgeNodeB: number[] = [];
  const edgeT: number[] = [];
  const edgePoint = new Map<string, number>();

  const crossing = (nA: number, nB: number): number => {
    const lo = nA < nB ? nA : nB;
    const hi = nA < nB ? nB : nA;
    const key = `${lo}_${hi}`;
    const cached = edgePoint.get(key);
    if (cached !== undefined) return cached;
    const iLo = nodeIndex.get(lo)!;
    const iHi = nodeIndex.get(hi)!;
    const dLo = dist[iLo];
    const t = dLo / (dLo - dist[iHi]);
    const oLo = iLo * 3;
    const oHi = iHi * 3;
    const idx = points.length / 3;
    points.push(
      model.coords[oLo] + t * (model.coords[oHi] - model.coords[oLo]),
      model.coords[oLo + 1] + t * (model.coords[oHi + 1] - model.coords[oLo + 1]),
      model.coords[oLo + 2] + t * (model.coords[oHi + 2] - model.coords[oLo + 2])
    );
    edgeNodeA.push(lo);
    edgeNodeB.push(hi);
    edgeT.push(t);
    edgePoint.set(key, idx);
    return idx;
  };

  const [uAxis, vAxis] = planeBasis(normal);
  const polys: number[] = [];
  const cellIds: number[] = [];
  let polyCount = 0;

  for (const block of model.blocks) {
    const topo = cellEdges(block.vtkCellType);
    if (!topo) continue;
    for (let i = 0; i < block.count; i++) {
      const base = i * block.stride;
      // Corner node ids + plane side; skip cells referencing unknown nodes.
      const corner: number[] = [];
      const side: boolean[] = [];
      let ok = true;
      for (let k = 0; k < topo.corners; k++) {
        const nid = block.connectivity[base + k];
        const idx = nodeIndex.get(nid);
        if (idx === undefined) {
          ok = false;
          break;
        }
        corner.push(nid);
        side.push(dist[idx] > 0);
      }
      if (!ok) continue;

      const cut: number[] = [];
      for (const [ea, eb] of topo.edges) {
        if (side[ea] !== side[eb]) cut.push(crossing(corner[ea], corner[eb]));
      }
      if (cut.length < 3) continue;

      // Order the crossings into one convex polygon: angle-sort around the
      // centroid in the plane's (u, v) basis → CCW winding around +normal.
      let cx = 0, cy = 0;
      const uv: [number, number][] = cut.map((p) => {
        const o = p * 3;
        const u = uAxis[0] * points[o] + uAxis[1] * points[o + 1] + uAxis[2] * points[o + 2];
        const v = vAxis[0] * points[o] + vAxis[1] * points[o + 1] + vAxis[2] * points[o + 2];
        cx += u;
        cy += v;
        return [u, v];
      });
      cx /= cut.length;
      cy /= cut.length;
      const order = cut.map((_, k) => k);
      order.sort((a, bIdx) => Math.atan2(uv[a][1] - cy, uv[a][0] - cx) - Math.atan2(uv[bIdx][1] - cy, uv[bIdx][0] - cx));

      polys.push(cut.length);
      for (const k of order) polys.push(cut[k]);
      cellIds.push(block.entityIds[i]);
      polyCount++;
    }
  }

  return {
    points: Float32Array.from(points),
    polys: Uint32Array.from(polys),
    polyCount,
    cellIds: Int32Array.from(cellIds),
    edgeNodeA: Int32Array.from(edgeNodeA),
    edgeNodeB: Int32Array.from(edgeNodeB),
    edgeT: Float32Array.from(edgeT),
  };
}
