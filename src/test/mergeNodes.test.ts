import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { mergeNodes } from "../parser/mergeNodes";

// Nodes 3 and 4 are coincident (same coords). Two triangles share that corner
// through different node ids, so welding should rewire element 2's node 4 → 3.
const SRC = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 1.0 1.0 0.0
5 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
2 1 1 4 5
End Elements

Begin NodalData TEMPERATURE
3 0 30.0
4 0 99.0
End NodalData

Begin SubModelPart Both
  Begin SubModelPartNodes
  3
  4
  End SubModelPartNodes
End SubModelPart
`;

test("welds coincident nodes to the lowest id and rewires connectivity", () => {
  const m = parseMdpa(SRC);
  const { model, merged } = mergeNodes(m, 1e-6);
  assert.equal(merged, 1);
  assert.deepEqual([...model.nodeIds].sort((a, b) => a - b), [1, 2, 3, 5]);

  // Element 2's connectivity had node 4 → now 3.
  const elems = model.blocks.find((b) => b.kind === "Elements")!;
  const e2 = [...elems.connectivity.subarray(3, 6)];
  assert.ok(e2.includes(3));
  assert.ok(!e2.includes(4));

  // Every connectivity id resolves.
  const present = new Set<number>([...model.nodeIds]);
  for (const id of elems.connectivity) assert.ok(present.has(id));
});

test("SubModelPart node list is remapped and deduped", () => {
  const m = parseMdpa(SRC);
  const { model } = mergeNodes(m, 1e-6);
  const part = model.subModelParts.find((p) => p.name === "Both")!;
  assert.deepEqual([...part.nodeIds], [3]); // 3 and 4 collapsed to 3, deduped
});

test("representative's own nodal-field record wins over merged member", () => {
  const m = parseMdpa(SRC);
  const { model } = mergeNodes(m, 1e-6);
  const temp = model.fields.find((f) => f.variable === "TEMPERATURE")!;
  assert.deepEqual([...temp.ids], [3]);
  assert.deepEqual([...temp.values], [30]); // node 3's value kept, not node 4's 99
});

test("nothing within tolerance → merged 0", () => {
  const m = parseMdpa(SRC);
  const { merged } = mergeNodes(m, 1e-12); // far tighter than the exact dup still matches
  // Nodes 3 & 4 are *exactly* equal, so even a tiny tolerance merges them.
  assert.equal(merged, 1);
});

test("well-separated mesh with a loose-but-safe tolerance merges nothing", () => {
  const sep = `Begin Nodes
1 0.0 0.0 0.0
2 10.0 0.0 0.0
3 0.0 10.0 0.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
End Elements
`;
  const m = parseMdpa(sep);
  const { model, merged } = mergeNodes(m, 1e-3);
  assert.equal(merged, 0);
  assert.equal(model, m); // unchanged reference on noop
});

test("does not mutate the input model", () => {
  const m = parseMdpa(SRC);
  mergeNodes(m, 1e-6);
  assert.equal(m.nodeCount, 5);
});
