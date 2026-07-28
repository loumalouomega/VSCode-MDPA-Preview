/**
 * mergeMesh.ts — appends a second mesh with id offsetting, optional welding.
 * Pure, no wasm.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mergeModels } from "../parser/mergeMesh";
import { parseMdpa } from "../parser/mdpaParser";

const TRI_A = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin NodalData T
1 10.0
2 20.0
3 30.0
End NodalData
`;

const TRI_B = `Begin Properties 0
End Properties

Begin Nodes
1 5.0 5.0 0.0
2 6.0 5.0 0.0
3 5.0 6.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin NodalData T
1 100.0
2 200.0
3 300.0
End NodalData
`;

test("merge offsets the second mesh's ids past the first's", () => {
  const a = parseMdpa(TRI_A);
  const b = parseMdpa(TRI_B);
  const r = mergeModels(a, b);
  assert.equal(r.model.nodeCount, 6);
  assert.deepEqual(Array.from(r.model.nodeIds), [1, 2, 3, 4, 5, 6]);
  assert.equal(r.model.blocks.reduce((n, blk) => n + blk.count, 0), 2);
  assert.deepEqual(Array.from(r.model.blocks[1].entityIds), [2]);
  assert.deepEqual(Array.from(r.model.blocks[1].connectivity), [4, 5, 6]);
});

test("merge preserves both meshes' geometry exactly (no welding by default)", () => {
  const a = parseMdpa(TRI_A);
  const b = parseMdpa(TRI_B);
  const r = mergeModels(a, b);
  assert.equal(r.welded, 0);
  assert.equal(r.addedNodes, 3);
  // B's first node (5,5,0) must be present under its offset id (4).
  assert.deepEqual(
    [r.model.coords[3 * 3], r.model.coords[3 * 3 + 1], r.model.coords[3 * 3 + 2]],
    [5, 5, 0]
  );
});

test("merge adds a SubModelPart wrapping the merged-in geometry", () => {
  const a = parseMdpa(TRI_A);
  const b = parseMdpa(TRI_B);
  const r = mergeModels(a, b, { name: "Imported" });
  const part = r.model.subModelParts.find((p) => p.path === "Imported")!;
  assert.ok(part);
  assert.deepEqual(Array.from(part.nodeIds), [4, 5, 6]);
  assert.deepEqual(Array.from(part.elementIds), [2]);
});

test("same-named Nodal fields on both sides concatenate", () => {
  const a = parseMdpa(TRI_A);
  const b = parseMdpa(TRI_B);
  const r = mergeModels(a, b);
  const t = r.model.fields.find((f) => f.variable === "T")!;
  assert.equal(t.ids.length, 6);
  assert.deepEqual(Array.from(t.values), [10, 20, 30, 100, 200, 300]);
});

test("weld: true fuses coincident nodes across the seam", () => {
  const a = parseMdpa(TRI_A);
  // B shares node (1,0,0) with A's node 2 — same triangle corner, offset mesh.
  const bSrc = TRI_A.replace("0.0 0.0 0.0", "9.0 9.0 9.0"); // move B's node1 away
  const b = parseMdpa(bSrc);
  // Force an exact coincidence: B's node 2 (1,0,0) matches A's node 2 (1,0,0).
  const r = mergeModels(a, b, { weld: true, tolerance: 1e-6 });
  assert.ok(r.welded >= 1, "at least the coincident corner should weld");
  assert.equal(r.model.nodeCount, 6 - r.welded);
});

test("merging into an empty base just adopts the second mesh", () => {
  const empty = parseMdpa(`Begin Properties 0
End Properties

Begin Nodes
End Nodes
`);
  const b = parseMdpa(TRI_B);
  const r = mergeModels(empty, b);
  assert.equal(r.model.nodeCount, 3);
  assert.deepEqual(Array.from(r.model.nodeIds), [1, 2, 3]);
});

test("merging an empty mesh in is a noop", () => {
  const a = parseMdpa(TRI_A);
  const empty = parseMdpa(`Begin Properties 0
End Properties

Begin Nodes
End Nodes
`);
  const r = mergeModels(a, empty);
  assert.equal(r.model, a);
  assert.equal(r.addedNodes, 0);
});

test("never mutates either input model", () => {
  const a = parseMdpa(TRI_A);
  const b = parseMdpa(TRI_B);
  const snapA = a.nodeIds.slice();
  const snapB = b.nodeIds.slice();
  mergeModels(a, b);
  assert.deepEqual(a.nodeIds, snapA);
  assert.deepEqual(b.nodeIds, snapB);
});
