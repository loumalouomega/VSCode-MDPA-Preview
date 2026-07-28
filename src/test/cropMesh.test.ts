/**
 * cropMesh.ts — bbox / plane cropping. Pure, no wasm.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { cropModel } from "../parser/cropMesh";
import { parseMdpa } from "../parser/mdpaParser";

// A 1x3 row of unit triangles-worth of squares along x: 4x2 node grid,
// 3 quad elements at x in [0,1], [1,2], [2,3]. Node 1..8, elements 1..3.
const SRC = `Begin Properties 9
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 2.0 0.0 0.0
4 3.0 0.0 0.0
5 0.0 1.0 0.0
6 1.0 1.0 0.0
7 2.0 1.0 0.0
8 3.0 1.0 0.0
End Nodes

Begin Elements Element2D4N
1 9 1 2 6 5
2 9 2 3 7 6
3 9 3 4 8 7
End Elements

Begin ElementalData MAT
1 42.0
2 43.0
3 44.0
End ElementalData

Begin SubModelPart Left
  Begin SubModelPartNodes
  1
  5
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`;

test("cropBbox 'all' keeps only the fully-contained element", () => {
  const model = parseMdpa(SRC);
  const r = cropModel(model, {
    kind: "bbox",
    lo: [0.9, -1, -1],
    hi: [2.1, 2, 1],
    mode: "all",
  });
  // Only element 2 (nodes 2,3,7,6, all with x in [1,2]) is fully inside.
  assert.equal(r.keptCells, 1);
  assert.equal(r.droppedCells, 2);
  assert.equal(r.model.blocks[0].count, 1);
  assert.deepEqual(Array.from(r.model.blocks[0].entityIds), [2]);
});

test("cropBbox 'any' keeps every element touching the box", () => {
  const model = parseMdpa(SRC);
  const r = cropModel(model, {
    kind: "bbox",
    lo: [0.9, -1, -1],
    hi: [1.1, 2, 1],
    mode: "any",
  });
  // Elements 1 (has node 2) and 2 (has nodes 2,6) touch x=1; element 3 does not.
  assert.deepEqual(Array.from(r.model.blocks[0].entityIds).sort(), [1, 2]);
});

test("cropPlane keeps the half-space where (p - point).normal >= 0", () => {
  const model = parseMdpa(SRC);
  // Keep x >= 1.5: only element 3 (x in [2,3]) is fully past the plane.
  const r = cropModel(model, {
    kind: "plane",
    point: [1.5, 0, 0],
    normal: [1, 0, 0],
    mode: "all",
  });
  assert.deepEqual(Array.from(r.model.blocks[0].entityIds), [3]);
});

test("crop preserves propertyIds and Elemental fields on survivors", () => {
  const model = parseMdpa(SRC);
  const r = cropModel(model, { kind: "bbox", lo: [1.9, -1, -1], hi: [3.1, 2, 1], mode: "all" });
  assert.deepEqual(Array.from(r.model.blocks[0].propertyIds!), [9]);
  const mat = r.model.fields.find((f) => f.variable === "MAT")!;
  assert.deepEqual(Array.from(mat.ids), [3]);
  assert.deepEqual(Array.from(mat.values), [44]);
});

test("crop drops orphaned nodes and narrows SubModelPart membership", () => {
  const model = parseMdpa(SRC);
  // Keep only x >= 1.9: element 1 and its exclusive nodes (1, 5) are gone.
  const r = cropModel(model, { kind: "bbox", lo: [1.9, -1, -1], hi: [3.1, 2, 1], mode: "all" });
  assert.ok(r.removedNodes > 0);
  assert.ok(!Array.from(r.model.nodeIds).includes(1));

  const left = r.model.subModelParts.find((p) => p.path === "Left");
  assert.ok(left);
  assert.deepEqual(Array.from(left.nodeIds), []);
  assert.deepEqual(Array.from(left.elementIds), []);
});

test("nothing dropped is a noop returning the same model", () => {
  const model = parseMdpa(SRC);
  const r = cropModel(model, { kind: "bbox", lo: [-9, -9, -9], hi: [9, 9, 9] });
  assert.equal(r.model, model);
  assert.equal(r.droppedCells, 0);
});

test("a box/plane that keeps nothing is a loud error, not an empty mesh", () => {
  const model = parseMdpa(SRC);
  assert.throws(
    () => cropModel(model, { kind: "bbox", lo: [100, 100, 100], hi: [200, 200, 200] }),
    /no cells survive/
  );
});

test("a zero-length crop plane normal is rejected", () => {
  const model = parseMdpa(SRC);
  assert.throws(
    () => cropModel(model, { kind: "plane", point: [0, 0, 0], normal: [0, 0, 0] }),
    /normal/
  );
});

test("never mutates the input model", () => {
  const model = parseMdpa(SRC);
  const snapshot = model.blocks[0].entityIds.slice();
  cropModel(model, { kind: "bbox", lo: [0.9, -1, -1], hi: [2.1, 2, 1], mode: "all" });
  assert.deepEqual(model.blocks[0].entityIds, snapshot);
});
