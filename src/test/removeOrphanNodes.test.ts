import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { removeOrphanNodes } from "../parser/removeOrphanNodes";

// Nodes 1-5; node 4 is used by no cell, node 5 is used by no cell but IS listed
// in SubModelPart "Keep". So only node 4 is a true orphan.
const SRC = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 5.0 5.0 5.0
5 9.0 9.0 9.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
End Elements

Begin NodalData TEMPERATURE
1 0 10.0
4 0 40.0
End NodalData

Begin SubModelPart Keep
  Begin SubModelPartNodes
  5
  End SubModelPartNodes
End SubModelPart
`;

test("removes only nodes referenced by no cell and no SubModelPart", () => {
  const m = parseMdpa(SRC);
  const { model, removed } = removeOrphanNodes(m);
  assert.equal(removed, 1);
  assert.deepEqual([...model.nodeIds].sort((a, b) => a - b), [1, 2, 3, 5]);
  assert.equal(model.nodeCount, 4);
});

test("drops nodal-field records of removed nodes only", () => {
  const m = parseMdpa(SRC);
  const { model } = removeOrphanNodes(m);
  const temp = model.fields.find((f) => f.variable === "TEMPERATURE")!;
  assert.deepEqual([...temp.ids], [1]); // node 4's record dropped, node 1 kept
  assert.deepEqual([...temp.values], [10]);
});

test("connectivity still resolves and bounds recomputed", () => {
  const m = parseMdpa(SRC);
  const { model } = removeOrphanNodes(m);
  const present = new Set<number>([...model.nodeIds]);
  for (const b of model.blocks) {
    for (const id of b.connectivity) assert.ok(present.has(id));
  }
  // Node 4 (5,5,5) is gone but node 5 (9,9,9) remains → max stays 9.
  assert.deepEqual(model.bounds.max, [9, 9, 9]);
});

test("no orphans → removed 0, model returned unchanged", () => {
  const clean = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
End Elements
`;
  const m = parseMdpa(clean);
  const { removed } = removeOrphanNodes(m);
  assert.equal(removed, 0);
});

test("does not mutate the input model", () => {
  const m = parseMdpa(SRC);
  removeOrphanNodes(m);
  assert.equal(m.nodeCount, 5);
});
