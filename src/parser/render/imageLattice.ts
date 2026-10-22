// Detects a model that is a dense regular lattice (roadmap item 22 D): what a
// `.vti` opens as, and what `sampleGrid` / `sdfVolume` write. Such a model can
// be shown as image data (volume, slices, contours) instead of hexahedron
// surface cells. Pure and order-independent: it works from the coordinates, so
// it does not matter whether the source numbered nodes x-fastest or shuffled
// them. Display only — the model itself is never changed.

import type { MdpaModel } from "../types";
import type { Vec3 } from "./types";

export interface LatticeScalar {
  name: string;
  /** nx*ny*nz values, x fastest then y then z (vtkImageData order). */
  values: Float32Array;
  range: [number, number];
}

export interface Lattice {
  dims: [number, number, number];
  origin: Vec3;
  spacing: Vec3;
  scalars: LatticeScalar[];
}

const HEXAHEDRON = 12;
const VOXEL = 11;

interface Axis {
  origin: number;
  step: number;
  n: number;
}

/** Distinct, evenly spaced coordinate values along one axis, or undefined. */
function axisOf(values: ArrayLike<number>, stride: number, offset: number, count: number): Axis | undefined {
  const v = new Float64Array(count);
  for (let i = 0; i < count; i++) v[i] = values[i * stride + offset];
  v.sort();
  const extent = v[count - 1] - v[0];
  if (!(extent > 0)) return undefined;
  const tol = extent * 1e-5;
  const distinct: number[] = [v[0]];
  for (let i = 1; i < count; i++) if (v[i] - distinct[distinct.length - 1] > tol) distinct.push(v[i]);
  const n = distinct.length;
  if (n < 2) return undefined;
  const step = (distinct[n - 1] - distinct[0]) / (n - 1);
  for (let i = 1; i < n; i++) {
    if (Math.abs(distinct[i] - distinct[i - 1] - step) > step * 1e-3) return undefined;
  }
  return { origin: distinct[0], step, n };
}

export function detectLattice(model: MdpaModel, maxPoints = 64_000_000): Lattice | undefined {
  const count = model.nodeCount;
  if (count < 8 || count > maxPoints) return undefined;
  if (model.blocks.length === 0) return undefined;
  let cells = 0;
  for (const b of model.blocks) {
    if (b.vtkCellType !== HEXAHEDRON && b.vtkCellType !== VOXEL) return undefined;
    cells += b.count;
  }
  const ax = axisOf(model.coords, 3, 0, count);
  const ay = axisOf(model.coords, 3, 1, count);
  const az = axisOf(model.coords, 3, 2, count);
  if (!ax || !ay || !az) return undefined;
  const [nx, ny, nz] = [ax.n, ay.n, az.n];
  if (nx * ny * nz !== count || cells !== (nx - 1) * (ny - 1) * (nz - 1)) return undefined;

  // node index -> lattice slot, rejecting a duplicate or off-lattice node
  const slotOf = new Int32Array(count);
  const seen = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const ix = Math.round((model.coords[i * 3] - ax.origin) / ax.step);
    const iy = Math.round((model.coords[i * 3 + 1] - ay.origin) / ay.step);
    const iz = Math.round((model.coords[i * 3 + 2] - az.origin) / az.step);
    if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) return undefined;
    const slot = ix + nx * (iy + ny * iz);
    if (seen[slot]) return undefined;
    seen[slot] = 1;
    slotOf[i] = slot;
  }

  // Cell connectivity must also be the lattice's own: every cell spans exactly
  // one step on each axis (a sheared or warped hex mesh on lattice points
  // would otherwise pass the point test).
  for (const b of model.blocks) {
    if (b.stride !== 8) return undefined;
  }

  const idToIndex = new Map<number, number>();
  const sequential = model.nodeIds.length === count && model.nodeIds.every((id, i) => id === i + 1);
  if (!sequential) for (let i = 0; i < count; i++) idToIndex.set(model.nodeIds[i], i);

  const scalars: LatticeScalar[] = [];
  for (const f of model.fields) {
    if (f.kind !== "Nodal" || f.components !== 1 || f.ids.length !== count) continue;
    const values = new Float32Array(count);
    let lo = Infinity;
    let hi = -Infinity;
    let ok = true;
    for (let r = 0; r < count; r++) {
      const idx = sequential ? f.ids[r] - 1 : idToIndex.get(f.ids[r]);
      if (idx === undefined || idx < 0 || idx >= count) {
        ok = false;
        break;
      }
      const v = f.values[r];
      values[slotOf[idx]] = v;
      if (Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (ok && lo <= hi) scalars.push({ name: f.variable, values, range: [lo, hi] });
  }
  if (scalars.length === 0) return undefined;
  return {
    dims: [nx, ny, nz],
    origin: [ax.origin, ay.origin, az.origin],
    spacing: [ax.step, ay.step, az.step],
    scalars,
  };
}
