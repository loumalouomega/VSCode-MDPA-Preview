/**
 * Polyhedral cells -> tetrahedra, so a general polyhedron mesh can be viewed.
 *
 * Pure module: no vscode / DOM / wasm imports, so it is Node-testable without
 * instantiating the WASM binary.  meshioConvert.ts calls in here.
 *
 * Why this exists.  meshio++ hands a `polyhedron<N>` block over the WASM
 * boundary as a 2-level ragged CSR (cell -> faces -> node ids) and, since it
 * grew polyhedral readers for CGNS `NGON_n`/`NFACE_n`, MED `POE`, VTU
 * `VTK_POLYHEDRON` and OpenFOAM, real files now arrive carrying them.  There is
 * no VTK cell type for a general polyhedron in geometryMap.ts and no Kratos
 * element either, so adopting one as a drawable block is not on the table; the
 * mesh used to open EMPTY, with a diagnostic, which is the worst of both.
 * Decomposing is the honest middle: the geometry is exactly preserved and the
 * viewer draws real cells, at the cost of the original cell identity — which is
 * why this runs on READ only.  Nothing writes a polyhedron back out: an
 * MdpaModel has no polyhedron cell type, so modelToMeshio can never emit one.
 *
 * The decomposition.  Each face is fanned about its own CORNER AVERAGE, and
 * each resulting triangle is joined to the cell's corner average:
 *
 *   - a triangular face contributes one tet  (faceNodes + cellApex)
 *   - an n-gon face contributes n tets       (edge + faceApex + cellApex)
 *
 * Fanning about the corner average rather than about the face's first listed
 * node is deliberate and is what makes the total volume exact for a cell with
 * NON-PLANAR faces: a first-node fan depends on which corner the file happened
 * to list first, so two cells sharing a warped quad can disagree about the
 * surface between them and leave a sliver.  It is also the convention meshio++
 * itself adopted in 9.16.0 for its own signed volume, so a decomposed cell
 * measures the same here as it does upstream.
 *
 * Face apexes are deduplicated across the whole block by their sorted node-id
 * key — the same shared-entity trick linearToQuadratic.ts uses for mid-edge
 * nodes — so two cells sharing a face share its apex and the mesh does not tear
 * along the interface.  A cell apex is never shared (it is interior).
 *
 * Every emitted tet is oriented to positive volume.  Face winding in the source
 * file is whatever the writer chose, and an inverted tet would poison
 * meshQuality's dihedral angles and render inside-out for no reason a user
 * could act on.
 */

/**
 * The 2-level ragged CSR a polyhedral block arrives as.
 *
 * Declared here rather than imported from meshioConvert.ts so this module has
 * NO imports at all: both meshioConvert.ts (meshio++ blocks) and
 * vtkXmlParser.ts (a VTU's `faces`/`faceoffsets` arrays) call in, and importing
 * either way round would form a cycle.  `MeshioPolyhedronCellBlock` satisfies
 * it structurally.
 *
 * Cell `c`'s faces are `faceOffsets[cellOffsets[c] .. cellOffsets[c+1]]`; face
 * `f`'s node ids are `data[faceOffsets[f] .. faceOffsets[f+1]]`.
 */
export interface RaggedPolyhedronBlock {
  type: string;
  data: Int32Array;
  faceOffsets: Int32Array;
  cellOffsets: Int32Array;
}

/** Node indices of one tetrahedron, plus the block row it came from. */
export interface PolyhedronDecomposition {
  /** 4 point indices per tet, flat and 0-based, in VTK_TETRA order. */
  tets: Int32Array;
  /** One entry per tet: the index of the block row that produced it. */
  tetRow: Int32Array;
  /**
   * Coordinates of the apex points this decomposition had to invent, flat xyz,
   * numbered from the caller's `firstNewIndex` upward.
   */
  addedPoints: number[];
  /**
   * For each added point, the existing point indices whose mean it is — so the
   * caller can interpolate nodal fields at it, the rule refineMesh.ts and
   * linearToQuadratic.ts already use for a node they created.
   */
  addedParents: number[][];
  /** Rows that produced no tet at all (a face with fewer than 3 nodes, etc.). */
  skippedRows: number;
}

/** xyz of a point, whether the mesh stores 2 or 3 coordinates per point. */
function pointAt(
  points: Float64Array,
  dim: number,
  index: number,
  added: number[],
  firstNewIndex: number
): [number, number, number] {
  if (index >= firstNewIndex) {
    const o = (index - firstNewIndex) * 3;
    return [added[o], added[o + 1], added[o + 2]];
  }
  const o = index * dim;
  return [points[o], points[o + 1], dim === 3 ? points[o + 2] : 0];
}

/** Six times the signed volume of (a,b,c,d). Positive = VTK_TETRA orientation. */
function signedVolume6(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number]
): number {
  const b0 = b[0] - a[0], b1 = b[1] - a[1], b2 = b[2] - a[2];
  const c0 = c[0] - a[0], c1 = c[1] - a[1], c2 = c[2] - a[2];
  const d0 = d[0] - a[0], d1 = d[1] - a[1], d2 = d[2] - a[2];
  return (
    d0 * (b1 * c2 - b2 * c1) +
    d1 * (b2 * c0 - b0 * c2) +
    d2 * (b0 * c1 - b1 * c0)
  );
}

/**
 * Decomposes one polyhedron block into tetrahedra.
 *
 * `firstNewIndex` is the point index the first invented apex takes (i.e. the
 * mesh's current point count, including apexes an earlier block already added).
 */
export function decomposePolyhedronBlock(
  block: RaggedPolyhedronBlock,
  points: Float64Array,
  dim: number,
  firstNewIndex: number
): PolyhedronDecomposition {
  const { data, faceOffsets, cellOffsets } = block;
  const rowCount = Math.max(0, cellOffsets.length - 1);

  const tets: number[] = [];
  const tetRow: number[] = [];
  const addedPoints: number[] = [];
  const addedParents: number[][] = [];
  /** sorted-node-id key -> the shared apex index for that face. */
  const faceApex = new Map<string, number>();
  let skippedRows = 0;

  const at = (i: number): [number, number, number] =>
    pointAt(points, dim, i, addedPoints, firstNewIndex);

  /** Appends an apex at the mean of `parents` and returns its point index. */
  const addApex = (parents: number[]): number => {
    let x = 0, y = 0, z = 0;
    for (const p of parents) {
      const q = at(p);
      x += q[0];
      y += q[1];
      z += q[2];
    }
    const n = parents.length;
    const index = firstNewIndex + addedParents.length;
    addedPoints.push(x / n, y / n, z / n);
    addedParents.push(parents);
    return index;
  };

  /** Emits one tet, flipping it if the source winding made it inside-out. */
  const emitTet = (a: number, b: number, c: number, d: number, row: number): void => {
    if (a === b || a === c || a === d || b === c || b === d || c === d) return;
    if (signedVolume6(at(a), at(b), at(c), at(d)) < 0) {
      tets.push(a, c, b, d);
    } else {
      tets.push(a, b, c, d);
    }
    tetRow.push(row);
  };

  for (let row = 0; row < rowCount; row++) {
    const faceStart = cellOffsets[row];
    const faceEnd = cellOffsets[row + 1];
    const before = tets.length;

    // The cell's own corner set, in first-seen order, for its apex.
    const corners: number[] = [];
    const seen = new Set<number>();
    for (let f = faceStart; f < faceEnd; f++) {
      for (let k = faceOffsets[f]; k < faceOffsets[f + 1]; k++) {
        const n = data[k];
        if (!seen.has(n)) {
          seen.add(n);
          corners.push(n);
        }
      }
    }
    if (corners.length < 4 || faceEnd - faceStart < 4) {
      skippedRows++;
      continue; // not a closed volume; nothing meaningful to draw
    }
    const cellApex = addApex(corners);

    for (let f = faceStart; f < faceEnd; f++) {
      const nodeStart = faceOffsets[f];
      const nodeEnd = faceOffsets[f + 1];
      const n = nodeEnd - nodeStart;
      if (n < 3) continue; // a degenerate face contributes no volume
      if (n === 3) {
        emitTet(data[nodeStart], data[nodeStart + 1], data[nodeStart + 2], cellApex, row);
        continue;
      }
      const face: number[] = [];
      for (let k = nodeStart; k < nodeEnd; k++) face.push(data[k]);
      // Shared by both cells that own the face, so the two decompositions meet
      // on exactly the same triangles.
      const key = [...face].sort((x, y) => x - y).join(",");
      let apex = faceApex.get(key);
      if (apex === undefined) {
        apex = addApex(face);
        faceApex.set(key, apex);
      }
      for (let k = 0; k < n; k++) {
        emitTet(face[k], face[(k + 1) % n], apex, cellApex, row);
      }
    }
    if (tets.length === before) skippedRows++;
  }

  return {
    tets: Int32Array.from(tets),
    tetRow: Int32Array.from(tetRow),
    addedPoints,
    addedParents,
    skippedRows,
  };
}
