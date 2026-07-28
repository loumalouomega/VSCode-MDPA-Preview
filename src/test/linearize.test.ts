/**
 * linearize.ts — the inverse of linearToQuadratic.ts. Pure, no wasm.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { linearToQuadratic } from "../parser/linearToQuadratic";
import { linearize } from "../parser/linearize";
import { parseMdpa } from "../parser/mdpaParser";

const TET_SRC = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

Begin NodalData TEMP
1 0 10.0
2 0 20.0
3 0 30.0
4 0 40.0
End NodalData

Begin SubModelPart Inlet
  Begin SubModelPartNodes
  1
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`;
// Deliberately only ONE node in Inlet: linearToQuadratic extends a part's node
// list with a mid-edge node when BOTH of its endpoints are already in the
// part, so listing two adjacent corners here would leave a mid node in the
// SubModelPart after linearize (correctly — it is real membership, not an
// orphan) and break the "clean round-trip" tests below for an unrelated reason.

test("linearize narrows a quadratic tetra back to its 4 corners", () => {
  const linear = parseMdpa(TET_SRC);
  const quad = linearToQuadratic(linear).model;
  assert.equal(quad.blocks[0].stride, 10); // Tetrahedra3D10

  const r = linearize(quad);
  assert.equal(r.convertedCells, 1);
  assert.equal(r.model.blocks[0].stride, 4);
  assert.equal(r.model.blocks[0].vtkCellType, linear.blocks[0].vtkCellType);
  assert.deepEqual(
    Array.from(r.model.blocks[0].connectivity),
    Array.from(linear.blocks[0].connectivity)
  );
  assert.equal(r.model.blocks[0].name, "Element3D4N");
});

test("linearize removes the now-orphaned mid-edge nodes", () => {
  const quad = linearToQuadratic(parseMdpa(TET_SRC)).model;
  assert.equal(quad.nodeCount, 4 + 6); // a tetra has 6 edges
  const r = linearize(quad);
  assert.equal(r.removedNodes, 6);
  assert.equal(r.model.nodeCount, 4);
});

test("linearize preserves corner-node fields and SubModelPart membership", () => {
  const quad = linearToQuadratic(parseMdpa(TET_SRC)).model;
  const r = linearize(quad);
  const temp = r.model.fields.find((f) => f.variable === "TEMP")!;
  assert.deepEqual(Array.from(temp.ids), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(temp.values), [10, 20, 30, 40]);

  const inlet = r.model.subModelParts.find((p) => p.path === "Inlet")!;
  assert.deepEqual(Array.from(inlet.nodeIds), [1]);
  assert.deepEqual(Array.from(inlet.elementIds), [1]);
});

test("linearize preserves propertyIds", () => {
  const src = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 5 1 2 3
End Elements
`;
  const quad = linearToQuadratic(parseMdpa(src)).model;
  const r = linearize(quad);
  assert.deepEqual(Array.from(r.model.blocks[0].propertyIds!), [5]);
});

test("an already-linear mesh is a noop, reported as skipped", () => {
  const model = parseMdpa(TET_SRC);
  const r = linearize(model);
  assert.equal(r.convertedCells, 0);
  assert.equal(r.removedNodes, 0);
  assert.deepEqual(r.skippedBlocks, ["Element3D4N"]);
  assert.equal(r.model.nodeCount, model.nodeCount);
});

test("linearize -> linearToQuadratic round-trips the geometry", () => {
  const original = parseMdpa(TET_SRC);
  const quad = linearToQuadratic(original).model;
  const back = linearize(quad).model;
  assert.deepEqual(Array.from(back.coords), Array.from(original.coords));
  assert.deepEqual(
    Array.from(back.blocks[0].connectivity),
    Array.from(original.blocks[0].connectivity)
  );
});

test("linearize never mutates its input", () => {
  const quad = linearToQuadratic(parseMdpa(TET_SRC)).model;
  const snapshot = quad.blocks[0].connectivity.slice();
  linearize(quad);
  assert.deepEqual(quad.blocks[0].connectivity, snapshot);
});
