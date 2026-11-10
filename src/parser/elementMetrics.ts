// Solver-oriented element quality metrics (roadmap item 63).
//
// meshQuality.ts answers the four Kratos ComputeMeshQualityProcess questions
// (edge ratio, min/max angle, gradation). Element formulations are also
// sensitive to the metrics below, which a solver reports as "negative
// Jacobian" or "distorted element":
//   scaledJacobian : min over corners of det(edge frame) / product of edge
//                    lengths, normalised so the ideal element reads 1
//                    (equilateral tri/tet, square, cube). Negative = inverted.
//                    Quadratic cells use the true tangent at each corner,
//                    4*mid - 3*corner - other, so an inverted mid-side node is
//                    caught even when the straight-sided corners are valid.
//   skewness       : equiangular skew over the interior angles of every face
//                    (0 = ideal, 1 = degenerate); wedges and pyramids skipped.
//   warpage        : quad and hexahedron faces, the largest angle (deg)
//                    between the normals of the two triangles of a diagonal
//                    split, over both diagonals.
//   taper          : quad and hexahedron faces, the largest relative length
//                    difference |l1 - l2| / max(l1, l2) between opposite edges.
//   radiusRatio    : linear tetrahedra, 3 * inradius / circumradius
//                    (1 = regular, 0 = collapsed).
//   volumeRatio    : measure of an element divided by the median of its block,
//                    folded so that both too-large and too-small read >= 1.
// Thresholds are advisory, like the Kratos defaults in meshQuality.ts.
//
// Pure: imports only the data model, cell ids and meshQuality's band helpers.

import { MdpaModel } from "./types";
import { VtkCellType } from "./geometryMap";
import { decompositionFor } from "./cellDecomposition";
import { MetricResult, MetricSpec, finalize, classify } from "./meshQuality";

const C = VtkCellType;
type Vec3 = [number, number, number];

export const SOLVER_METRIC_KEYS = [
  "scaledJacobian",
  "skewness",
  "warpage",
  "taper",
  "radiusRatio",
  "volumeRatio",
] as const;
export type SolverMetricKey = (typeof SOLVER_METRIC_KEYS)[number];

export const SOLVER_SPECS: Record<SolverMetricKey, MetricSpec> = {
  scaledJacobian: { key: "scaledJacobian", label: "Scaled Jacobian", higherIsBetter: true, thresholds: [0.5, 0.2, 0], perElement: true },
  skewness: { key: "skewness", label: "Skewness", higherIsBetter: false, thresholds: [0.5, 0.75, 0.9], perElement: true },
  warpage: { key: "warpage", label: "Warpage", unit: "°", higherIsBetter: false, thresholds: [5, 15, 30], perElement: true },
  taper: { key: "taper", label: "Taper", higherIsBetter: false, thresholds: [0.3, 0.6, 0.9], perElement: true },
  radiusRatio: { key: "radiusRatio", label: "Radius ratio (tet)", higherIsBetter: true, thresholds: [0.3, 0.1, 0.01], perElement: true },
  volumeRatio: { key: "volumeRatio", label: "Size vs block median", higherIsBetter: false, thresholds: [4, 10, 50], perElement: true },
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
const RAD2DEG = 180 / Math.PI;

// --- cell tables --------------------------------------------------------
interface Shape {
  corners: number;
  dim: 2 | 3;
  /** Per corner, the neighbour corners (right-handed triples in 3D, ordered pair in 2D). */
  frames: number[][];
  /** Normalisation turning the ideal element's raw value into 1. */
  scale: number;
  /** Faces for skewness / warpage / taper (corner indices). */
  faces?: number[][];
  /** Ideal interior angle of a face, in degrees, per face length. */
  mids?: Map<number, number>;
}

const key = (i: number, j: number): number => (i < j ? i * 32 + j : j * 32 + i);
const midMap = (pairs: number[][], first: number): Map<number, number> => {
  const m = new Map<number, number>();
  pairs.forEach((p, k) => m.set(key(p[0], p[1]), first + k));
  return m;
};

const TRI: Shape = {
  corners: 3, dim: 2, scale: 2 / Math.sqrt(3),
  frames: [[1, 2], [2, 0], [0, 1]],
  faces: [[0, 1, 2]],
};
const TRI6: Shape = { ...TRI, mids: midMap([[0, 1], [1, 2], [2, 0]], 3) };
const QUAD: Shape = {
  corners: 4, dim: 2, scale: 1,
  frames: [[1, 3], [2, 0], [3, 1], [0, 2]],
  faces: [[0, 1, 2, 3]],
};
const QUAD8: Shape = { ...QUAD, mids: midMap([[0, 1], [1, 2], [2, 3], [3, 0]], 4) };
const TET: Shape = {
  corners: 4, dim: 3, scale: Math.SQRT2,
  frames: [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]],
  faces: [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]],
};
const TET10: Shape = { ...TET, mids: midMap([[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]], 4) };
const HEX: Shape = {
  corners: 8, dim: 3, scale: 1,
  frames: [[1, 3, 4], [2, 0, 5], [3, 1, 6], [0, 2, 7], [7, 5, 0], [4, 6, 1], [5, 7, 2], [6, 4, 3]],
  faces: [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]],
};
const HEX20: Shape = {
  ...HEX,
  mids: midMap([[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]], 8),
};
const WEDGE: Shape = {
  corners: 6, dim: 3, scale: 2 / Math.sqrt(3),
  frames: [[2, 1, 3], [0, 2, 4], [1, 0, 5], [4, 5, 0], [5, 3, 1], [3, 4, 2]],
};

function shapeOf(cellType?: number): Shape | undefined {
  switch (cellType) {
    case C.TRIANGLE: return TRI;
    case C.QUADRATIC_TRIANGLE: return TRI6;
    case C.QUAD: return QUAD;
    case C.QUADRATIC_QUAD: return QUAD8;
    case C.BIQUADRATIC_QUAD: return QUAD8;
    case C.TETRA: return TET;
    case C.QUADRATIC_TETRA: return TET10;
    case C.HEXAHEDRON: return HEX;
    case C.QUADRATIC_HEXAHEDRON: return HEX20;
    case C.TRIQUADRATIC_HEXAHEDRON: return HEX20;
    case C.WEDGE: return WEDGE;
    default: return undefined;
  }
}

// --- per-cell evaluation -------------------------------------------------
function tangent(pts: Vec3[], s: Shape, c: number, n: number): Vec3 {
  const mid = s.mids?.get(key(c, n));
  if (mid !== undefined && pts[mid]) {
    const m = pts[mid];
    return [4 * m[0] - 3 * pts[c][0] - pts[n][0], 4 * m[1] - 3 * pts[c][1] - pts[n][1], 4 * m[2] - 3 * pts[c][2] - pts[n][2]];
  }
  return sub(pts[n], pts[c]);
}

function newell(pts: Vec3[], face: number[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let k = 0; k < face.length; k++) {
    const a = pts[face[k]];
    const b = pts[face[(k + 1) % face.length]];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

export function scaledJacobian(pts: Vec3[], s: Shape): number | undefined {
  let worst = Infinity;
  const nrm = s.dim === 2 ? newell(pts, s.faces![0]) : undefined;
  const nl = nrm ? norm(nrm) : 0;
  if (s.dim === 2 && nl === 0) return undefined;
  for (let c = 0; c < s.corners; c++) {
    const e = s.frames[c].map((n) => tangent(pts, s, c, n));
    const lens = e.map(norm);
    if (lens.some((l) => l === 0)) return 0;
    const det = s.dim === 3 ? dot(cross(e[0], e[1]), e[2]) : dot(cross(e[0], e[1]), nrm!) / nl;
    const v = (det / lens.reduce((a, b) => a * b, 1)) * s.scale;
    if (v < worst) worst = v;
  }
  return worst;
}

function faceAngles(pts: Vec3[], face: number[]): number[] {
  const out: number[] = [];
  const n = face.length;
  for (let k = 0; k < n; k++) {
    const p = pts[face[(k - 1 + n) % n]];
    const c = pts[face[k]];
    const q = pts[face[(k + 1) % n]];
    const a = sub(p, c);
    const b = sub(q, c);
    const la = norm(a);
    const lb = norm(b);
    if (la === 0 || lb === 0) { out.push(0); continue; }
    out.push(Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))) * RAD2DEG);
  }
  return out;
}

export function skewness(pts: Vec3[], s: Shape): number | undefined {
  if (!s.faces) return undefined;
  let worst = 0;
  for (const f of s.faces) {
    const ideal = f.length === 3 ? 60 : 90;
    for (const a of faceAngles(pts, f)) {
      const sk = Math.max((a - ideal) / (180 - ideal), (ideal - a) / ideal);
      if (sk > worst) worst = sk;
    }
  }
  return worst;
}

function triNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return cross(sub(b, a), sub(c, a));
}

function quadWarpage(pts: Vec3[], f: number[]): number {
  const [a, b, c, d] = f.map((i) => pts[i]);
  const ang = (n1: Vec3, n2: Vec3): number => {
    const l1 = norm(n1);
    const l2 = norm(n2);
    if (l1 === 0 || l2 === 0) return 0;
    return Math.acos(Math.max(-1, Math.min(1, dot(n1, n2) / (l1 * l2)))) * RAD2DEG;
  };
  return Math.max(ang(triNormal(a, b, c), triNormal(a, c, d)), ang(triNormal(a, b, d), triNormal(b, c, d)));
}

function quadTaper(pts: Vec3[], f: number[]): number {
  const l = (i: number, j: number): number => norm(sub(pts[f[i]], pts[f[j]]));
  const rel = (x: number, y: number): number => (Math.max(x, y) > 0 ? Math.abs(x - y) / Math.max(x, y) : 0);
  return Math.max(rel(l(0, 1), l(2, 3)), rel(l(1, 2), l(3, 0)));
}

export function warpage(pts: Vec3[], s: Shape): number | undefined {
  const quads = s.faces?.filter((f) => f.length === 4);
  if (!quads || quads.length === 0) return undefined;
  return Math.max(...quads.map((f) => quadWarpage(pts, f)));
}

export function taper(pts: Vec3[], s: Shape): number | undefined {
  const quads = s.faces?.filter((f) => f.length === 4);
  if (!quads || quads.length === 0) return undefined;
  return Math.max(...quads.map((f) => quadTaper(pts, f)));
}

export function radiusRatio(pts: Vec3[]): number {
  const [p0, p1, p2, p3] = pts;
  const a = sub(p1, p0);
  const b = sub(p2, p0);
  const c = sub(p3, p0);
  const vol = Math.abs(dot(a, cross(b, c))) / 6;
  if (vol === 0) return 0;
  const area =
    (norm(cross(a, b)) + norm(cross(b, c)) + norm(cross(c, a)) + norm(cross(sub(p2, p1), sub(p3, p1)))) / 2;
  const inr = (3 * vol) / area;
  const num: Vec3 = [0, 0, 0];
  const t1 = cross(b, c);
  const t2 = cross(c, a);
  const t3 = cross(a, b);
  const aa = dot(a, a);
  const bb = dot(b, b);
  const cc = dot(c, c);
  for (let k = 0; k < 3; k++) num[k] = aa * t1[k] + bb * t2[k] + cc * t3[k];
  const circ = norm(num) / (12 * vol);
  return circ > 0 ? (3 * inr) / circ : 0;
}

function measure(pts: Vec3[], cellType: number): number {
  const d = decompositionFor(cellType);
  let total = 0;
  if (d.tets) {
    for (const t of d.tets) {
      total += Math.abs(dot(sub(pts[t[1]], pts[t[0]]), cross(sub(pts[t[2]], pts[t[0]]), sub(pts[t[3]], pts[t[0]])))) / 6;
    }
  } else if (d.tris) {
    for (const t of d.tris) total += norm(triNormal(pts[t[0]], pts[t[1]], pts[t[2]])) / 2;
  }
  return total;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Compute the requested solver-oriented metrics over the model's Elements
 * (surface and volume cells; if there are no Elements, any surface/volume
 * blocks, like computeMeshQuality). Returns one MetricResult per requested key
 * that has at least one applicable element, in SOLVER_METRIC_KEYS order.
 * `badEntityIds` holds the bad and unacceptable bands.
 */
export function computeSolverMetrics(model: MdpaModel, keys: readonly SolverMetricKey[] = SOLVER_METRIC_KEYS): MetricResult[] {
  const wanted = new Set(keys);
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) nodeIndex.set(model.nodeIds[i], i);

  let blocks = model.blocks.filter((b) => b.kind === "Elements");
  if (blocks.length === 0) blocks = model.blocks.filter((b) => decompositionFor(b.vtkCellType).corners > 0);

  const values: Record<SolverMetricKey, number[]> = {
    scaledJacobian: [], skewness: [], warpage: [], taper: [], radiusRatio: [], volumeRatio: [],
  };
  const bad: Record<SolverMetricKey, number[]> = {
    scaledJacobian: [], skewness: [], warpage: [], taper: [], radiusRatio: [], volumeRatio: [],
  };
  const push = (k: SolverMetricKey, v: number | undefined, id: number): void => {
    if (v === undefined || !Number.isFinite(v) || !wanted.has(k)) return;
    values[k].push(v);
    const band = classify(v, SOLVER_SPECS[k].thresholds, SOLVER_SPECS[k].higherIsBetter);
    if (band === "bad" || band === "unacceptable") bad[k].push(id);
  };

  for (const block of blocks) {
    const shape = shapeOf(block.vtkCellType);
    const dec = decompositionFor(block.vtkCellType);
    if (!shape && !dec.corners) continue;
    const need = shape ? Math.max(shape.corners, ...(shape.mids ? [...shape.mids.values()].map((m) => m + 1) : [0])) : dec.corners;
    const cells: { id: number; pts: Vec3[]; vol: number }[] = [];
    for (let i = 0; i < block.count; i++) {
      const base = i * block.stride;
      const pts: Vec3[] = [];
      let ok = block.stride >= need || (shape && block.stride >= shape.corners);
      for (let k = 0; ok && k < Math.min(block.stride, need); k++) {
        const idx = nodeIndex.get(block.connectivity[base + k]);
        if (idx === undefined) { ok = false; break; }
        pts.push([model.coords[idx * 3], model.coords[idx * 3 + 1], model.coords[idx * 3 + 2]]);
      }
      if (!ok) continue;
      const id = block.entityIds[i];
      if (shape) {
        push("scaledJacobian", scaledJacobian(pts, shape), id);
        push("skewness", skewness(pts, shape), id);
        push("warpage", warpage(pts, shape), id);
        push("taper", taper(pts, shape), id);
        if (shape === TET) push("radiusRatio", radiusRatio(pts), id);
      }
      if (dec.corners > 0) cells.push({ id, pts, vol: measure(pts, block.vtkCellType ?? 0) });
    }
    if (wanted.has("volumeRatio") && cells.length > 1) {
      const med = median(cells.map((c) => c.vol).filter((v) => v > 0));
      for (const c of cells) {
        if (med <= 0) break;
        push("volumeRatio", c.vol > 0 ? Math.max(c.vol / med, med / c.vol) : Infinity, c.id);
      }
    }
  }

  const out: MetricResult[] = [];
  for (const k of SOLVER_METRIC_KEYS) {
    if (!wanted.has(k) || values[k].length === 0) continue;
    out.push(finalize(SOLVER_SPECS[k], values[k], bad[k]));
  }
  return out;
}
