/**
 * Red-green subdivision templates for the two simplices, and the promotion rule
 * that keeps a partial refinement conforming.
 *
 * Pure (no `vscode`/DOM/vtk/fs). Local index convention, shared with
 * `refineMesh.ts`: corners `0..n-1`, then one midpoint per edge in
 * `meshTopology.ts`'s edge order — so tet midpoints are
 * `4=(0,1) 5=(1,2) 6=(2,0) 7=(0,3) 8=(1,3) 9=(2,3)` and bit `i` of a split mask
 * is edge `i` of that same table.
 *
 * ## Why there is no tie-break in this file
 *
 * The classic red-green trap is a shared face carrying exactly TWO refined
 * edges: its diagonal must be chosen identically from both sides, which
 * normally forces a rule over global node ids. Bey's admissible set makes that
 * case unreachable, and that is the invariant the whole design rests on:
 *
 *   the four faces of a tet, by edge index, are
 *     (0,1,2) = {e0,e1,e2}   (0,1,3) = {e0,e4,e3}
 *     (0,2,3) = {e2,e5,e3}   (1,2,3) = {e1,e5,e4}
 *
 *   - mask 0                : every face carries 0
 *   - a single edge         : the 2 faces containing it carry 1, the others 0
 *   - an OPPOSITE pair      : every face meets such a pair in exactly one edge
 *   - a FACE triple         : that face carries 3, each other shares exactly
 *                             one edge with it and so carries 1
 *   - red (63)              : every face carries 3
 *
 * so no admissible mask ever gives a face two refined edges. A face with 0, 1
 * or 3 refined edges has exactly ONE possible split, so the children's trace on
 * any face is a pure function of the global refined-edge set restricted to that
 * face — identical from both sides by construction, with no reference to local
 * indices, cell order or node ids anywhere. `refineTemplates.test.ts` proves it
 * exhaustively over all 15 masks x 4 faces rather than trusting this comment.
 *
 * Admitting adjacent pairs would reintroduce the two-edge face and with it the
 * hardest-to-test bug class in the feature, in exchange for a modest cell-count
 * reduction. Do not.
 *
 * Triangles are different and simpler: 2D has no conformity constraint at all,
 * because an edge is either split or not and the only choice a triangle makes —
 * the diagonal of its two-edge case — is INTERIOR to the cell and shared with
 * nobody. All 8 masks are admissible and nothing is ever promoted.
 */

import { VtkCellType } from "./geometryMap";

const C = VtkCellType;

/** Bits set in a 6-bit mask. */
export function popcount(mask: number): number {
  let n = 0;
  for (let m = mask; m; m >>= 1) n += m & 1;
  return n;
}

// --- tetrahedron -------------------------------------------------------------

/** Masks whose three edges bound one face, in face order (0,1,2) (0,1,3) (0,2,3) (1,2,3). */
export const TET_FACE_MASKS: readonly number[] = [
  0b000111, // e0,e1,e2 -> face (0,1,2), apex 3
  0b011001, // e0,e3,e4 -> face (0,1,3), apex 2
  0b101100, // e2,e3,e5 -> face (0,2,3), apex 1
  0b110010, // e1,e4,e5 -> face (1,2,3), apex 0
];

/** Masks of two vertex-disjoint edges. Their bisection planes commute. */
export const TET_OPPOSITE_MASKS: readonly number[] = [
  0b100001, // e0 (0,1) + e5 (2,3)
  0b001010, // e1 (1,2) + e3 (0,3)
  0b010100, // e2 (2,0) + e4 (1,3)
];

export const TET_RED_MASK = 0b111111;

/**
 * A single-edge bisection is a rule, not a table: replace one endpoint of the
 * split edge with its midpoint to get one child, the other endpoint for the
 * other. Both keep the parent's orientation because the midpoint lies between
 * them.
 */
function tetBisect(edge: number): number[][] {
  const [u, v] = TET_EDGE_CORNERS[edge];
  const m = 4 + edge;
  const a = [0, 1, 2, 3].map((x) => (x === u ? m : x));
  const b = [0, 1, 2, 3].map((x) => (x === v ? m : x));
  return [a, b];
}

/** Local corners of tet edge i — the same order as meshTopology's TET_EDGES. */
const TET_EDGE_CORNERS: readonly [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 0],
  [0, 3],
  [1, 3],
  [2, 3],
];

/** Midpoint local index of the edge joining two corners, or -1. */
function midOf(u: number, v: number): number {
  for (let i = 0; i < TET_EDGE_CORNERS.length; i++) {
    const [a, b] = TET_EDGE_CORNERS[i];
    if ((a === u && b === v) || (a === v && b === u)) return 4 + i;
  }
  return -1;
}

/** The medial 4-split of face (a,b,c) coned to apex d. */
function tetFaceSplit(a: number, b: number, c: number, d: number): number[][] {
  const mab = midOf(a, b);
  const mbc = midOf(b, c);
  const mca = midOf(c, a);
  return [
    [a, mab, mca, d],
    [mab, b, mbc, d],
    [mca, mbc, c, d],
    [mab, mbc, mca, d],
  ];
}

/** Face corner triples, in TET_FACE_MASKS order, wound so the apex is positive. */
const TET_FACE_CORNERS: readonly [number, number, number, number][] = [
  [0, 1, 2, 3], // face (0,1,2), apex 3
  [1, 0, 3, 2], // face (0,1,3), apex 2
  [0, 2, 3, 1], // face (0,2,3), apex 1
  [2, 1, 3, 0], // face (1,2,3), apex 0
];

/** The existing uniform split — 4 corner tets + the central octahedron on 6-8. */
const TET_RED: number[][] = [
  [0, 4, 6, 7],
  [4, 1, 5, 8],
  [6, 5, 2, 9],
  [7, 8, 9, 3],
  [4, 5, 6, 8],
  [4, 6, 7, 8],
  [6, 7, 8, 9],
  [5, 6, 8, 9],
];

// --- triangle ----------------------------------------------------------------

/** Local corners of triangle edge i (meshTopology's TRIANGLE_EDGES order). */
const TRI_EDGE_CORNERS: readonly [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 0],
];

const TRI_RED: number[][] = [
  [0, 3, 5],
  [3, 1, 4],
  [5, 4, 2],
  [3, 4, 5],
];

/**
 * The two-edge cases, each as `{corner, quad}`: one corner triangle plus a quad
 * that must be cut by one of two diagonals. Both options are given because the
 * choice is a per-cell QUALITY decision the caller makes from coordinates — it
 * needs no neighbour agreement, since the diagonal is interior to the cell.
 */
const TRI_TWO_EDGE: Record<number, { corner: number[]; quad: [number, number, number, number] }> = {
  0b011: { corner: [3, 1, 4], quad: [0, 3, 4, 2] }, // e0,e1
  0b110: { corner: [4, 2, 5], quad: [0, 1, 4, 5] }, // e1,e2
  0b101: { corner: [0, 3, 5], quad: [3, 1, 2, 5] }, // e0,e2
};

/**
 * Chooses between two candidate diagonals of a quad, by LOCAL index.
 * Returns true to take `a`-`b` rather than `c`-`d`.
 */
export type DiagonalChooser = (a: number, b: number, c: number, d: number) => boolean;

// --- the public surface ------------------------------------------------------

/** Whether a mask can be split without leaving a face two refined edges. */
export function isAdmissible(cellType: number, mask: number): boolean {
  if (cellType === C.TRIANGLE) return mask >= 0 && mask <= 0b111;
  if (cellType !== C.TETRA) return mask === 0;
  if (mask === 0 || mask === TET_RED_MASK) return true;
  if (popcount(mask) === 1) return true;
  return TET_OPPOSITE_MASKS.includes(mask) || TET_FACE_MASKS.includes(mask);
}

/**
 * The smallest admissible superset of `mask`.
 *
 * Built as a lookup at module load from the class predicates rather than typed
 * out, so the table cannot drift from the definition above it.
 */
const TET_PROMOTE: number[] = (() => {
  const table = new Array<number>(64);
  for (let mask = 0; mask < 64; mask++) {
    if (isAdmissible(C.TETRA, mask)) {
      table[mask] = mask;
      continue;
    }
    if (popcount(mask) === 2) {
      // Two edges sharing a vertex span three corners, and any three corners of
      // a tet bound a face — so exactly one face mask contains both. (No two
      // face masks share more than one bit, which is what makes it unique.)
      const face = TET_FACE_MASKS.find((f) => (mask & f) === mask);
      table[mask] = face ?? TET_RED_MASK;
      continue;
    }
    table[mask] = TET_RED_MASK;
  }
  return table;
})();

export function promoteMask(cellType: number, mask: number): number {
  if (cellType === C.TRIANGLE) return mask; // every triangle mask is admissible
  if (cellType === C.TETRA) return TET_PROMOTE[mask];
  // Line: one edge, so the only masks are 0 and 1 and both are splittable.
  if (cellType === C.LINE) return mask;
  return mask;
}

/**
 * Children of one cell under an ADMISSIBLE mask, as local index tuples.
 *
 * `undefined` means the caller should leave the cell alone (mask 0), and a
 * non-simplex type is never passed here — `refineMesh.ts` refuses those before
 * the closure runs.
 */
export function splitChildren(
  cellType: number,
  mask: number,
  preferDiagonal?: DiagonalChooser
): number[][] | undefined {
  if (mask === 0) return undefined;

  if (cellType === C.LINE) return [[0, 2], [2, 1]];

  if (cellType === C.TRIANGLE) {
    if (mask === 0b111) return TRI_RED;
    const two = TRI_TWO_EDGE[mask];
    if (two) {
      const [p, q, r, s] = two.quad;
      // Diagonals of quad (p,q,r,s) are p-r and q-s.
      const takePR = preferDiagonal ? preferDiagonal(p, r, q, s) : true;
      return takePR
        ? [two.corner, [p, q, r], [p, r, s]]
        : [two.corner, [p, q, s], [q, r, s]];
    }
    // A single edge: bisect from the opposite corner.
    const edge = Math.log2(mask) | 0;
    const [u, v] = TRI_EDGE_CORNERS[edge];
    const m = 3 + edge;
    const w = [0, 1, 2].find((x) => x !== u && x !== v)!;
    return [
      [u, m, w],
      [m, v, w],
    ];
  }

  if (cellType === C.TETRA) {
    if (mask === TET_RED_MASK) return TET_RED;
    if (popcount(mask) === 1) return tetBisect(Math.log2(mask) | 0);
    const opp = TET_OPPOSITE_MASKS.indexOf(mask);
    if (opp >= 0) {
      // Two independent bisections. The edges are vertex-disjoint so the planes
      // commute — the result is canonical, not a choice.
      const bits: number[] = [];
      for (let i = 0; i < 6; i++) if (mask & (1 << i)) bits.push(i);
      let cells = [[0, 1, 2, 3]];
      for (const e of bits) {
        const [u, v] = TET_EDGE_CORNERS[e];
        const m = 4 + e;
        const next: number[][] = [];
        for (const cell of cells) {
          next.push(cell.map((x) => (x === u ? m : x)));
          next.push(cell.map((x) => (x === v ? m : x)));
        }
        cells = next;
      }
      return cells;
    }
    const face = TET_FACE_MASKS.indexOf(mask);
    if (face >= 0) {
      const [a, b, c, d] = TET_FACE_CORNERS[face];
      return tetFaceSplit(a, b, c, d);
    }
  }
  return undefined;
}
