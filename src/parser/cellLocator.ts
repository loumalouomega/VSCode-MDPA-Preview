/**
 * A pure, wasm-free point locator over a model's simplex decomposition, shared
 * by `remeshFields.ts` (field transfer across a remesh) and `streamlines.ts`
 * (tracing through a solved vector field).
 *
 * One uniform grid over the domain, one bucket entry per grid cell a simplex's
 * bounding box overlaps; cells come from the `cellDecomposition.ts` tables
 * (tet/pyramid/wedge/hex -> tets, tri/quad -> tris; lines and points have no
 * interior and are skipped). Barycentric weights are SIGNED, so containment is
 * `weight >= -CONTAIN_EPS` — see `triWeights` for the defect an unsigned test
 * caused.
 *
 * The primitives (`buildLocator`, `candidates`, `contains`, ...) were lifted
 * verbatim out of `remeshFields.ts`, which keeps its own nearest-simplex
 * fallback: a remesh drifts the surface by epsilon and must still map every
 * node. `CellLocator.locate` is the opposite contract — STRICT. A point in no
 * simplex is `null`, because a streamline that keeps integrating after it left
 * the domain would be invented data.
 *
 * Pure module: no vscode / DOM / vtk.js / wasm imports.
 */

import { decompositionFor } from "./cellDecomposition";
import { MdpaModel } from "./types";

export type Vec3 = [number, number, number];

/** One simplex in the locator: corners into the source coords + provenance. */
export interface LocatorSimplex {
  /** 3 (tri) or 4 (tet) corner coordinates, flat. */
  p: Float64Array;
  /** Source node ids at the corners (Nodal gather). */
  ids: number[];
  /** Index of the source cell in `sourceCells` (P0 gather). */
  cell: number;
  min: Vec3;
  max: Vec3;
  /** Squared length of the bbox diagonal (degeneracy guard). */
  diag2: number;
}

export interface Locator {
  cell: number;
  min: Vec3;
  nx: number;
  ny: number;
  nz: number;
  buckets: Map<number, number[]>;
  simplices: LocatorSimplex[];
  /** Mean simplex count per non-empty bucket (diagnostic, unused). */
  diag: number;
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Barycentric weights of p in tet (a,b,c,d); null when degenerate. */
export function tetWeights(p: Vec3, a: Vec3, b: Vec3, c: Vec3, d: Vec3): number[] | null {
  const v0 = sub(b, a);
  const v1 = sub(c, a);
  const v2 = sub(d, a);
  // 6× volumes via scalar triple products; Cramer against the total.
  const det = dot(v0, cross(v1, v2));
  if (!(Math.abs(det) > 0)) return null;
  const vp = sub(p, a);
  const w1 = dot(vp, cross(v1, v2)) / det;
  const w2 = dot(v0, cross(vp, v2)) / det;
  const w3 = dot(v0, cross(v1, vp)) / det;
  return [1 - w1 - w2 - w3, w1, w2, w3];
}

/**
 * SIGNED barycentric weights of p in triangle (a,b,c) in 3D; null when
 * degenerate. A point off the plane is weighted as its projection onto it.
 *
 * Signed on purpose: `contains` decides containment by `weight >= -eps`, so a
 * weight built from cross-product NORMS (always >= 0) reports every point as
 * "inside" every triangle of its bucket — and the first candidate then wins,
 * interpolating with weights that sum to more than 1. That is what this
 * function did before, and it was invisible for a tet mesh (tets use
 * `tetWeights`, signed) but wrong for every surface source: a remeshed
 * surface's nodal field came back scaled by the wrong triangle. Each weight is
 * the signed area of the sub-triangle opposite that corner, along the
 * triangle's own normal, over the whole area.
 */
export function triWeights(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number[] | null {
  const n = cross(sub(b, a), sub(c, a));
  const nn = dot(n, n);
  if (!(nn > 0)) return null;
  const w0 = dot(cross(sub(b, p), sub(c, p)), n) / nn;
  const w1 = dot(cross(sub(c, p), sub(a, p)), n) / nn;
  return [w0, w1, 1 - w0 - w1];
}

export function buildLocator(
  simplices: LocatorSimplex[],
  bounds: { min: Vec3; max: Vec3 }
): Locator | null {
  if (simplices.length === 0) return null;
  const ext: Vec3 = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  const vol = Math.max(ext[0] * ext[1] * ext[2], 0);
  const diag = Math.sqrt(ext[0] * ext[0] + ext[1] * ext[1] + ext[2] * ext[2]);
  // One grid cell per simplex on average (cubic root; area root for planar).
  let h = vol > 0 ? Math.cbrt(vol / simplices.length) : 0;
  if (!(h > 0)) {
    const area = Math.max(ext[0] * ext[1], ext[1] * ext[2], ext[0] * ext[2]);
    h = area > 0 ? Math.sqrt(area / simplices.length) : diag;
  }
  if (!(h > 0)) return null;
  const nx = Math.max(1, Math.ceil(ext[0] / h));
  const ny = Math.max(1, Math.ceil(ext[1] / h));
  const nz = Math.max(1, Math.ceil(ext[2] / h));
  const buckets = new Map<number, number[]>();
  const key = (ix: number, iy: number, iz: number): number => (ix * ny + iy) * nz + iz;
  simplices.forEach((s, si) => {
    const lo: Vec3 = [
      Math.max(0, Math.floor((s.min[0] - bounds.min[0]) / h)),
      Math.max(0, Math.floor((s.min[1] - bounds.min[1]) / h)),
      Math.max(0, Math.floor((s.min[2] - bounds.min[2]) / h)),
    ];
    const hi: Vec3 = [
      Math.min(nx - 1, Math.floor((s.max[0] - bounds.min[0]) / h)),
      Math.min(ny - 1, Math.floor((s.max[1] - bounds.min[1]) / h)),
      Math.min(nz - 1, Math.floor((s.max[2] - bounds.min[2]) / h)),
    ];
    for (let ix = lo[0]; ix <= hi[0]; ix++) {
      for (let iy = lo[1]; iy <= hi[1]; iy++) {
        for (let iz = lo[2]; iz <= hi[2]; iz++) {
          const k = key(ix, iy, iz);
          const arr = buckets.get(k);
          if (arr) arr.push(si);
          else buckets.set(k, [si]);
        }
      }
    }
  });
  return { cell: h, min: bounds.min, nx, ny, nz, buckets, simplices, diag };
}

/** Candidate simplex indices near p (own bucket, else whole index). */
export function candidates(loc: Locator, p: Vec3): number[] {
  const ix = Math.min(loc.nx - 1, Math.max(0, Math.floor((p[0] - loc.min[0]) / loc.cell)));
  const iy = Math.min(loc.ny - 1, Math.max(0, Math.floor((p[1] - loc.min[1]) / loc.cell)));
  const iz = Math.min(loc.nz - 1, Math.max(0, Math.floor((p[2] - loc.min[2]) / loc.cell)));
  const bucket = loc.buckets.get((ix * loc.ny + iy) * loc.nz + iz);
  if (bucket) return bucket;
  return loc.simplices.map((_, i) => i);
}

export const CONTAIN_EPS = 1e-9;

export function contains(s: LocatorSimplex, p: Vec3): number[] | null {
  // Edges (2 corners) have no interior: the surface locator tests them by
  // segment distance instead and never reaches this.
  if (s.ids.length !== 3 && s.ids.length !== 4) return null;
  const n = s.ids.length;
  const a: Vec3 = [s.p[0], s.p[1], s.p[2]];
  const b: Vec3 = [s.p[3], s.p[4], s.p[5]];
  const c: Vec3 = [s.p[6], s.p[7], s.p[8]];
  const w =
    n === 4
      ? tetWeights(p, a, b, c, [s.p[9], s.p[10], s.p[11]])
      : triWeights(p, a, b, c);
  if (!w) return null;
  for (const x of w) if (!(x >= -CONTAIN_EPS)) return null;
  return w;
}

/** One located point: the containing simplex and the barycentric weights of its corners. */
export interface LocateHit {
  simplex: LocatorSimplex;
  /** Signed weights, one per corner of `simplex.ids`; they sum to 1. */
  weights: number[];
}

export interface CellLocator {
  /** The containing simplex, or `null` when `p` lies in none — never a nearest guess. */
  locate(p: Vec3): LocateHit | null;
  /** 3 for a tetrahedral index, 2 for a triangle (surface / 2D) index. */
  readonly dimension: 2 | 3;
  readonly simplexCount: number;
  /** Bounding-box diagonal of a simplex: a cheap "how big is the cell I am in". */
  sizeOf(s: LocatorSimplex): number;
}

/**
 * Indexes a model's cells for strict point location, or `null` when it has no
 * cell with an interior. Tetrahedra win when the mesh has any (the boundary
 * triangles of a volume mesh are faces of those tets, and a point on one is
 * already found through the tet); otherwise triangles from every block — a 2D
 * mesh, or a surface such as an imported skin. Cells naming a node the model
 * does not define are skipped.
 */
export function buildCellLocator(model: MdpaModel): CellLocator | null {
  const indexById = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) indexById.set(model.nodeIds[i], i);
  const tets: LocatorSimplex[] = [];
  const tris: LocatorSimplex[] = [];
  const pt = (id: number): Vec3 | undefined => {
    const i = indexById.get(id);
    return i === undefined ? undefined : [model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]];
  };
  let cellOrdinal = 0;
  for (const block of model.blocks) {
    const decomp = decompositionFor(block.vtkCellType);
    if (!decomp.tets && !decomp.tris) continue;
    for (let c = 0; c < block.count; c++, cellOrdinal++) {
      const corners: number[] = [];
      const pts: Vec3[] = [];
      let ok = true;
      for (let k = 0; k < block.stride; k++) {
        const id = block.connectivity[c * block.stride + k];
        const p = pt(id);
        if (!p) { ok = false; break; }
        corners.push(id);
        pts.push(p);
      }
      if (!ok) continue;
      const parts = decomp.tets ?? decomp.tris!;
      const out = decomp.tets ? tets : tris;
      for (const t of parts) {
        const coords = t.map((k) => pts[k]);
        const flat = new Float64Array(coords.length * 3);
        const min: Vec3 = [Infinity, Infinity, Infinity];
        const max: Vec3 = [-Infinity, -Infinity, -Infinity];
        coords.forEach((p, i) => {
          for (let a = 0; a < 3; a++) {
            flat[i * 3 + a] = p[a];
            if (p[a] < min[a]) min[a] = p[a];
            if (p[a] > max[a]) max[a] = p[a];
          }
        });
        out.push({
          p: flat,
          ids: t.map((k) => corners[k]),
          cell: cellOrdinal,
          min,
          max,
          diag2: (max[0] - min[0]) ** 2 + (max[1] - min[1]) ** 2 + (max[2] - min[2]) ** 2,
        });
      }
    }
  }
  const simplices = tets.length > 0 ? tets : tris;
  if (simplices.length === 0) return null;
  const bmin: Vec3 = [Infinity, Infinity, Infinity];
  const bmax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of simplices) {
    for (let a = 0; a < 3; a++) {
      if (s.min[a] < bmin[a]) bmin[a] = s.min[a];
      if (s.max[a] > bmax[a]) bmax[a] = s.max[a];
    }
  }
  const loc = buildLocator(simplices, { min: bmin, max: bmax });
  if (!loc) return null;
  const slack = loc.cell * 1e-6;
  return {
    dimension: tets.length > 0 ? 3 : 2,
    simplexCount: simplices.length,
    sizeOf: (s) => Math.sqrt(s.diag2),
    locate(p) {
      for (let a = 0; a < 3; a++) {
        if (!Number.isFinite(p[a])) return null;
      }
      const lim = [loc.nx, loc.ny, loc.nz];
      for (let a = 0; a < 3; a++) {
        if (p[a] < loc.min[a] - slack || p[a] > loc.min[a] + lim[a] * loc.cell + slack) return null;
      }
      const ix = Math.min(loc.nx - 1, Math.max(0, Math.floor((p[0] - loc.min[0]) / loc.cell)));
      const iy = Math.min(loc.ny - 1, Math.max(0, Math.floor((p[1] - loc.min[1]) / loc.cell)));
      const iz = Math.min(loc.nz - 1, Math.max(0, Math.floor((p[2] - loc.min[2]) / loc.cell)));
      const bucket = loc.buckets.get((ix * loc.ny + iy) * loc.nz + iz);
      if (!bucket) return null;
      for (const si of bucket) {
        const s = loc.simplices[si];
        const w = contains(s, p);
        if (w) return { simplex: s, weights: w };
      }
      return null;
    },
  };
}
