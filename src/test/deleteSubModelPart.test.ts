import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { deleteSubModelPart } from "../parser/deleteSubModelPart";

// Two triangles. "Inlet" owns element 1 (nodes 1,2,3); element 2 (nodes 3,4,5)
// keeps nodes 3,4,5 alive. Node 6 is only used by element 1 (via... actually
// element 1 = 1,2,3). Deleting Inlet removes element 1 and orphan nodes 1,2.
const SRC = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 2.0 0.0 0.0
5 2.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
2 1 3 4 5
End Elements

Begin ElementalData ACTIVE
1 1.0
2 0.0
End ElementalData

Begin SubModelPart Inlet
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart

Begin SubModelPart Outlet
  Begin SubModelPartElements
  2
  End SubModelPartElements
End SubModelPart
`;

test("removes the part's elements and orphaned nodes", () => {
  const m = parseMdpa(SRC);
  const { model, deleted } = deleteSubModelPart(m, "Inlet");
  assert.equal(deleted, true);

  const elems = model.blocks.find((b) => b.kind === "Elements")!;
  assert.deepEqual([...elems.entityIds], [2]); // element 1 gone

  // Nodes 1,2 were only used by element 1 → removed; 3,4,5 stay (element 2).
  assert.deepEqual([...model.nodeIds].sort((a, b) => a - b), [3, 4, 5]);
});

test("drops the part from the tree and its elemental field records", () => {
  const m = parseMdpa(SRC);
  const { model } = deleteSubModelPart(m, "Inlet");
  assert.equal(model.subModelParts.find((p) => p.name === "Inlet"), undefined);
  assert.ok(model.subModelParts.find((p) => p.name === "Outlet"));

  const active = model.fields.find((f) => f.variable === "ACTIVE")!;
  assert.deepEqual([...active.ids], [2]); // element 1's record dropped
});

test("connectivity closure holds after deletion", () => {
  const m = parseMdpa(SRC);
  const { model } = deleteSubModelPart(m, "Inlet");
  const present = new Set<number>([...model.nodeIds]);
  for (const b of model.blocks) {
    for (const id of b.connectivity) assert.ok(present.has(id));
  }
});

test("missing path → deleted false, model unchanged", () => {
  const m = parseMdpa(SRC);
  const { model, deleted } = deleteSubModelPart(m, "Nope");
  assert.equal(deleted, false);
  assert.equal(model, m);
});

test("does not mutate the input model", () => {
  const m = parseMdpa(SRC);
  deleteSubModelPart(m, "Inlet");
  assert.equal(m.nodeCount, 5);
  assert.equal(m.blocks[0].count, 2);
});
