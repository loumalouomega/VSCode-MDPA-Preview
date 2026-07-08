import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import { VtkCellType } from "../parser/geometryMap";
import { linearToQuadratic } from "../parser/linearToQuadratic";

// Two triangles sharing edge 1-3, plus one tetrahedron on disjoint nodes.
// A nodal field defined only on nodes 1,2,3 (with distinct averages), and a
// SubModelPart "Surf" owning triangle element 1 + nodes 1,2,3.
const SRC = `Begin Properties 1
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 0.0 0.0 1.0
6 1.0 0.0 1.0
7 0.0 1.0 1.0
8 0.0 0.0 2.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
2 1 1 3 4
End Elements

Begin Elements Element3D4N
3 1 5 6 7 8
End Elements

Begin NodalData TEMPERATURE
1 0 10.0
2 0 20.0
3 0 50.0
End NodalData

Begin SubModelPart Surf
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`;

test("widens linear cells to quadratic strides and cell types", () => {
  const m = parseMdpa(SRC);
  const { model, convertedCells } = linearToQuadratic(m);

  assert.equal(convertedCells, 3); // two triangles + one tet

  const tri = model.blocks.find((b) => b.name === "Element2D6N")!;
  const tet = model.blocks.find((b) => b.name === "Element3D10N")!;
  assert.ok(tri, "triangle block renamed to Element2D6N");
  assert.ok(tet, "tet block renamed to Element3D10N");
  assert.equal(tri.stride, 6);
  assert.equal(tri.vtkCellType, VtkCellType.QUADRATIC_TRIANGLE);
  assert.equal(tet.stride, 10);
  assert.equal(tet.vtkCellType, VtkCellType.QUADRATIC_TETRA);
});

test("shares one mid node per mesh edge (no duplication)", () => {
  const m = parseMdpa(SRC);
  const { model, addedNodes } = linearToQuadratic(m);

  // Triangle edges: {1-2,2-3,1-3} ∪ {1-3,3-4,1-4} = 5 unique.
  // Tet edges: 6 unique. Total 11 new nodes.
  assert.equal(addedNodes, 11);
  assert.equal(model.nodeCount, m.nodeCount + 11);
});

test("reports the new mid-node ids (all beyond the original max id)", () => {
  const m = parseMdpa(SRC);
  const { model, addedNodes, addedNodeIds } = linearToQuadratic(m);
  assert.equal(addedNodeIds.length, addedNodes);
  const origMax = Math.max(...m.nodeIds);
  for (const id of addedNodeIds) assert.ok(id > origMax, `mid id ${id} should be fresh`);
  // Every reported mid id is actually present in the output model.
  const present = new Set<number>([...model.nodeIds]);
  for (const id of addedNodeIds) assert.ok(present.has(id));
});

test("every connectivity id resolves to a node", () => {
  const m = parseMdpa(SRC);
  const { model } = linearToQuadratic(m);
  const present = new Set<number>([...model.nodeIds]);
  for (const b of model.blocks) {
    for (const id of b.connectivity) {
      assert.ok(present.has(id), `connectivity node ${id} missing from nodeIds`);
    }
  }
});

test("mid nodes sit at the edge midpoints", () => {
  const m = parseMdpa(SRC);
  const { model } = linearToQuadratic(m);

  const coordOf = (id: number): [number, number, number] => {
    const i = [...model.nodeIds].indexOf(id);
    return [model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]];
  };

  // Triangle 1 = ids [1,2,3, m12, m23, m31]; corners first, mids in edge order.
  const tri = model.blocks.find((b) => b.name === "Element2D6N")!;
  const c = [...tri.connectivity.subarray(0, 6)];
  const m12 = coordOf(c[3]); // mid of edge (0,1) = nodes 1-2
  assert.deepEqual(m12, [0.5, 0.0, 0.0]);
});

test("interpolates nodal fields at new mid nodes", () => {
  const m = parseMdpa(SRC);
  const { model } = linearToQuadratic(m);

  const temp = model.fields.find((f) => f.variable === "TEMPERATURE")!;
  // Original 3 records + mids of edges whose BOTH endpoints carry the field:
  // 1-2→15, 2-3→35, 1-3→30. Edges touching node 4 are skipped (4 has no value).
  assert.equal(temp.ids.length, 6);
  assert.deepEqual(
    [...temp.values].sort((a, b) => a - b),
    [10, 15, 20, 30, 35, 50]
  );
});

test("adds mid nodes to SubModelParts enclosing both endpoints", () => {
  const m = parseMdpa(SRC);
  const { model } = linearToQuadratic(m);

  const surf = model.subModelParts.find((p) => p.name === "Surf")!;
  // Nodes 1,2,3 plus the 3 mids of its fully-enclosed edges 1-2,2-3,1-3.
  assert.equal(surf.nodeIds.length, 6);
  assert.ok([...surf.nodeIds].includes(1));
  assert.ok([...surf.nodeIds].includes(2));
  assert.ok([...surf.nodeIds].includes(3));
});

test("leaves already-quadratic blocks untouched", () => {
  const quad = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.5 0.0 0.0
5 1.0 0.5 0.0
6 0.5 0.5 0.0
End Nodes

Begin Elements Element2D6N
1 0 1 2 3 4 5 6
End Elements
`;
  const m = parseMdpa(quad);
  const { model, convertedCells, addedNodes, skippedBlocks } =
    linearToQuadratic(m);
  assert.equal(convertedCells, 0);
  assert.equal(addedNodes, 0);
  assert.equal(model.nodeCount, m.nodeCount);
  assert.ok(skippedBlocks.includes("Element2D6N"));
});

test("parse -> linearToQuadratic -> writeMdpa -> re-parse round-trips", () => {
  const m = parseMdpa(SRC);
  const { model } = linearToQuadratic(m);
  const round = parseMdpa(writeMdpa(model));

  assert.equal(round.nodeCount, model.nodeCount);

  const totalCells = (mm: typeof round) =>
    mm.blocks.reduce((n, b) => n + b.count, 0);
  assert.equal(totalCells(round), totalCells(model));

  const tri = round.blocks.find((b) => b.name === "Element2D6N")!;
  const tet = round.blocks.find((b) => b.name === "Element3D10N")!;
  assert.equal(tri.stride, 6);
  assert.equal(tet.stride, 10);

  // Connectivity closure survives the round-trip.
  const present = new Set<number>([...round.nodeIds]);
  for (const b of round.blocks) {
    for (const id of b.connectivity) assert.ok(present.has(id));
  }
});

test("does not mutate the input model", () => {
  const m = parseMdpa(SRC);
  const before = m.nodeCount;
  linearToQuadratic(m);
  assert.equal(m.nodeCount, before);
  assert.equal(m.blocks.find((b) => b.kind === "Elements")!.stride, 3);
});
