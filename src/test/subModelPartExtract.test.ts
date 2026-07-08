import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import {
  extractSubModelPart,
  findSubModelPart,
} from "../parser/subModelPartExtract";

// Two triangles + one quad. "Inlet" owns element 1 and has a nested child
// "Inlet/Ring" owning condition 1; "Outlet" owns element 2. A field per kind.
const SRC = `Begin Properties 1
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 2.0 0.0 0.0
6 2.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
End Elements

Begin Elements Element2D4N
2 1 3 4 5 6
End Elements

Begin Conditions Condition2D2N
1 1 2 3
End Conditions

Begin NodalData TEMPERATURE
1 0 100.0
2 0 200.0
5 0 500.0
End NodalData

Begin ElementalData ACTIVE
1 1.0
2 0.0
End ElementalData

Begin SubModelPart Inlet
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
  Begin SubModelPart Ring
    Begin SubModelPartNodes
    2
    3
    End SubModelPartNodes
    Begin SubModelPartConditions
    1
    End SubModelPartConditions
  End SubModelPart
End SubModelPart

Begin SubModelPart Outlet
  Begin SubModelPartElements
  2
  End SubModelPartElements
End SubModelPart
`;

test("findSubModelPart walks nested children by path", () => {
  const m = parseMdpa(SRC);
  assert.equal(findSubModelPart(m, "Inlet")?.name, "Inlet");
  assert.equal(findSubModelPart(m, "Inlet/Ring")?.name, "Ring");
  assert.equal(findSubModelPart(m, "Nope"), undefined);
});

test("extractSubModelPart slices the part's own entities", () => {
  const m = parseMdpa(SRC);
  const sub = extractSubModelPart(m, "Outlet")!;
  assert.ok(sub);

  // Only element 2 (the quad) survives.
  const cellIds = sub.blocks.flatMap((b) => [...b.entityIds]);
  assert.deepEqual(cellIds, [2]);
  assert.equal(sub.blocks.length, 1);
  assert.equal(sub.blocks[0].name, "Element2D4N");

  // Nodes are exactly the quad's connectivity (3,4,5,6), no others.
  assert.deepEqual([...sub.nodeIds].sort((a, b) => a - b), [3, 4, 5, 6]);
});

test("extractSubModelPart includes the whole descendant subtree", () => {
  const m = parseMdpa(SRC);
  const sub = extractSubModelPart(m, "Inlet")!;

  // Inlet's element 1 and its child Ring's condition 1 both come along.
  const elemBlock = sub.blocks.find((b) => b.kind === "Elements")!;
  const condBlock = sub.blocks.find((b) => b.kind === "Conditions")!;
  assert.deepEqual([...elemBlock.entityIds], [1]);
  assert.deepEqual([...condBlock.entityIds], [1]);

  // The nested SubModelPart structure is preserved and re-rooted.
  assert.equal(sub.subModelParts.length, 1);
  assert.equal(sub.subModelParts[0].path, "Inlet");
  assert.equal(sub.subModelParts[0].children[0].path, "Inlet/Ring");
});

test("extracted model has connectivity node-closure", () => {
  const m = parseMdpa(SRC);
  const sub = extractSubModelPart(m, "Inlet")!;
  const present = new Set<number>([...sub.nodeIds]);
  for (const b of sub.blocks) {
    for (const id of b.connectivity) {
      assert.ok(present.has(id), `connectivity node ${id} missing from nodeIds`);
    }
  }
});

test("extracted fields keep only in-slice records", () => {
  const m = parseMdpa(SRC);
  const sub = extractSubModelPart(m, "Outlet")!;

  // Nodal TEMPERATURE: only node 5 is in the Outlet slice (nodes 3,4,5,6).
  const temp = sub.fields.find((f) => f.variable === "TEMPERATURE")!;
  assert.deepEqual([...temp.ids], [5]);
  assert.deepEqual([...temp.values], [500]);

  // Elemental ACTIVE: only element 2.
  const active = sub.fields.find((f) => f.variable === "ACTIVE")!;
  assert.deepEqual([...active.ids], [2]);
  assert.deepEqual([...active.values], [0]);
});

test("parse -> extract -> writeMdpa -> re-parse round-trips the slice", () => {
  const m = parseMdpa(SRC);
  const sub = extractSubModelPart(m, "Inlet")!;
  const round = parseMdpa(writeMdpa(sub));

  assert.equal(round.nodeCount, sub.nodeCount);
  assert.deepEqual([...round.nodeIds].sort((a, b) => a - b), [1, 2, 3]);

  const totalCells = (mm: typeof round) =>
    mm.blocks.reduce((n, b) => n + b.count, 0);
  assert.equal(totalCells(round), totalCells(sub));

  // The re-rooted SubModelPart survives the round-trip.
  assert.ok(findSubModelPart(round, "Inlet"));
});

test("extractSubModelPart returns undefined for a missing path", () => {
  const m = parseMdpa(SRC);
  assert.equal(extractSubModelPart(m, "DoesNotExist"), undefined);
});
