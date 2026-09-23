import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { surfaceDefects, surfaceDefectsSummary } from "../parser/surfaceDefects";

const tris = (nodes: number[][], faces: number[][]): string =>
  "Begin Nodes\n" + nodes.map((n, i) => `${i + 1} ${n.join(" ")}`).join("\n") + "\nEnd Nodes\nBegin Elements Element2D3N\n" +
  faces.map((f, i) => `${i + 1} 0 ${f.join(" ")}`).join("\n") + "\nEnd Elements\n";

test("three faces sharing one edge make a non-manifold edge, and no boundary edge on that spine", () => {
  const d = surfaceDefects(parseMdpa(tris(
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]],
    [[1, 2, 3], [1, 4, 2], [1, 2, 5]]
  )));
  assert.deepEqual(d.nonManifoldEdges, [[1, 2]]);
  assert.ok(!d.boundaryEdges.some(([a, b]) => a === 1 && b === 2));
});

test("two faces traversing their shared edge the same way are both reported", () => {
  const d = surfaceDefects(parseMdpa(tris([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], [[1, 2, 3], [1, 2, 4]])));
  assert.deepEqual(d.inconsistentFaces.map((f) => f.id).sort(), [1, 2]);
  const ok = surfaceDefects(parseMdpa(tris([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], [[1, 2, 3], [2, 1, 4]])));
  assert.equal(ok.inconsistentFaces.length, 0);
});

test("a zero-area face is reported, and a solid contributes no surface cells", () => {
  const flat = surfaceDefects(parseMdpa(tris([[0, 0, 0], [1, 0, 0], [2, 0, 0]], [[1, 2, 3]])));
  assert.equal(flat.degenerateFaces.length, 1);
  assert.match(surfaceDefectsSummary(flat), /zero-area/);
  const solid = surfaceDefects(parseMdpa(
    "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\nEnd Nodes\nBegin Elements Element3D4N\n1 0 1 2 3 4\nEnd Elements\n"
  ));
  assert.equal(solid.surfaceCellCount, 0);
  assert.equal(surfaceDefectsSummary(solid), "no surface cells to check");
});
