/**
 * The cell edge tables (`parser/meshTopology.ts`).
 *
 * These moved out of `refineMesh.ts`, where uniform subdivision was their only
 * consumer and their ORDER was an unstated internal detail. Two things now
 * depend on that order from outside — the red-green split mask indexes tet
 * edges by position, and `refineMesh.ts`'s local index layout is "corners, then
 * one midpoint per edge in this order" — so the order is pinned here rather
 * than left to be rediscovered.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { VtkCellType as C } from "../parser/geometryMap";
import {
  cellEdges,
  edgeKey,
  LINE_EDGES,
  TRIANGLE_EDGES,
  QUAD_EDGES,
  TET_EDGES,
  HEX_EDGES,
  WEDGE_EDGES,
  PYRAMID_EDGES,
} from "../parser/meshTopology";

const CORNERS: [number, readonly (readonly number[])[], number][] = [
  [C.LINE, LINE_EDGES, 2],
  [C.TRIANGLE, TRIANGLE_EDGES, 3],
  [C.QUAD, QUAD_EDGES, 4],
  [C.TETRA, TET_EDGES, 4],
  [C.HEXAHEDRON, HEX_EDGES, 8],
  [C.WEDGE, WEDGE_EDGES, 6],
  [C.PYRAMID, PYRAMID_EDGES, 5],
];

test("every table is a set of distinct corner pairs inside the cell", () => {
  for (const [type, edges, corners] of CORNERS) {
    const seen = new Set<string>();
    for (const [a, b] of edges) {
      assert.notEqual(a, b, `type ${type}: an edge joins two distinct corners`);
      assert.ok(a >= 0 && a < corners && b >= 0 && b < corners, `type ${type}: corner in range`);
      const k = edgeKey(a, b);
      assert.ok(!seen.has(k), `type ${type}: edge ${k} listed twice`);
      seen.add(k);
    }
    assert.equal(seen.size, edges.length);
  }
});

test("edge counts are the ones the cell types actually have", () => {
  // A wrong count is the failure mode that looks harmless: a missing edge is a
  // midpoint that never gets created, i.e. a hole in the refined cell.
  const expected = new Map<number, number>([
    [C.LINE, 1],
    [C.TRIANGLE, 3],
    [C.QUAD, 4],
    [C.TETRA, 6],
    [C.HEXAHEDRON, 12],
    [C.WEDGE, 9],
    [C.PYRAMID, 8],
  ]);
  for (const [type, edges] of CORNERS) assert.equal(edges.length, expected.get(type));
});

test("the tet edge order is the one the split mask is indexed by", () => {
  // Bit i of a red-green mask IS edge i of this table, and refineTemplates.ts's
  // admissibility proof is written in these indices. Reordering the table would
  // silently invalidate both, with no type error anywhere.
  assert.deepEqual(TET_EDGES.map((e) => [...e]), [
    [0, 1],
    [1, 2],
    [2, 0],
    [0, 3],
    [1, 3],
    [2, 3],
  ]);
});

test("a quadratic cell reports its LINEAR corner edges", () => {
  // The same convention cornerCount/volumeFaces already follow: a mid-side node
  // is a property of the edge, not another edge.
  assert.equal(cellEdges(C.QUADRATIC_TETRA), TET_EDGES);
  assert.equal(cellEdges(C.QUADRATIC_TRIANGLE), TRIANGLE_EDGES);
  assert.equal(cellEdges(C.QUADRATIC_HEXAHEDRON), HEX_EDGES);
});

test("an unknown or point cell type has no edges", () => {
  assert.equal(cellEdges(C.VERTEX), undefined);
  assert.equal(cellEdges(undefined), undefined);
  assert.equal(cellEdges(9999), undefined);
});

test("edgeKey is unordered, so both cells touching an edge agree", () => {
  assert.equal(edgeKey(7, 3), edgeKey(3, 7));
  assert.equal(edgeKey(3, 7), "3,7");
});
