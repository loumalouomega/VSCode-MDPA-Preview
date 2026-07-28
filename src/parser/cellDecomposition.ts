/**
 * Volume/surface cell decomposition into simplices (tetrahedra / triangles),
 * by local corner index. Shared by `isoSurface.ts` (marching tetrahedra needs a
 * tet mesh to march over) and `simplexify.ts` (the same tables, applied as a
 * mesh operation rather than an internal step).
 *
 * Pure module: no vscode / DOM / vtk.js imports.
 */

import { VtkCellType } from "./geometryMap";

const C = VtkCellType;

/** A single tetrahedron: linear/quadratic tets need no splitting. */
export const TET_TETS = [[0, 1, 2, 3]];

/** Apex-fan split: 2 tets, sharing the diagonal through the apex. */
export const PYRAMID_TETS = [
  [0, 1, 2, 4],
  [0, 2, 3, 4],
];

/** 3-tet split of a triangular prism. */
export const WEDGE_TETS = [
  [0, 1, 2, 3],
  [1, 2, 3, 4],
  [2, 3, 4, 5],
];

/**
 * Standard 6-tet decomposition around the space diagonal 0-6. Exact for tet
 * meshes; adjacent hexes can leave hairline cracks where shared-face diagonals
 * disagree — acceptable for visualization (isosurface) and for simplexify,
 * where the same diagonal choice is what keeps neighbours conforming.
 */
export const HEX_TETS = [
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
  [0, 5, 1, 6],
];

/** A single triangle: already a simplex. */
export const TRI_TRIS = [[0, 1, 2]];

/** 2-triangle split of a quad, diagonal 0-2. */
export const QUAD_TRIS = [
  [0, 1, 2],
  [0, 2, 3],
];

export interface CellDecomposition {
  corners: number;
  /** Volume decomposition (local corner index triples… quadruples). */
  tets?: number[][];
  /** Surface decomposition. */
  tris?: number[][];
}

/**
 * The decomposition for a cell type, corners-only (quadratic cell types
 * decompose the same as their linear base — the extra mid-side nodes are
 * simply dropped, exactly like `linearize.ts`).
 */
export function decompositionFor(cellType?: number): CellDecomposition {
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
