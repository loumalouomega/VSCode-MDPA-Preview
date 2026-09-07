/**
 * Cell topology tables: which local corner indices form a cell's edges.
 *
 * Pure (no `vscode`/DOM/vtk), the 1D/2D counterpart to `writers/writerCommon.ts`'s
 * `volumeFaces`, which returns null for TRIANGLE and QUAD and therefore leaves a
 * 2D mesh with no incidence information anywhere in the repo. The tables lived
 * inside `refineMesh.ts` because uniform subdivision was their only consumer;
 * selective refinement needs the same edges to decide which cells a refined edge
 * touches, and the pyramid table exists purely so a block that CANNOT be refined
 * can still be asked whether it shares an edge with one that was.
 *
 * Corner indices, never node ids: a caller maps them through its own cell's
 * connectivity. Quadratic types report their LINEAR corner edges, the same
 * convention `cornerCount`/`volumeFaces` already follow — a mid-side node is a
 * property of the edge, not another edge.
 */

import { VtkCellType } from "./geometryMap";

const C = VtkCellType;

export const LINE_EDGES: readonly (readonly number[])[] = [[0, 1]];

export const TRIANGLE_EDGES: readonly (readonly number[])[] = [
  [0, 1],
  [1, 2],
  [2, 0],
];

export const QUAD_EDGES: readonly (readonly number[])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
];

/**
 * Tet edge order is load-bearing beyond this module: the red-green closure
 * indexes a 6-bit split mask by it, and `refineTemplates.ts`'s admissibility
 * proof is stated in these indices. Reordering silently invalidates both.
 */
export const TET_EDGES: readonly (readonly number[])[] = [
  [0, 1],
  [1, 2],
  [2, 0],
  [0, 3],
  [1, 3],
  [2, 3],
];

export const HEX_EDGES: readonly (readonly number[])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

export const WEDGE_EDGES: readonly (readonly number[])[] = [
  [0, 1],
  [1, 2],
  [2, 0],
  [3, 4],
  [4, 5],
  [5, 3],
  [0, 3],
  [1, 4],
  [2, 5],
];

/**
 * The one table `refineMesh.ts` never needed: a pyramid has no same-type
 * refinement, so it is skipped — but a skipped cell that shares an EDGE with a
 * refined one still ends up with a node sitting inside that edge, which is
 * exactly the hanging node the refuser has to detect.
 */
export const PYRAMID_EDGES: readonly (readonly number[])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [0, 4],
  [1, 4],
  [2, 4],
  [3, 4],
];

/** Local corner-index edges for a cell type, or undefined if unknown. */
export function cellEdges(type: number | undefined): readonly (readonly number[])[] | undefined {
  switch (type) {
    case C.LINE:
    case C.QUADRATIC_EDGE:
      return LINE_EDGES;
    case C.TRIANGLE:
    case C.QUADRATIC_TRIANGLE:
      return TRIANGLE_EDGES;
    case C.QUAD:
    case C.QUADRATIC_QUAD:
      return QUAD_EDGES;
    case C.TETRA:
    case C.QUADRATIC_TETRA:
      return TET_EDGES;
    case C.HEXAHEDRON:
    case C.QUADRATIC_HEXAHEDRON:
      return HEX_EDGES;
    case C.WEDGE:
    case C.QUADRATIC_WEDGE:
      return WEDGE_EDGES;
    case C.PYRAMID:
    case C.QUADRATIC_PYRAMID:
      return PYRAMID_EDGES;
    default:
      return undefined;
  }
}

/** Unordered node-id pair key, so both cells touching an edge agree. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}
