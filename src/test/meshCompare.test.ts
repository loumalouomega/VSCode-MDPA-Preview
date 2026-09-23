/**
 * Mesh and field comparison: identical meshes give zero differences, known
 * perturbations give the expected errors, and missing coverage is never treated
 * as zero — for both correspondences (by id, and spatial point sampling through
 * the real meshio++ `interpolate`).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import { compareMeshes, compareFieldData, compareFieldModel } from "../parser/meshCompare";
import { applyOpAsync, opRecordFromMessage, parseOpsJson, serializeOps, isAsyncOp } from "../parser/operations";
import { MdpaModel, FieldData } from "../parser/types";

const model = (text: string): MdpaModel => {
  const r = parseMdpa(text) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

/** A unit square as 2 triangles, with a nodal TEMP, an elemental MAT, a Wall part and a Conditions block. */
const SQUARE =
  "Begin Properties 1\nEnd Properties\nBegin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\nEnd Nodes\n" +
  "Begin Elements Element2D3N\n1 1 1 2 3\n2 1 1 3 4\nEnd Elements\n" +
  "Begin Conditions LineCondition2D2N\n10 1 1 2\nEnd Conditions\n" +
  "Begin NodalData TEMP\n1 0 10\n2 0 20\n3 0 30\n4 0 40\nEnd NodalData\n" +
  "Begin ElementalData MAT\n1 5\n2 7\nEnd ElementalData\n" +
  "Begin SubModelPart Wall\n Begin SubModelPartNodes\n 1\n 2\n End SubModelPartNodes\n Begin SubModelPartConditions\n 10\n End SubModelPartConditions\nEnd SubModelPart\n";

const field = (m: MdpaModel, kind: string, name: string): FieldData => m.fields.find((f) => f.kind === kind && f.variable === name)!;
const withField = (m: MdpaModel, f: FieldData): MdpaModel => ({ ...m, fields: m.fields.map((x) => (x.kind === f.kind && x.variable === f.variable ? f : x)) });

test("identical meshes: verdict identical, nothing differs anywhere", () => {
  const r = compareMeshes(model(SQUARE), model(SQUARE));
  assert.equal(r.verdict, "identical");
  assert.equal(r.nodes.moved, 0);
  assert.equal(r.nodes.maxCoordDiff, 0);
  for (const kind of ["Elements", "Conditions", "Geometries"] as const) {
    assert.equal(r.entities[kind].onlyInA + r.entities[kind].onlyInB + r.entities[kind].connectivityChanged, 0);
  }
  assert.deepEqual(r.subModelParts, { onlyInA: [], onlyInB: [], differing: [] });
  assert.ok(r.fields.every((f) => f.exact && f.maxAbs === 0 && f.exceeding === 0));
});

test("a known coordinate perturbation is located, and tolerance turns 'different' into 'equal within tolerance'", () => {
  const a = model(SQUARE);
  const coords = Float32Array.from(a.coords);
  coords[2 * 3] += 0.001; // node 3, x
  const b = { ...a, coords };
  const strict = compareMeshes(a, b);
  assert.equal(strict.verdict, "different");
  assert.equal(strict.nodes.moved, 1);
  assert.equal(strict.nodes.worstId, 3);
  assert.ok(Math.abs(strict.nodes.maxCoordDiff - 0.001) < 1e-6);
  const loose = compareMeshes(a, b, { atol: 0.01 });
  assert.equal(loose.verdict, "equal within tolerance");
  assert.equal(loose.nodes.moved, 0);
});

test("structure: removed entities, changed connectivity, renamed blocks and SubModelPart membership are all named", () => {
  const a = model(SQUARE);
  // B: element 2 dropped, element 1's nodes rotated, the Conditions block renamed, Wall loses node 2 and gains a sibling.
  const blocks = a.blocks.map((b) => {
    if (b.kind === "Elements") {
      return { ...b, count: 1, entityIds: b.entityIds.slice(0, 1), connectivity: Int32Array.from([2, 3, 1]), propertyIds: b.propertyIds?.slice(0, 1) };
    }
    return { ...b, name: "LineCondition2D2N_v2" };
  });
  const parts = [
    { ...a.subModelParts[0], nodeIds: Int32Array.from([1]) },
    { ...a.subModelParts[0], name: "Extra", path: "Extra" },
  ];
  const r = compareMeshes(a, { ...a, blocks, subModelParts: parts });
  assert.equal(r.verdict, "different");
  assert.equal(r.entities.Elements.onlyInA, 1);
  assert.equal(r.entities.Elements.connectivityChanged, 1);
  assert.deepEqual(r.blocks.onlyInB, ["LineCondition2D2N_v2"]);
  assert.deepEqual(r.subModelParts.onlyInB, ["Extra"]);
  assert.deepEqual(r.subModelParts.differing, [{ path: "Wall", differences: [{ list: "nodes", onlyInA: 1, onlyInB: 0 }] }]);
});

test("independent id spaces: Element 1 and Condition 1 are never confused", () => {
  const a = model(SQUARE.replace("10 1 1 2", "1 1 1 2").replace(" 10\n", " 1\n"));
  assert.equal(a.blocks.find((b) => b.kind === "Conditions")!.entityIds[0], 1);
  const r = compareMeshes(a, a);
  assert.equal(r.verdict, "identical");
  assert.equal(r.entities.Elements.common, 2);
  assert.equal(r.entities.Conditions.common, 1);
});

test("field statistics: known perturbations give the exact max / RMS / mean, relative error and gap counts", () => {
  const a = model(SQUARE);
  const t = field(a, "Nodal", "TEMP");
  const b = withField(a, { ...t, values: Float64Array.from([10, 22, 30, 36]) }); // diffs 0, 2, 0, -4
  const r = compareFieldData(t, field(b, "Nodal", "TEMP"), 0, 0);
  assert.equal(r.compared, 4);
  assert.equal(r.maxAbs, 4);
  assert.equal(r.worstId, 4);
  assert.equal(r.meanAbs, 1.5);
  assert.ok(Math.abs(r.rms - Math.sqrt((0 + 4 + 0 + 16) / 4)) < 1e-12);
  assert.ok(Math.abs(r.maxRel - 4 / 36) < 1e-12);
  assert.equal(r.exceeding, 2);
  assert.equal(r.exact, false);
  // tolerance: atol 2 accepts the 2 but not the 4; rtol 0.2 accepts both (|4| <= 0.2*36).
  assert.equal(compareFieldData(t, field(b, "Nodal", "TEMP"), 2, 0).exceeding, 1);
  assert.equal(compareFieldData(t, field(b, "Nodal", "TEMP"), 0, 0.2).exceeding, 0);
});

test("coverage: ids in one mesh only, and non-finite values, are gaps — never compared as 0", () => {
  const a = model(SQUARE);
  const t = field(a, "Nodal", "TEMP");
  const partial: FieldData = { ...t, ids: Int32Array.from([1, 2, 5]), values: Float64Array.from([10, NaN, 99]) };
  const r = compareFieldData(t, partial, 0, 0);
  assert.equal(r.compared, 1, "only node 1 has a finite value on both sides");
  assert.equal(r.onlyInAIds, 3, "nodes 2 (NaN), 3, 4 have no partner");
  assert.equal(r.onlyInBIds, 1, "node 5 exists only in B");
  assert.equal(r.maxAbs, 0);
  const v = compareFieldData({ ...t, components: 3, values: new Float64Array(12) }, t, 0, 0);
  assert.deepEqual(v.shapeMismatch, { a: 3, b: 1 });
  assert.equal(compareMeshes(a, { ...a, fields: [] }).verdict, "different");
});

test("compareField by id writes signed, absolute and relative difference fields, with gaps where there is no partner", async () => {
  const a = model(SQUARE);
  const t = field(a, "Nodal", "TEMP");
  // B's TEMP has node 3 missing and node 4 equal to zero (relative error undefined there).
  const b: MdpaModel = { ...a, fields: [{ ...t, ids: Int32Array.from([1, 2, 4]), values: Float64Array.from([12, 20, 0]) }, field(a, "Elemental", "MAT")] };
  const r = await compareFieldModel(a, b, { variable: "TEMP", kind: "Nodal" });
  assert.deepEqual(r.written, ["Nodal:TEMP_DIFF", "Nodal:TEMP_ABS", "Nodal:TEMP_REL"]);
  const diff = field(r.model, "Nodal", "TEMP_DIFF");
  assert.deepEqual([...diff.ids], [1, 2, 4]);
  assert.deepEqual([...diff.values], [-2, 0, 40]);
  assert.deepEqual([...field(r.model, "Nodal", "TEMP_ABS").values], [2, 0, 40]);
  const rel = field(r.model, "Nodal", "TEMP_REL");
  assert.deepEqual([...rel.ids], [1, 2], "|b| = 0 has no relative error, and node 3 has no partner");
  assert.ok(Math.abs(rel.values[0] - 2 / 12) < 1e-12);
  assert.equal(r.uncovered, 1);
  assert.equal(field(r.model, "Nodal", "TEMP").values[0], 10, "the compared field itself is untouched");
  // Elemental works the same way, per kind.
  const e = await compareFieldModel(a, withField(b, { ...field(a, "Elemental", "MAT"), values: Float64Array.from([5, 9]) }), { variable: "MAT", kind: "Elemental", output: "M" });
  assert.deepEqual(e.written, ["Elemental:M_DIFF", "Elemental:M_ABS", "Elemental:M_REL"]);
  assert.deepEqual([...field(e.model, "Elemental", "M_DIFF").values], [0, -2]);
});

/** A triangulated (n x n cells) unit square carrying T = x + 2y and V = (x, y, 0), optionally with a node outside. */
function grid(n: number, extraOutside = false): MdpaModel {
  const nodes: number[][] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) nodes.push([i / n, j / n, 0]);
  const tris: number[][] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i + 1;
      tris.push([a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]);
    }
  }
  if (extraOutside) nodes.push([3, 3, 0]);
  let s = "Begin Nodes\n" + nodes.map((p, i) => `${i + 1} ${p.join(" ")}`).join("\n") + "\nEnd Nodes\n";
  s += "Begin Elements Element2D3N\n" + tris.map((t, i) => `${i + 1} 0 ${t.join(" ")}`).join("\n") + "\nEnd Elements\n";
  s += "Begin NodalData T\n" + nodes.map((p, i) => `${i + 1} 0 ${p[0] + 2 * p[1]}`).join("\n") + "\nEnd NodalData\n";
  s += "Begin NodalData V\n" + nodes.map((p, i) => `${i + 1} 0 (${p[0]},${p[1]},0)`).join("\n") + "\nEnd NodalData\n";
  return model(s);
}

test("spatial correspondence samples a different discretization exactly for a linear field, and uncovered nodes are gaps", async () => {
  const fine = grid(6, true); // 49 nodes + one at (3,3), outside the coarse mesh
  const coarse = grid(2);
  const r = await compareFieldModel(fine, coarse, { variable: "T", kind: "Nodal", correspondence: "spatial" });
  assert.equal(r.comparison!.compared, 49);
  assert.ok(r.comparison!.maxAbs < 1e-6, `linear field is reproduced to float32 precision: ${r.comparison!.maxAbs}`);
  assert.equal(r.uncovered, 1, "the node at (3,3) is outside the coarse mesh");
  const abs = field(r.model, "Nodal", "T_ABS");
  assert.equal(abs.ids.length, 49);
  assert.ok(![...abs.ids].includes(50), "the uncovered node is a gap in the result, not 0");
  const v = await compareFieldModel(fine, coarse, { variable: "V", kind: "Nodal", correspondence: "spatial" });
  assert.ok(v.comparison!.maxAbs < 1e-6);
  assert.equal(field(v.model, "Nodal", "V_DIFF").components, 3);
});

test("spatial sampling reports a real difference, and a coverage gap in the other mesh uncovers the nodes that touch it", async () => {
  const fine = grid(4);
  const coarse = grid(2);
  const t = field(coarse, "Nodal", "T");
  const shifted = withField(coarse, { ...t, values: Float64Array.from(t.values, (v) => v + 0.5) });
  const r = await compareFieldModel(fine, shifted, { variable: "T", kind: "Nodal", correspondence: "spatial" });
  assert.ok(Math.abs(r.comparison!.maxAbs - 0.5) < 1e-6 && Math.abs(r.comparison!.meanAbs - 0.5) < 1e-6);
  // Remove the centre node's value from the coarse mesh: every fine node inside a cell touching it is uncovered.
  const hole = withField(coarse, { ...t, ids: t.ids.filter((id) => id !== 5), values: Float64Array.from(t.values.filter((_, i) => t.ids[i] !== 5)) });
  const g = await compareFieldModel(fine, hole, { variable: "T", kind: "Nodal", correspondence: "spatial" });
  assert.ok(g.uncovered > 0 && g.uncovered < fine.nodeCount);
  assert.ok(g.comparison!.maxAbs < 1e-6, "whatever WAS covered is still exact");
});

test("refusals: an unknown field, a width mismatch, a bad name, and spatial sampling of a cell field", async () => {
  const a = model(SQUARE);
  assert.match((await compareFieldModel(a, a, { variable: "NOPE", kind: "Nodal" })).message!, /No Nodal field named "NOPE" in this mesh/);
  assert.match((await compareFieldModel(a, { ...a, fields: [] }, { variable: "TEMP", kind: "Nodal" })).message!, /other mesh has no Nodal field/);
  assert.match((await compareFieldModel(a, a, { variable: "TEMP", kind: "Nodal", output: "a:b" })).message!, /not a valid/);
  assert.match((await compareFieldModel(a, a, { variable: "MAT", kind: "Elemental", correspondence: "spatial" })).message!, /Average field/);
  const wide = { ...a, fields: [{ ...field(a, "Nodal", "TEMP"), components: 3, values: new Float64Array(12) }] };
  assert.match((await compareFieldModel(a, wide, { variable: "TEMP", kind: "Nodal" })).message!, /component/);
});

test("compareField is an async op reachable from messages, applyOpAsync (reading a file) and recipes", async () => {
  assert.equal(isAsyncOp("compareField"), true);
  assert.equal(opRecordFromMessage({ op: "compareField", variable: "T", kind: "Nodal" }), undefined, "a path is required");
  const rec = opRecordFromMessage({ op: "compareField", path: "b.mdpa", variable: "T", kind: "Nodal", correspondence: "spatial", atol: "0.01", output: "TT" })!;
  assert.deepEqual(rec, { op: "compareField", path: "b.mdpa", variable: "T", kind: "Nodal", correspondence: "spatial", output: "TT", atol: 0.01 });
  assert.equal(opRecordFromMessage({ op: "compareField", path: "b", variable: "T", kind: "Nodal", correspondence: "psychic" }), undefined);
  assert.equal(opRecordFromMessage({ op: "compareField", path: "b", variable: "T", kind: "Nodal", atol: -1 }), undefined);
  assert.deepEqual(parseOpsJson(serializeOps([rec], "x.mdpa")).operations, [rec]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-"));
  const other = path.join(dir, "other.mdpa");
  const a = grid(2);
  const t = field(a, "Nodal", "T");
  fs.writeFileSync(other, writeMdpa(withField(a, { ...t, values: Float64Array.from(t.values, (v) => v + 1) })));
  const out = await applyOpAsync(a, { op: "compareField", path: other, variable: "T", kind: "Nodal", atol: 0.1 });
  assert.equal(out.noop, undefined, String(out.message));
  assert.match(out.message!, /9 entit\(y\/ies\) compared, max \|a−b\| = 1\.000/);
  assert.match(out.message!, /9 outside the tolerance/);
  assert.match(out.message!, /Wrote T_DIFF, T_ABS, T_REL/);
  const missing = await applyOpAsync(a, { op: "compareField", path: path.join(dir, "nope.mdpa"), variable: "T", kind: "Nodal" });
  assert.equal(missing.noop, true);
  assert.match(missing.message!, /Could not read/);
});
