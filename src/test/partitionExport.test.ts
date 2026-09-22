/**
 * Partition export and component splitting. The invariants a distributed setup
 * leans on: every cell is OWNED by exactly one part, ghosts are distinguishable
 * from owned cells and never owned by the part holding them, every exported
 * part is a consistent Kratos mesh that keeps the source's ids, and a split
 * accounts for every element exactly once.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { partitionParts, partitionManifest, PARTITION_GHOST_VARIABLE, PARTITION_OWNER_VARIABLE, GHOST_PART } from "../parser/partitionExport";
import { connectedComponents, splitModel, markComponentsModel, COMPONENT_VARIABLE } from "../parser/splitComponents";
import { applyOp, opRecordFromMessage, parseOpsJson, serializeOps, isAsyncOp } from "../parser/operations";
import { parseMdpa } from "../parser/mdpaParser";
import { MdpaModel } from "../parser/types";
import { tetBar } from "./fixtures/shapes";

const model = (t: string): MdpaModel => {
  const r = parseMdpa(t) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};
const elementIds = (m: MdpaModel): number[] => m.blocks.filter((b) => b.kind === "Elements").flatMap((b) => [...b.entityIds]);
const field = (m: MdpaModel, kind: string, name: string) => m.fields.find((f) => f.kind === kind && f.variable === name);

test("owned cells cover the source exactly once; parts keep the source's ids, fields, Conditions and SubModelParts", async () => {
  const src = tetBar(6);
  const r = await partitionParts(src, { nparts: 3 });
  assert.equal(r.parts.length, 3);
  const all = elementIds(src);
  const owned: number[] = [];
  for (const p of r.parts) {
    const ownerField = field(p.model, "Elemental", PARTITION_OWNER_VARIABLE)!;
    for (let i = 0; i < ownerField.ids.length; i++) if (ownerField.values[i] === p.partId) owned.push(ownerField.ids[i]);
    // Original ids: every element of a part exists in the source under the same id.
    for (const id of elementIds(p.model)) assert.ok(all.includes(id));
    // Fields survived, restricted.
    assert.ok(field(p.model, "Nodal", "T"));
    assert.ok(field(p.model, "Elemental", "C")!.ids.every((id) => elementIds(p.model).includes(id)));
  }
  assert.deepEqual(owned.sort((a, b) => a - b), [...all].sort((a, b) => a - b), "every element owned exactly once");
  assert.equal(r.parts.reduce((s, p) => s + p.owned.Elements, 0), all.length);
  // No ghosts requested: none present, no Ghost part.
  for (const p of r.parts) {
    assert.equal(p.ghost.Elements, 0);
    assert.ok(!p.model.subModelParts.some((s) => s.name === GHOST_PART));
    assert.ok(field(p.model, "Elemental", PARTITION_GHOST_VARIABLE)!.values.every((v) => v === 0));
  }
  // The x = 0 condition lives in exactly one part (the one owning the elements it borders).
  assert.equal(r.parts.filter((p) => p.model.blocks.some((b) => b.kind === "Conditions")).length, 1);
  assert.ok(r.warnings.some((w) => /space-filling-curve/.test(w)));
});

test("ghost layers: ghosts are flagged, never owned by the part holding them, and grow with the layer count", async () => {
  const src = tetBar(6);
  const g0 = await partitionParts(src, { nparts: 3, ghostLayers: 0 });
  const g1 = await partitionParts(src, { nparts: 3, ghostLayers: 1 });
  const g2 = await partitionParts(src, { nparts: 3, ghostLayers: 2 });
  const total = (r: typeof g1) => r.parts.reduce((s, p) => s + p.ghost.Elements, 0);
  assert.equal(total(g0), 0);
  assert.ok(total(g1) > 0 && total(g2) > total(g1));
  for (const p of g1.parts) {
    const owner = field(p.model, "Elemental", PARTITION_OWNER_VARIABLE)!;
    const ghost = field(p.model, "Elemental", PARTITION_GHOST_VARIABLE)!;
    let nGhost = 0;
    for (let i = 0; i < ghost.ids.length; i++) {
      if (ghost.values[i] === 1) {
        nGhost++;
        assert.notEqual(owner.values[i], p.partId, "a ghost belongs to a NEIGHBOUR");
      } else assert.equal(owner.values[i], p.partId);
    }
    assert.equal(nGhost, p.ghost.Elements);
    const gp = p.model.subModelParts.find((s) => s.name === GHOST_PART)!;
    assert.equal(gp.elementIds.length, p.ghost.Elements);
    // Owned totals are unchanged by adding ghosts.
    assert.equal(p.owned.Elements, g0.parts.find((q) => q.partId === p.partId)!.owned.Elements);
  }
});

test("interface nodes are those an owned cell of this part shares with another part", async () => {
  const r = await partitionParts(tetBar(6), { nparts: 2 });
  const [a, b] = r.parts;
  assert.ok(a.interfaceNodes > 0);
  assert.deepEqual(a.interfaceNodeIds, b.interfaceNodeIds, "with two parts the shared nodes are the same set");
  const manifest = partitionManifest("bar.mdpa", r, ["p0.vtu", "p1.vtu"]) as { idsPreserved: boolean; files: { file: string; interfaceNodes: number }[] };
  assert.equal(manifest.idsPreserved, true);
  assert.deepEqual(manifest.files.map((f) => f.file), ["p0.vtu", "p1.vtu"]);
});

test("weights move the cut: a heavy element region ends up in a smaller part", async () => {
  const src = tetBar(6);
  const c = field(src, "Elemental", "C")!;
  // The first 12 elements (the low-x end) are 10x as heavy.
  const heavy = new Set([...c.ids].slice(0, 12));
  const weighted: MdpaModel = { ...src, fields: [...src.fields, { kind: "Elemental", variable: "W", components: 1, ids: c.ids, values: Float64Array.from(c.ids, (id) => (heavy.has(id) ? 10 : 1)) }] };
  const plain = await partitionParts(src, { nparts: 2 });
  const w = await partitionParts(weighted, { nparts: 2, weights: "W" });
  const heavyIn = (r: typeof w, part: number) => elementIds(r.parts[part].model).filter((id) => heavy.has(id)).length;
  assert.notDeepEqual(w.ownedElements, plain.ownedElements, "weights change the cut");
  assert.ok(Math.abs(heavyIn(w, 0) - heavyIn(w, 1)) < Math.abs(heavyIn(plain, 0) - heavyIn(plain, 1)) + 1, "heavy cells spread more evenly");
  await assert.rejects(partitionParts(src, { nparts: 2, weights: "NOPE" }), /No Elemental field/);
  const bad: MdpaModel = { ...weighted, fields: weighted.fields.map((f) => (f.variable === "W" ? { ...f, values: Float64Array.from(f.values, (v, i) => (i === 0 ? -1 : v)) } : f)) };
  await assert.rejects(partitionParts(bad, { nparts: 2, weights: "W" }), /finite and positive/);
});

test("refusals: KaHIP by name, too many parts, no cells, bad ghost count", async () => {
  const src = tetBar(2);
  await assert.rejects(partitionParts(src, { nparts: 2, method: "kahip" }), /KaHIP is not available/);
  await assert.rejects(partitionParts(src, { nparts: 1000 }), /parts requested/);
  await assert.rejects(partitionParts(src, { nparts: 0 }), /at least 1/);
  await assert.rejects(partitionParts(src, { nparts: 2, ghostLayers: 9 }), /between 0 and 8/);
  await assert.rejects(partitionParts({ ...src, blocks: [] }, { nparts: 2 }), /no cells/);
});

// ---- components -----------------------------------------------------------------

/** Two separate unit tetrahedra-worth blocks: a 3-element body, a 1-element body and a loose node. */
function twoBodies(): MdpaModel {
  return model(
    "Begin Properties 1\nEnd Properties\nBegin Nodes\n" +
      "1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\n5 1 1 1\n" +
      "10 10 0 0\n11 11 0 0\n12 10 1 0\n13 10 0 1\n" +
      "99 50 50 50\nEnd Nodes\n" +
      "Begin Elements Element3D4N\n1 1 1 2 3 4\n2 1 2 3 4 5\n3 1 3 4 5 2\n7 1 10 11 12 13\nEnd Elements\n" +
      "Begin Conditions SurfaceCondition3D3N\n100 1 1 2 3\n200 1 10 11 12\n300 1 1 2 10\nEnd Conditions\n" +
      "Begin ElementalData KIND\n1 1\n2 1\n3 2\n7 2\nEnd ElementalData\n"
  );
}

test("connected components: sorted largest first, ties deterministic, loose nodes counted", () => {
  const r = connectedComponents(twoBodies());
  assert.deepEqual(r.components.map((c) => c.elements), [3, 1]);
  assert.deepEqual(r.components[0].elementIds, [1, 2, 3]);
  assert.deepEqual(r.components[1].elementIds, [7]);
  assert.equal(r.components[1].isolated, false, "1 of 3 is not under 1%");
  assert.equal(connectedComponents(twoBodies(), 0.5).components[1].isolated, true);
  assert.equal(r.looseNodes, 1, "node 99 belongs to no element");
});

test("split by component: every element accounted for once, conditions follow their body, a bridging condition is reported", () => {
  const src = twoBodies();
  const r = splitModel(src, { by: "component" });
  assert.deepEqual(r.groups.map((g) => g.key), ["component_0", "component_1"]);
  const seen = r.groups.flatMap((g) => elementIds(g.model)).sort((a, b) => a - b);
  assert.deepEqual(seen, [1, 2, 3, 7]);
  assert.equal(r.groups[0].conditions, 1, "condition 100 lies on body 0");
  assert.equal(r.groups[1].conditions, 1, "condition 200 lies on body 1");
  assert.equal(r.unassignedConditions, 1, "condition 300 reaches across");
  assert.ok(r.warnings.some((w) => /more than one group/.test(w)));
  assert.equal(r.looseNodes, 1);
  // Original ids survive.
  assert.ok(r.groups[1].model.blocks.some((b) => b.kind === "Elements" && b.entityIds[0] === 7));
});

test("split by type and by an elemental field", () => {
  const src = twoBodies();
  const byField = splitModel(src, { by: "field", variable: "KIND" });
  assert.deepEqual(byField.groups.map((g) => [g.key, elementIds(g.model)]), [["KIND_1", [1, 2]], ["KIND_2", [3, 7]]]);
  const byType = splitModel(src, { by: "type" });
  assert.equal(byType.groups.length, 1, "all Element3D4N");
  assert.throws(() => splitModel(src, { by: "field", variable: "NOPE" }), /No Elemental field/);
});

test("markComponents writes each element's component index, and is a noop for a single body", () => {
  const src = twoBodies();
  const r = markComponentsModel(src);
  const f = field(r.model, "Elemental", COMPONENT_VARIABLE)!;
  assert.deepEqual([...f.ids].map((id, i) => [id, f.values[i]]).sort((a, b) => a[0] - b[0]), [[1, 0], [2, 0], [3, 0], [7, 1]]);
  const bar3 = tetBar(3);
  const one = markComponentsModel(bar3);
  assert.equal(one.components, 1);
  assert.equal(one.model, bar3, "a single body hands the model back unchanged");
  // as an op
  assert.equal(isAsyncOp("markComponents"), false);
  const out = applyOp(src, { op: "markComponents" });
  assert.match(out.message!, /Marked 2 connected components in COMPONENT_INDEX \(0 = the largest\)\. Elements per component: 3, 1\./);
  assert.equal(applyOp(tetBar(3), { op: "markComponents" }).noop, true);
  const rec = opRecordFromMessage({ op: "markComponents", output: "BODY", fragmentFraction: "0.05" })!;
  assert.deepEqual(rec, { op: "markComponents", output: "BODY", fragmentFraction: 0.05 });
  assert.equal(opRecordFromMessage({ op: "markComponents", output: "a:b" }), undefined);
  assert.equal(opRecordFromMessage({ op: "markComponents", fragmentFraction: 2 }), undefined);
  assert.deepEqual(parseOpsJson(serializeOps([rec], "x.mdpa")).operations, [rec]);
});
