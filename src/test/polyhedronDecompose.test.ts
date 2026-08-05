/**
 * Polyhedral cell -> tetrahedra (polyhedronDecompose.ts).
 *
 * The properties worth pinning are geometric, not structural: the tets must
 * FILL the original cell (no sliver, no overlap), they must all be wound
 * positively whatever the source file's face winding was, and two cells sharing
 * a face must meet on the same triangles rather than tearing apart.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  decomposePolyhedronBlock,
  PolyhedronDecomposition,
  RaggedPolyhedronBlock,
} from "../parser/polyhedronDecompose";

/** Builds the ragged CSR from a per-cell list of faces. */
function block(cells: number[][][], type = "polyhedron"): RaggedPolyhedronBlock {
  const data: number[] = [];
  const faceOffsets: number[] = [0];
  const cellOffsets: number[] = [0];
  for (const faces of cells) {
    for (const f of faces) {
      data.push(...f);
      faceOffsets.push(data.length);
    }
    cellOffsets.push(faceOffsets.length - 1);
  }
  return {
    type,
    data: Int32Array.from(data),
    faceOffsets: Int32Array.from(faceOffsets),
    cellOffsets: Int32Array.from(cellOffsets),
  };
}

/** The six outward-wound quad faces of a unit cube on points 0..7. */
const CUBE_FACES = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];

const CUBE_POINTS = new Float64Array([
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
  0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
]);

/** Total signed volume of the emitted tets, reading apexes out of the result. */
function totalVolume(
  d: PolyhedronDecomposition,
  points: Float64Array,
  firstNewIndex: number
): number {
  const at = (i: number): number[] => {
    if (i >= firstNewIndex) {
      const o = (i - firstNewIndex) * 3;
      return [d.addedPoints[o], d.addedPoints[o + 1], d.addedPoints[o + 2]];
    }
    return [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
  };
  let v = 0;
  for (let t = 0; t < d.tetRow.length; t++) {
    const [A, B, C, D] = [0, 1, 2, 3].map((k) => at(d.tets[t * 4 + k]));
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const z = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
    v +=
      (z[0] * (u[1] * w[2] - u[2] * w[1]) +
        z[1] * (u[2] * w[0] - u[0] * w[2]) +
        z[2] * (u[0] * w[1] - u[1] * w[0])) /
      6;
  }
  return v;
}

test("a cube decomposes into one tet per face edge, conserving volume", () => {
  const d = decomposePolyhedronBlock(block([CUBE_FACES]), CUBE_POINTS, 3, 8);
  assert.equal(d.tetRow.length, 24, "6 quad faces x 4 edges");
  assert.equal(d.addedParents.length, 7, "1 cell apex + 6 face apexes");
  assert.equal(d.skippedRows, 0);
  assert.ok(Math.abs(totalVolume(d, CUBE_POINTS, 8) - 1) < 1e-9);
});

test("every emitted tet is wound positively, even from inverted faces", () => {
  // Reversing every face inverts the source winding — the exact condition that
  // would otherwise produce 24 negative-volume tets that render inside-out.
  const inverted = CUBE_FACES.map((f) => [...f].reverse());
  for (const faces of [CUBE_FACES, inverted]) {
    const d = decomposePolyhedronBlock(block([faces]), CUBE_POINTS, 3, 8);
    const v = totalVolume(d, CUBE_POINTS, 8);
    assert.ok(v > 0, `total volume positive, got ${v}`);
    assert.ok(Math.abs(v - 1) < 1e-9, `unit volume, got ${v}`);
  }
});

test("a cell with NON-PLANAR faces still measures exactly", () => {
  // The reason faces are fanned about their corner average rather than about
  // their first listed node: with a warped face the first-node fan depends on
  // which corner the file happened to list first, so the two conventions
  // disagree — and only the corner-average one matches meshio++'s own signed
  // volume (its 9.16.0 change).
  const pts = new Float64Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0.5, 0, 1, 0, // bottom is warped: z=0.5 at corner 2
    0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2,
  ]);
  const d = decomposePolyhedronBlock(block([CUBE_FACES]), pts, 3, 8);
  const v = totalVolume(d, pts, 8);
  // Exact value: the prism-with-a-warped-base volume, integrated as the mean of
  // the four top-bottom column heights (2, 2, 1.5, 2) over a unit square.
  assert.ok(Math.abs(v - 1.875) < 1e-9, `expected 1.875, got ${v}`);
});

test("two cells sharing a face share its apex, so the mesh does not tear", () => {
  // Stacked unit cubes: 12 points, sharing the quad 4,5,6,7.
  const pts = new Float64Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2,
  ]);
  const lower = CUBE_FACES;
  const upper = [
    [4, 7, 6, 5],
    [8, 9, 10, 11],
    [4, 5, 9, 8],
    [5, 6, 10, 9],
    [6, 7, 11, 10],
    [7, 4, 8, 11],
  ];
  const d = decomposePolyhedronBlock(block([lower, upper]), pts, 3, 12);
  assert.equal(d.tetRow.length, 48, "24 tets per cell");
  // 2 cell apexes + 11 distinct faces (the shared one counted once) = 13.
  assert.equal(d.addedParents.length, 13, "the shared face contributes ONE apex");
  assert.ok(Math.abs(totalVolume(d, pts, 12) - 2) < 1e-9, "two unit cubes");
});

test("an apex takes the mean of its generators", () => {
  const d = decomposePolyhedronBlock(block([CUBE_FACES]), CUBE_POINTS, 3, 8);
  // The cell apex is added first and generated by all 8 corners.
  assert.equal(d.addedParents[0].length, 8);
  assert.deepEqual(
    [d.addedPoints[0], d.addedPoints[1], d.addedPoints[2]],
    [0.5, 0.5, 0.5],
    "the cube's centre"
  );
  for (const parents of d.addedParents.slice(1)) {
    assert.equal(parents.length, 4, "a quad face apex has four generators");
  }
});

test("a cell that is not a closed volume is reported, not emitted", () => {
  // One triangular face is not a polyhedron.
  const d = decomposePolyhedronBlock(block([[[0, 1, 2]]]), CUBE_POINTS, 3, 8);
  assert.equal(d.tetRow.length, 0);
  assert.equal(d.skippedRows, 1);
  assert.equal(d.addedParents.length, 0, "no apex invented for a skipped cell");
});

test("a tetrahedron's triangular faces need no face apex", () => {
  const faces = [
    [0, 2, 1],
    [0, 1, 3],
    [1, 2, 3],
    [2, 0, 3],
  ];
  const pts = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const d = decomposePolyhedronBlock(block([faces]), pts, 3, 4);
  assert.equal(d.tetRow.length, 4, "one tet per triangular face");
  assert.equal(d.addedParents.length, 1, "only the cell apex");
  assert.ok(Math.abs(totalVolume(d, pts, 4) - 1 / 6) < 1e-12);
});

test("an empty block is a noop", () => {
  const d = decomposePolyhedronBlock(block([]), CUBE_POINTS, 3, 8);
  assert.equal(d.tetRow.length, 0);
  assert.equal(d.addedPoints.length, 0);
  assert.equal(d.skippedRows, 0);
});
