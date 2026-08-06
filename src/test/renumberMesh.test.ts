/**
 * renumberMesh.ts — compacts ids into a gapless run, per-kind. Pure, no wasm.
 *
 * The invariant every test here guards is that renumbering is a pure
 * RELABELLING: the same geometry, the same membership, the same field values,
 * reachable under different ids. Anything that changes coordinates, drops a
 * cell or loses a field record is a bug, not a renumbering.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { renumberModel } from "../parser/renumberMesh";
import { parseMdpa } from "../parser/mdpaParser";
import { writeMeshFile } from "../parser/writers/meshWriter";
import { MdpaModel } from "../parser/types";

/** Gappy ids throughout: nodes 5/11/40/41, element 7, conditions 3 and 9. */
const GAPPY = `Begin Properties 0
End Properties

Begin Nodes
5  0.0 0.0 0.0
11 1.0 0.0 0.0
40 0.0 1.0 0.0
41 1.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
7 0 5 11 40
End Elements

Begin Conditions LineCondition2D2N
3 0 5 11
9 0 11 40
End Conditions

Begin NodalData TEMPERATURE
5  10.0
11 20.0
40 30.0
End NodalData

Begin ElementalData DENSITY
7 2.5
End ElementalData

Begin SubModelPart Inlet
  Begin SubModelPartNodes
  5
  11
  End SubModelPartNodes
  Begin SubModelPartConditions
  3
  End SubModelPartConditions
  Begin SubModelPart Deep
    Begin SubModelPartNodes
    11
    End SubModelPartNodes
    Begin SubModelPartElements
    7
    End SubModelPartElements
  End SubModelPart
End SubModelPart
`;

const gappy = (): MdpaModel => parseMdpa(GAPPY);

/** Coordinates of a node id, for "same geometry under a new label" checks. */
function coordOf(model: MdpaModel, id: number): [number, number, number] {
  const i = Array.from(model.nodeIds).indexOf(id);
  assert.ok(i >= 0, `node ${id} not found`);
  return [model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]];
}

function block(model: MdpaModel, kind: string) {
  return model.blocks.find((b) => b.kind === kind)!;
}

function part(model: MdpaModel, path: string) {
  const walk = (ps: typeof model.subModelParts): (typeof model.subModelParts)[0] | undefined => {
    for (const p of ps) {
      if (p.path === path) return p;
      const hit = walk(p.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(model.subModelParts)!;
}

test("node ids compact to a gapless run and connectivity follows", () => {
  const r = renumberModel(gappy());
  assert.deepEqual(Array.from(r.model.nodeIds), [1, 2, 3, 4]);
  assert.equal(r.nodesRenumbered, 4);
  // Element 7 was (5, 11, 40) — now (1, 2, 3), the same three corners.
  assert.deepEqual(Array.from(block(r.model, "Elements").connectivity), [1, 2, 3]);
  assert.deepEqual(coordOf(r.model, 1), [0, 0, 0]);
  assert.deepEqual(coordOf(r.model, 2), [1, 0, 0]);
  assert.deepEqual(coordOf(r.model, 3), [0, 1, 0]);
});

test("coordinates are untouched — this relabels, it does not reorder", () => {
  const before = gappy();
  const r = renumberModel(before);
  assert.deepEqual(Array.from(r.model.coords), Array.from(before.coords));
  assert.equal(r.model.nodeCount, before.nodeCount);
});

test("each entity kind gets its OWN 1..N run", () => {
  const r = renumberModel(gappy());
  assert.deepEqual(Array.from(block(r.model, "Elements").entityIds), [1]);
  assert.deepEqual(Array.from(block(r.model, "Conditions").entityIds), [1, 2]);
  // Element 1 and Condition 1 coexisting is exactly what Kratos writes.
  assert.equal(r.entitiesRenumbered.Elements, 1);
  assert.equal(r.entitiesRenumbered.Conditions, 2);
  assert.equal(r.entitiesRenumbered.Geometries, 0);
});

test("SubModelPart lists follow, including a nested child", () => {
  const r = renumberModel(gappy());
  const inlet = part(r.model, "Inlet");
  assert.deepEqual(Array.from(inlet.nodeIds), [1, 2]);
  assert.deepEqual(Array.from(inlet.conditionIds), [1]);
  const deep = part(r.model, "Inlet/Deep");
  assert.deepEqual(Array.from(deep.nodeIds), [2]);
  assert.deepEqual(Array.from(deep.elementIds), [1]);
});

test("Nodal and Elemental field ids follow, values stay with their record", () => {
  const r = renumberModel(gappy());
  const t = r.model.fields.find((f) => f.variable === "TEMPERATURE")!;
  assert.deepEqual(Array.from(t.ids), [1, 2, 3]);
  assert.deepEqual(Array.from(t.values), [10, 20, 30]);
  const d = r.model.fields.find((f) => f.variable === "DENSITY")!;
  assert.equal(d.kind, "Elemental");
  assert.deepEqual(Array.from(d.ids), [1]);
  assert.deepEqual(Array.from(d.values), [2.5]);
});

test("a fixed flag stays index-aligned with its record", () => {
  const src = `Begin Properties 0
End Properties

Begin Nodes
5 0.0 0.0 0.0
9 1.0 0.0 0.0
End Nodes

Begin NodalData DISPLACEMENT_X
5 1 1.5
9 0 2.5
End NodalData
`;
  const r = renumberModel(parseMdpa(src));
  const f = r.model.fields.find((v) => v.variable === "DISPLACEMENT_X")!;
  assert.deepEqual(Array.from(f.ids), [1, 2]);
  assert.deepEqual(Array.from(f.values), [1.5, 2.5]);
  assert.ok(f.fixed, "the fixity flags survive");
  assert.equal(f.fixed!.length, f.ids.length);
  assert.deepEqual(Array.from(f.fixed!), [1, 0]);
});

test('target "nodes" leaves entity ids alone', () => {
  const r = renumberModel(gappy(), { target: "nodes" });
  assert.deepEqual(Array.from(r.model.nodeIds), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(block(r.model, "Elements").entityIds), [7]);
  assert.deepEqual(Array.from(block(r.model, "Conditions").entityIds), [3, 9]);
  assert.equal(r.entitiesRenumbered.Elements, 0);
});

test('target "entities" leaves node ids alone', () => {
  const r = renumberModel(gappy(), { target: "entities" });
  assert.deepEqual(Array.from(r.model.nodeIds), [5, 11, 40, 41]);
  assert.deepEqual(Array.from(block(r.model, "Elements").connectivity), [5, 11, 40]);
  assert.deepEqual(Array.from(block(r.model, "Elements").entityIds), [1]);
  assert.equal(r.nodesRenumbered, 0);
});

test("start offsets every run", () => {
  const r = renumberModel(gappy(), { start: 100 });
  assert.deepEqual(Array.from(r.model.nodeIds), [100, 101, 102, 103]);
  assert.deepEqual(Array.from(block(r.model, "Elements").entityIds), [100]);
  assert.deepEqual(Array.from(block(r.model, "Conditions").entityIds), [100, 101]);
  assert.deepEqual(Array.from(block(r.model, "Elements").connectivity), [100, 101, 102]);
});

test("an already-compact mesh is a noop and hands back the same model", () => {
  const compact = parseMdpa(`Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements
`);
  const r = renumberModel(compact);
  assert.equal(r.model, compact, "same reference — nothing was rebuilt");
  assert.equal(r.nodesRenumbered, 0);
  assert.equal(r.entitiesRenumbered.Elements, 0);
});

test("spans report the gap that was closed", () => {
  const r = renumberModel(gappy());
  assert.deepEqual(r.spans.nodes, [41, 4]);
  assert.deepEqual(r.spans.Conditions, [9, 2]);
});

test("constraint ids are left untouched and reported", () => {
  const src = GAPPY.replace(
    "  End SubModelPartConditions",
    `  End SubModelPartConditions
  Begin SubModelPartConstraints
  4
  8
  End SubModelPartConstraints`
  );
  const before = parseMdpa(src);
  const kept = Array.from(part(before, "Inlet").constraintIds);
  assert.deepEqual(kept, [4, 8], "fixture actually carries constraints");
  const r = renumberModel(before);
  assert.deepEqual(Array.from(part(r.model, "Inlet").constraintIds), kept);
  assert.equal(r.constraintIdsLeft, 2);
  assert.ok(
    r.diagnostics.some((d) => /constraint id/i.test(d.message)),
    "the reason they were left is reported, not silent"
  );
});

test("a dangling reference is zeroed in connectivity and counted", () => {
  // Element references node 99, which no Begin Nodes line declares.
  const src = `Begin Properties 0
End Properties

Begin Nodes
5 0.0 0.0 0.0
11 1.0 0.0 0.0
End Nodes

Begin Elements Element2D3N
7 0 5 11 99
End Elements
`;
  const r = renumberModel(parseMdpa(src));
  assert.deepEqual(Array.from(block(r.model, "Elements").connectivity), [1, 2, 0]);
  assert.equal(r.danglingRefs, 1);
  assert.ok(r.diagnostics.some((d) => /no node or entity carries/i.test(d.message)));
});

test("a dangling SubModelPart entry is dropped rather than aliased", () => {
  const src = `Begin Properties 0
End Properties

Begin Nodes
5 0.0 0.0 0.0
11 1.0 0.0 0.0
End Nodes

Begin Elements Element2D3N
7 0 5 11 5
End Elements

Begin SubModelPart Ghosts
  Begin SubModelPartNodes
  5
  777
  End SubModelPartNodes
End SubModelPart
`;
  const r = renumberModel(parseMdpa(src));
  assert.deepEqual(Array.from(part(r.model, "Ghosts").nodeIds), [1]);
  assert.equal(r.danglingRefs, 1);
});

test("derived data is cleared — its records are keyed by the old ids", () => {
  const m = gappy();
  m.derived = { nodalH: { kind: "Nodal", variable: "NODAL_H", components: 1, ids: Int32Array.from([5]), values: Float64Array.from([1]) } };
  const r = renumberModel(m);
  assert.equal(r.model.derived, undefined);
});

test("never mutates the input model", () => {
  const m = gappy();
  const nodeSnap = m.nodeIds.slice();
  const connSnap = block(m, "Elements").connectivity.slice();
  const partSnap = Array.from(part(m, "Inlet").nodeIds);
  renumberModel(m);
  assert.deepEqual(m.nodeIds, nodeSnap);
  assert.deepEqual(block(m, "Elements").connectivity, connSnap);
  assert.deepEqual(Array.from(part(m, "Inlet").nodeIds), partSnap);
});

test("round-trips through the mdpa writer unchanged", () => {
  const r = renumberModel(gappy());
  const reparsed = parseMdpa(writeMeshFile(r.model, ".mdpa"));
  assert.deepEqual(Array.from(reparsed.nodeIds), Array.from(r.model.nodeIds));
  assert.deepEqual(
    Array.from(block(reparsed, "Elements").connectivity),
    Array.from(block(r.model, "Elements").connectivity)
  );
  assert.deepEqual(Array.from(block(reparsed, "Conditions").entityIds), [1, 2]);
  assert.deepEqual(Array.from(part(reparsed, "Inlet").nodeIds), [1, 2]);
  assert.deepEqual(Array.from(part(reparsed, "Inlet/Deep").elementIds), [1]);
});
