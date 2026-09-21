/**
 * runAdoptingOp — the carry -> run -> adopt -> tidy pipeline every in-place
 * topology-changing meshio++ op shares. Runs the real WASM, with `repair` as the
 * witness: it appends fill faces and a hole-centre point to an open surface, so
 * it exercises created entities, upstream provenance arrays and NaN fill.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { runAdoptingOp, describeFidelity, tidyAdoptedFields } from "../parser/adoptOp";
import { ADOPTING_OPS } from "../parser/adoptingOps";
import { isAsyncOp } from "../parser/operations";
import { MdpaModel } from "../parser/types";

/** A unit cube missing its top face, one side triangle flipped: one hole, two bad pairs. */
function openBox(): MdpaModel {
  const nodes = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const tri = [[1, 3, 2], [1, 4, 3], [1, 6, 2], [1, 5, 6], [2, 3, 7], [2, 7, 6], [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8]];
  tri[2] = [1, 2, 6];
  let s = "Begin Properties 1\nEnd Properties\nBegin Nodes\n";
  s += nodes.map((n, i) => `${i + 1} ${n.join(" ")}`).join("\n") + "\nEnd Nodes\n";
  s += "Begin Conditions SurfaceCondition3D3N\n" + tri.map((t, i) => `${100 + i} 1 ${t.join(" ")}`).join("\n") + "\nEnd Conditions\n";
  s += "Begin NodalData TEMP\n" + nodes.map((_, i) => `${i + 1} 0 ${i * 10}`).join("\n") + "\nEnd NodalData\n";
  s += "Begin ConditionalData QQ\n" + tri.map((_, i) => `${100 + i} 0 ${i}`).join("\n") + "\nEnd ConditionalData\n";
  s += "Begin SubModelPart Wall\n Begin SubModelPartNodes\n 1\n 2\n 3\n 4\n End SubModelPartNodes\n";
  s += " Begin SubModelPartConditions\n 100\n 101\n End SubModelPartConditions\nEnd SubModelPart\n";
  const r = parseMdpa(s) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
}

const repairCall = (m: import("../parser/meshio").MeshioModule, mesh: import("../parser/meshioConvert").MeshioMesh) =>
  m.repair(mesh, true, true, true, true, 10, 0, true);

test("an adopting op keeps ids, kinds, SubModelParts and Properties of the untouched entities", async () => {
  const base = openBox();
  const r = await runAdoptingOp(base, [], "repair", repairCall, { recoverBlockNames: true });
  assert.ok(r);
  // The ten original conditions keep their ids 100..109.
  const original = r.model.blocks.filter((b) => b.kind === "Conditions").flatMap((b) => [...b.entityIds]);
  for (let id = 100; id < 110; id++) assert.ok(original.includes(id), `condition ${id} kept`);
  // SubModelPart membership survives untouched.
  const wall = r.model.subModelParts.find((p) => p.name === "Wall");
  assert.deepEqual([...wall!.conditionIds], [100, 101]);
  assert.deepEqual([...wall!.nodeIds], [1, 2, 3, 4]);
  // Block name recovered from the per-block Cell region.
  assert.ok(r.model.blocks.some((b) => b.name === "SurfaceCondition3D3N"));
  // Originals' nodal values are untouched.
  const temp = r.model.fields.find((f) => f.kind === "Nodal" && f.variable === "TEMP")!;
  assert.equal(temp.values[temp.ids.indexOf(3)], 20);
});

test("upstream provenance arrays are dropped and NaN fill becomes a gap, never 0", async () => {
  const r = await runAdoptingOp(openBox(), [], "repair", repairCall, { recoverBlockNames: true });
  assert.ok(r);
  assert.ok(!r.model.fields.some((f) => f.variable.includes(":")), "no colon-named fields survive");
  assert.ok(r.provenanceDropped.includes("repair:hole"));
  // QQ existed on the 10 conditions only; the 4 fill faces read NaN upstream.
  const qq = r.model.fields.filter((f) => f.variable === "QQ");
  const rows = qq.reduce((n, f) => n + f.ids.length, 0);
  assert.equal(rows, 10);
  assert.ok(qq.every((f) => [...f.values].every(Number.isFinite)));
  assert.ok(r.sparsened.some((s) => s.name.endsWith(":QQ") && s.rows === 4));
});

test("describeFidelity names created ids and every lost slot, but not the routine ones", async () => {
  const r = await runAdoptingOp(openBox(), [], "repair", repairCall, { recoverBlockNames: true });
  assert.ok(r);
  const s = describeFidelity(r);
  assert.match(s, /New ids assigned to 1 node\(s\), 4 element\(s\)/);
  assert.doesNotMatch(s, /fieldFixedFlags/);
});

test("an empty model is reported as nothing to do", async () => {
  const empty = { ...openBox(), nodeCount: 0 };
  assert.equal(await runAdoptingOp(empty, [], "repair", repairCall), undefined);
});

test("tidyAdoptedFields drops colon names and empties without touching clean fields", () => {
  const base = openBox();
  const withNoise: MdpaModel = {
    ...base,
    fields: [
      ...base.fields,
      { kind: "Nodal", variable: "repair:parent_point", components: 1, ids: Int32Array.from([1]), values: Float64Array.from([0]) },
      { kind: "Elemental", variable: "ALLNAN", components: 1, ids: Int32Array.from([1, 2]), values: Float64Array.from([NaN, NaN]) },
    ],
  };
  const t = tidyAdoptedFields(withNoise);
  assert.deepEqual(t.provenanceDropped, ["repair:parent_point"]);
  assert.ok(!t.model.fields.some((f) => f.variable === "ALLNAN"));
  assert.equal(t.model.fields.filter((f) => f.variable === "TEMP").length, 1);
});

test("every registered adopting op is a real async op", () => {
  for (const op of ADOPTING_OPS) assert.ok(isAsyncOp(op), `${op} must be in ASYNC_OPS`);
});
