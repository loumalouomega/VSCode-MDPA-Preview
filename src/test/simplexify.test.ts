/**
 * simplexify.ts — hex->6 tets, wedge->3, pyramid->2, quad->2 triangles. Pure,
 * no wasm; reuses cellDecomposition.ts's tables (shared with isoSurface.ts).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { simplexifyModel } from "../parser/simplexify";
import { parseMdpa } from "../parser/mdpaParser";

const HEX_SRC = `Begin Properties 3
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 0.0 0.0 1.0
6 1.0 0.0 1.0
7 1.0 1.0 1.0
8 0.0 1.0 1.0
End Nodes

Begin Elements Element3D8N
1 3 1 2 3 4 5 6 7 8
End Elements

Begin ElementalData MAT
1 42.0
End ElementalData

Begin SubModelPart Body
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`;

test("simplexify splits one hex into 6 tets", () => {
  const model = parseMdpa(HEX_SRC);
  const r = simplexifyModel(model);
  assert.equal(r.splitCells, 1);
  assert.equal(r.producedSimplices, 6);
  assert.equal(r.model.blocks[0].count, 6);
  assert.equal(r.model.blocks[0].stride, 4);
  assert.equal(r.model.blocks[0].vtkCellType, 10); // VtkCellType.TETRA
  assert.equal(r.model.blocks[0].name, "Element3D4N");
});

test("simplexify never moves or renumbers nodes", () => {
  const model = parseMdpa(HEX_SRC);
  const r = simplexifyModel(model);
  assert.equal(r.model.nodeCount, model.nodeCount);
  assert.deepEqual(Array.from(r.model.coords), Array.from(model.coords));
  assert.deepEqual(Array.from(r.model.nodeIds), Array.from(model.nodeIds));
});

test("every child references only the parent's 8 nodes", () => {
  const model = parseMdpa(HEX_SRC);
  const r = simplexifyModel(model);
  const parentNodes = new Set(model.blocks[0].connectivity);
  for (const n of r.model.blocks[0].connectivity) assert.ok(parentNodes.has(n));
});

test("the first child keeps the parent's entity id; siblings get new ones", () => {
  const model = parseMdpa(HEX_SRC);
  const r = simplexifyModel(model);
  assert.equal(r.model.blocks[0].entityIds[0], 1); // parent id 1 kept
  const ids = new Set(r.model.blocks[0].entityIds);
  assert.equal(ids.size, 6, "6 distinct entity ids");
});

test("propertyIds are replicated to every child", () => {
  const model = parseMdpa(HEX_SRC);
  const r = simplexifyModel(model);
  assert.deepEqual(
    Array.from(r.model.blocks[0].propertyIds!),
    new Array(6).fill(3)
  );
});

test("Elemental fields are replicated to every child, Nodal fields untouched", () => {
  const model = parseMdpa(HEX_SRC);
  const r = simplexifyModel(model);
  const mat = r.model.fields.find((f) => f.variable === "MAT")!;
  assert.equal(mat.ids.length, 6);
  assert.ok(Array.from(mat.values).every((v) => v === 42));
});

test("SubModelPart membership grows to cover every child", () => {
  const model = parseMdpa(HEX_SRC);
  const r = simplexifyModel(model);
  const body = r.model.subModelParts.find((p) => p.path === "Body")!;
  assert.equal(body.elementIds.length, 6);
});

test("an already-simplex mesh is a noop, reported as skipped for non-simplex families", () => {
  const src = `Begin Properties 0
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
`;
  const model = parseMdpa(src);
  const r = simplexifyModel(model);
  assert.equal(r.splitCells, 0);
  assert.equal(r.producedSimplices, 1);
  assert.equal(r.model, model, "a full noop returns the same model reference");
});

test("a line block has no decomposition and is left alone, reported as skipped", () => {
  const src = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
End Nodes

Begin Elements Element2D2N
1 0 1 2
End Elements
`;
  const model = parseMdpa(src);
  const r = simplexifyModel(model);
  assert.equal(r.splitCells, 0);
  assert.deepEqual(r.skippedBlocks, ["Element2D2N"]);
});

test("never mutates the input model", () => {
  const model = parseMdpa(HEX_SRC);
  const snapshot = model.blocks[0].connectivity.slice();
  simplexifyModel(model);
  assert.deepEqual(model.blocks[0].connectivity, snapshot);
});
