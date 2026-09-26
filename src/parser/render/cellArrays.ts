// Cell-array layout conversions for the renderer boundary (roadmap item 18).
//
// DisplayGeometry carries VTK's LEGACY layout (`[n, i0 … in-1]*`), which vtk.js
// consumes directly. VTK 9's own vtkCellArray stores offsets + connectivity,
// and the measured VTK-wasm pitfall is that handing its SetData a legacy array
// is accepted, logged, and yields ZERO cells — so the wasm backend converts
// here, with every count and index validated, rather than trusting the shape.
//
// The cell index answers "which points does cell k use" from the geometry the
// webview already holds, in VTK's verts -> lines -> polys enumeration — the
// same order a picked cell id and every cell-data array follow — so picking
// resolves identically on either backend without asking the renderer.

import type { DisplayGeometry } from "./types";

export interface OffsetsConnectivity {
  /** `count + 1` offsets into `connectivity`. */
  offsets: Int32Array;
  connectivity: Int32Array;
  count: number;
}

/** Largest point index a 32-bit vtkIdType (the wasm32 build) can address. */
export const MAX_ID_32 = 0x7fffffff;

/**
 * Legacy `[n, i0…]*` -> offsets/connectivity. Throws on a truncated cell or an
 * index outside `[0, pointCount)` — a corrupt array must not become a
 * silently different mesh.
 */
export function legacyToOffsets(legacy: ArrayLike<number> | undefined, pointCount: number): OffsetsConnectivity {
  if (!legacy || legacy.length === 0) return { offsets: new Int32Array([0]), connectivity: new Int32Array(0), count: 0 };
  if (pointCount > MAX_ID_32) throw new RangeError(`${pointCount} points exceed the 32-bit id range`);
  let count = 0;
  let connLen = 0;
  for (let i = 0; i < legacy.length; ) {
    const n = legacy[i];
    if (!Number.isInteger(n) || n < 0 || i + 1 + n > legacy.length) {
      throw new RangeError(`truncated or malformed cell at array index ${i} (n=${n})`);
    }
    count++;
    connLen += n;
    i += 1 + n;
  }
  const offsets = new Int32Array(count + 1);
  const connectivity = new Int32Array(connLen);
  let c = 0;
  let k = 0;
  for (let i = 0; i < legacy.length; ) {
    const n = legacy[i++];
    for (let j = 0; j < n; j++) {
      const p = legacy[i++];
      if (p < 0 || p >= pointCount) throw new RangeError(`cell ${c} references point ${p} of ${pointCount}`);
      connectivity[k++] = p;
    }
    offsets[++c] = k;
  }
  return { offsets, connectivity, count };
}

/** Number of cells in a legacy array. */
export function legacyCellCount(legacy: ArrayLike<number> | undefined): number {
  if (!legacy) return 0;
  let count = 0;
  for (let i = 0; i < legacy.length; i += 1 + legacy[i]) count++;
  return count;
}

export interface CellIndex {
  /** Total cells, verts then lines then polys. */
  count: number;
  /** For each cell: which legacy array (0 verts, 1 lines, 2 polys). */
  array: Uint8Array;
  /** For each cell: position of its `n` in that array. */
  start: Uint32Array;
}

const KINDS = ["verts", "lines", "polys"] as const;

export function buildCellIndex(g: DisplayGeometry): CellIndex {
  const counts = KINDS.map((k) => legacyCellCount(g[k]));
  const count = counts[0] + counts[1] + counts[2];
  const array = new Uint8Array(count);
  const start = new Uint32Array(count);
  let c = 0;
  KINDS.forEach((k, a) => {
    const legacy = g[k];
    if (!legacy) return;
    for (let i = 0; i < legacy.length; i += 1 + legacy[i]) {
      array[c] = a;
      start[c] = i;
      c++;
    }
  });
  return { count, array, start };
}

/** Local point ids of cell `cellId` (empty when out of range). */
export function cellPointIds(g: DisplayGeometry, index: CellIndex, cellId: number): number[] {
  if (!Number.isInteger(cellId) || cellId < 0 || cellId >= index.count) return [];
  const legacy = g[KINDS[index.array[cellId]]]!;
  const s = index.start[cellId];
  const n = legacy[s];
  const out = new Array<number>(n);
  for (let j = 0; j < n; j++) out[j] = legacy[s + 1 + j];
  return out;
}
