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
import { decompositionFor, CellDecomposition, HEX_TETS, PYRAMID_TETS, QUAD_TRIS, WEDGE_TETS } from "./cellDecomposition";
import { VtkCellType } from "./geometryMap";

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

/**
 * Level-1 subdivision of a quadratic cell over ALL its nodes (roadmap item 38),
 * so the mid-side values the solver computed take part in where the surface lies
 * and the curved edges' own mid-node coordinates are used. Built in memory per
 * cell and never written. Linear cells (and the quadratic types without a table
 * here: 20-node hexahedra, 27-node hexahedra, 8/9-node quads, wedges, pyramids)
 * return undefined and keep the corner-only decomposition, byte for byte.
 *
 * VTK node order. Tet10: corners 0-3, mids 4:(0,1) 5:(1,2) 6:(2,0) 7:(0,3) 8:(1,3)
 * 9:(2,3). The eight sub-tetrahedra are the four corner tets plus the central
 * octahedron cut along its 4-9 diagonal; the sub-edges on any shared face are the
 * same from both sides, so crossing points weld across cells. Tri6: corners 0-2,
 * mids 3:(0,1) 4:(1,2) 5:(2,0).
 */
// Parametric positions (0, 1, 2 = start, middle, end) of the nodes of the 27-node hexahedron
// and the 9-node quad in VTK order; a sub-cell is a 2x2(x2) block of this grid.
const HEX_CORNER = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0], [0, 0, 2], [2, 0, 2], [2, 2, 2], [0, 2, 2]];
const HEX_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const HEX_FACES = [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]];
const mid = (pts: number[][]): number[] => pts[0].map((_, d) => pts.reduce((a, p) => a + p[d], 0) / pts.length);
const HEX27_POS: number[][] = [...HEX_CORNER, ...HEX_EDGES.map((e) => mid(e.map((c) => HEX_CORNER[c]))), ...HEX_FACES.map((f) => mid(f.map((c) => HEX_CORNER[c]))), [1, 1, 1]];
const QUAD_CORNER = [[0, 0], [2, 0], [2, 2], [0, 2]];
const QUAD9_POS: number[][] = [...QUAD_CORNER, ...[[0, 1], [1, 2], [2, 3], [3, 0]].map((e) => mid(e.map((c) => QUAD_CORNER[c]))), [1, 1]];

function subCells(pos: number[][], corner: number[][], origins: number[][]): number[][] {
  const at = (p: number[]): number => pos.findIndex((q) => q.every((v, d) => Math.abs(v - p[d]) < 1e-9));
  return origins.map((o) => corner.map((c) => at(c.map((v, d) => o[d] + v / 2))));
}
const HEX27_SUBS = subCells(HEX27_POS, HEX_CORNER, [0, 1].flatMap((k) => [0, 1].flatMap((j) => [0, 1].map((i) => [i, j, k]))));
const QUAD9_SUBS = subCells(QUAD9_POS, QUAD_CORNER, [0, 1].flatMap((j) => [0, 1].map((i) => [i, j])));

/**
 * A point that is not a node of the cell but a weighted mix of its nodes (the
 * serendipity shape functions evaluated at a face or body centre). `sources`
 * are local node indices; the sub-cell tables refer to it as `corners + j`.
 */
export interface VirtualPoint {
  sources: number[];
  weights: number[];
}
export interface QuadraticDecomposition extends CellDecomposition {
  virtuals?: VirtualPoint[];
}

// Serendipity centre of a face given by its 4 corner indices and the (index, corner pair) of its edge mids:
// corners weigh -1/4 and the 4 mids 1/2, so the weights sum to 1 and depend only on the face's own 8 nodes.
function faceCentre(corners: number[], edgeMids: number[]): VirtualPoint {
  return { sources: [...corners, ...edgeMids], weights: [...corners.map(() => -0.25), ...edgeMids.map(() => 0.5)] };
}
// Hex20: virtual j = HEX27 index 20 + j (6 face centres in HEX_FACES order, then the body centre).
const HEX20_VIRTUALS: VirtualPoint[] = [
  ...HEX_FACES.map((f) =>
    faceCentre(f, HEX_EDGES.map((e, i) => (f.includes(e[0]) && f.includes(e[1]) ? 8 + i : -1)).filter((i) => i >= 0))
  ),
  {
    sources: [...Array(20).keys()],
    weights: [...HEX_CORNER.map(() => -0.25), ...HEX_EDGES.map(() => 0.25)],
  },
];
const QUAD8_VIRTUALS: VirtualPoint[] = [faceCentre([0, 1, 2, 3], [4, 5, 6, 7])];
// Wedge15 (VTK): mids 6-8 bottom, 9-11 top, 12-14 vertical. The three quad-face centres sit at mid height.
const WEDGE15_VIRTUALS: VirtualPoint[] = [
  faceCentre([0, 1, 4, 3], [6, 13, 9, 12]),
  faceCentre([1, 2, 5, 4], [7, 14, 10, 13]),
  faceCentre([2, 0, 3, 5], [8, 12, 11, 14]),
];
// Eight sub-wedges: four triangles of the bottom layer (6,7,8 = bottom mids; 12-14 + 15-17 = the mid layer), then four of the top.
const WEDGE15_SUBS = [
  [0, 6, 8, 12, 15, 17], [6, 1, 7, 15, 13, 16], [8, 7, 2, 17, 16, 14], [6, 7, 8, 15, 16, 17],
  [12, 15, 17, 3, 9, 11], [15, 13, 16, 9, 4, 10], [17, 16, 14, 11, 10, 5], [15, 16, 17, 9, 10, 11],
];

// Pyramid13 (VTK): corners 0-3 base, 4 apex; mids 5:(0,1) 6:(1,2) 7:(2,3) 8:(3,0) 9:(0,4) 10:(1,4) 11:(2,4) 12:(3,4).
// One virtual point, the base centre B (= index 13). Six sub-pyramids (four around the base corners, the small
// top one, the middle one under it) and four tetrahedra tile the cell; orientation is irrelevant to the contour.
const PYRAMID13_VIRTUALS: VirtualPoint[] = [faceCentre([0, 1, 2, 3], [5, 6, 7, 8])];
const PYRAMID13_SUBS = [
  [0, 5, 13, 8, 9], [1, 6, 13, 5, 10], [2, 7, 13, 6, 11], [3, 8, 13, 7, 12], [9, 10, 11, 12, 4], [9, 10, 11, 12, 13],
];
const PYRAMID13_TETS = [[13, 5, 9, 10], [13, 6, 10, 11], [13, 7, 11, 12], [13, 8, 12, 9]];

export function quadraticDecomposition(cellType: number | undefined, stride: number): QuadraticDecomposition | undefined {
  if (cellType === VtkCellType.QUADRATIC_TETRA && stride >= 10) {
    return {
      corners: 10,
      tets: [
        [0, 4, 6, 7], [1, 5, 4, 8], [2, 6, 5, 9], [3, 7, 9, 8],
        [4, 9, 5, 6], [4, 9, 6, 7], [4, 9, 7, 8], [4, 9, 8, 5],
      ],
    };
  }
  if (cellType === VtkCellType.QUADRATIC_TRIANGLE && stride >= 6) {
    return { corners: 6, tris: [[0, 3, 5], [3, 1, 4], [5, 4, 2], [3, 4, 5]] };
  }
  if (cellType === VtkCellType.TRIQUADRATIC_HEXAHEDRON && stride >= 27) {
    return { corners: 27, tets: HEX27_SUBS.flatMap((sub) => HEX_TETS.map((t) => t.map((k) => sub[k]))) };
  }
  if (cellType === VtkCellType.BIQUADRATIC_QUAD && stride >= 9) {
    return { corners: 9, tris: QUAD9_SUBS.flatMap((sub) => QUAD_TRIS.map((t) => t.map((k) => sub[k]))) };
  }
  // 20-node hexahedra, 8-node quads and 15-node wedges have no face/body-centre node: they subdivide like their
  // fuller cousins, with the missing centres supplied as virtual points (the sub-cell tables are shared).
  if (cellType === VtkCellType.QUADRATIC_HEXAHEDRON && stride >= 20) {
    return { corners: 20, virtuals: HEX20_VIRTUALS, tets: HEX27_SUBS.flatMap((sub) => HEX_TETS.map((t) => t.map((k) => sub[k]))) };
  }
  if (cellType === VtkCellType.QUADRATIC_QUAD && stride >= 8) {
    return { corners: 8, virtuals: QUAD8_VIRTUALS, tris: QUAD9_SUBS.flatMap((sub) => QUAD_TRIS.map((t) => t.map((k) => sub[k]))) };
  }
  if (cellType === VtkCellType.QUADRATIC_WEDGE && stride >= 15) {
    return { corners: 15, virtuals: WEDGE15_VIRTUALS, tets: WEDGE15_SUBS.flatMap((sub) => WEDGE_TETS.map((t) => t.map((k) => sub[k]))) };
  }
  if (cellType === VtkCellType.QUADRATIC_PYRAMID && stride >= 13) {
    return {
      corners: 13,
      virtuals: PYRAMID13_VIRTUALS,
      tets: [...PYRAMID13_SUBS.flatMap((sub) => PYRAMID_TETS.map((t) => t.map((k) => sub[k]))), ...PYRAMID13_TETS],
    };
  }
  return undefined;
}

/**
 * Linear hexahedra and wedges are split about face and body centres instead of through the 0-6 diagonal:
 * a shared quad face then triangulates identically from both neighbours (four triangles about its centre),
 * so the isosurface has no hairline cracks where the fixed-diagonal split disagreed. The centres are plain
 * corner averages, welded by sorted node ids like the quadratic virtuals.
 */
const mean = (sources: number[]): VirtualPoint => ({ sources, weights: sources.map(() => 1 / sources.length) });
const WEDGE_QUADS = [[0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]];
const aboutCentres = (corners: number, quads: number[][], tris: number[][]): { virtuals: VirtualPoint[]; tets: number[][] } => {
  const body = corners + quads.length;
  const tets = quads.flatMap((q, j) => q.map((c, i) => [c, q[(i + 1) % 4], corners + j, body]));
  return {
    virtuals: [...quads.map(mean), mean([...Array(corners).keys()])],
    tets: [...tets, ...tris.map((t) => [...t, body])],
  };
};
const HEX_SYMMETRIC = aboutCentres(8, HEX_FACES, []);
const WEDGE_SYMMETRIC = aboutCentres(6, WEDGE_QUADS, [[0, 1, 2], [3, 4, 5]]);

/** Crack-free subdivision of a LINEAR hexahedron or wedge; undefined for every other cell type. */
export function symmetricDecomposition(cellType: number | undefined, stride: number): QuadraticDecomposition | undefined {
  if (cellType === VtkCellType.HEXAHEDRON && stride >= 8) return { corners: 8, ...HEX_SYMMETRIC };
  if (cellType === VtkCellType.WEDGE && stride >= 6) return { corners: 6, ...WEDGE_SYMMETRIC };
  return undefined;
}

// Welded virtual points of one contouring run: a negative id per distinct set of contributing nodes, so two cells
// sharing a face share its centre. Value and position are the same weighted mix of the contributors.
interface VirtualRegistry {
  ids: Map<string, number>;
  coords: Map<number, Vec3>;
}
function attachVirtuals(
  t: QuadraticDecomposition,
  corner: number[],
  scalar: Map<number, number>,
  coordOf: (id: number) => Vec3 | undefined,
  reg: VirtualRegistry
): boolean {
  if (!t.virtuals) return true;
  for (const v of t.virtuals) {
    const nodes = v.sources.map((k) => corner[k]);
    const key = [...nodes].sort((a, b) => a - b).join("_");
    let id = reg.ids.get(key);
    if (id === undefined) {
      let s = 0;
      const c: Vec3 = [0, 0, 0];
      for (let i = 0; i < nodes.length; i++) {
        const sv = scalar.get(nodes[i]);
        const cv = coordOf(nodes[i]);
        if (sv === undefined || !cv) return false;
        s += v.weights[i] * sv;
        c[0] += v.weights[i] * cv[0];
        c[1] += v.weights[i] * cv[1];
        c[2] += v.weights[i] * cv[2];
      }
      id = -(reg.ids.size + 1);
      reg.ids.set(key, id);
      reg.coords.set(id, c);
      scalar.set(id, s);
    }
    corner.push(id);
  }
  return true;
}

export function computeIsoSurface(
  model: MdpaModel,
  field: FieldData,
  isoValue: number
): IsoSurfaceResult {
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) nodeIndex.set(model.nodeIds[i], i);
  const scalar = scalarByNode(field);

  const virtual: VirtualRegistry = { ids: new Map(), coords: new Map() };
  const coordOf = (nodeId: number): Vec3 | undefined => {
    if (nodeId < 0) return virtual.coords.get(nodeId);
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
    if (decompositionFor(block.vtkCellType).tets) {
      hasVolume = true;
      break;
    }
  }

  if (hasVolume) {
    marchVolumes(model, isoValue, scalar, crossing, triangles, coordOf, virtual);
    return {
      points: Float32Array.from(points),
      triangles: Uint32Array.from(triangles),
      lines: new Uint32Array(0),
      is2D: false,
    };
  }

  marchSurfaces(model, isoValue, scalar, crossing, lines, coordOf, virtual);
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
  out: number[],
  coordOf: (id: number) => Vec3 | undefined,
  virtual: VirtualRegistry
): void {
  for (const block of model.blocks) {
    const t: QuadraticDecomposition =
      symmetricDecomposition(block.vtkCellType, block.stride) ?? quadraticDecomposition(block.vtkCellType, block.stride) ?? decompositionFor(block.vtkCellType);
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
      if (!ok || !attachVirtuals(t, corner, scalar, coordOf, virtual)) continue;
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
  out: number[],
  coordOf: (id: number) => Vec3 | undefined,
  virtual: VirtualRegistry
): void {
  for (const block of model.blocks) {
    const t: QuadraticDecomposition = quadraticDecomposition(block.vtkCellType, block.stride) ?? decompositionFor(block.vtkCellType);
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
      if (!ok || !attachVirtuals(t, corner, scalar, coordOf, virtual)) continue;
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

/**
 * One label anchor for an iso level (roadmap item 38): the midpoint of the
 * segment (iso-lines) or the centroid of the triangle (isosurface) whose centre
 * is nearest to the middle of the level's crossing points. Every crossing point
 * lies on the level and the field is interpolated linearly along the cell, so
 * the anchor lies on the level too. `undefined` when the level crosses nothing.
 */
export function isoLabelAnchor(result: IsoSurfaceResult): Vec3 | undefined {
  const pts = result.points;
  const n = Math.floor(pts.length / 3);
  if (n === 0) return undefined;
  const mid: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) mid[k] += pts[i * 3 + k] / n;
  const idx = result.is2D ? result.lines : result.triangles;
  const per = result.is2D ? 2 : 3;
  let best: Vec3 | undefined;
  let bestD = Infinity;
  for (let c = 0; c + per <= idx.length; c += per) {
    const a: Vec3 = [0, 0, 0];
    for (let j = 0; j < per; j++) for (let k = 0; k < 3; k++) a[k] += pts[idx[c + j] * 3 + k] / per;
    const d = (a[0] - mid[0]) ** 2 + (a[1] - mid[1]) ** 2 + (a[2] - mid[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}
