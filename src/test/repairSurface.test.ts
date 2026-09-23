/**
 * Surface repair, end to end over the real WASM: committed defective surfaces
 * (a hole, a flipped triangle, a bowtie vertex) plus a clean control, asserting
 * that the requested counts improve, that untouched entities keep their ids,
 * fields and SubModelParts, and that every generated face has an explicit
 * membership and field policy.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { repairSurfaceModel, REPAIR_FILL_PART } from "../parser/repairSurface";
import { surfaceDefects, surfaceDefectsSummary } from "../parser/surfaceDefects";
import { applyOpAsync, opRecordFromMessage, parseOpsJson, serializeOps, isAsyncOp } from "../parser/operations";
import { ADOPTING_OPS } from "../parser/adoptingOps";
import { MdpaModel } from "../parser/types";

const FIXTURES = path.resolve(__dirname, "../../src/test/fixtures/repair");
const load = (name: string): MdpaModel => parseMdpa(fs.readFileSync(path.join(FIXTURES, `${name}.mdpa`), "utf8"));
const field = (m: MdpaModel, kind: string, name: string) => m.fields.find((f) => f.kind === kind && f.variable === name);

/** Signed volume of a closed triangle surface — positive when the normals point outward. */
function signedVolume(m: MdpaModel): number {
  const idx = new Map<number, number>();
  for (let i = 0; i < m.nodeCount; i++) idx.set(m.nodeIds[i], i);
  let v = 0;
  for (const b of m.blocks) {
    for (let c = 0; c < b.count; c++) {
      const p = [0, 1, 2].map((k) => idx.get(b.connectivity[c * b.stride + k])! * 3);
      const [a, bb, cc] = p.map((o) => [m.coords[o], m.coords[o + 1], m.coords[o + 2]]);
      v += (a[0] * (bb[1] * cc[2] - bb[2] * cc[1]) - a[1] * (bb[0] * cc[2] - bb[2] * cc[0]) + a[2] * (bb[0] * cc[1] - bb[1] * cc[0])) / 6;
    }
  }
  return v;
}

test("the fixtures really are defective, and the clean control is not", () => {
  assert.equal(surfaceDefects(load("open_box_hole")).boundaryEdges.length, 4);
  assert.ok(surfaceDefects(load("flipped_triangle")).inconsistentFaces.length >= 2);
  const clean = surfaceDefects(load("closed_cube"));
  assert.equal(surfaceDefectsSummary(clean), "closed, manifold and consistently wound");
  assert.equal(surfaceDefects(load("bowtie")).nonManifoldEdges.length, 0, "a bowtie vertex has manifold edges");
});

test("a hole is filled: faces join the source block, a Repair_Fill part names them, ids and fields survive", async () => {
  const base = load("open_box_hole");
  const r = await repairSurfaceModel(base);
  assert.equal(r.changed, true);
  if (!r.changed) return;
  assert.equal(r.before.boundaryEdges, 4);
  assert.equal(r.after.boundaryEdges, 0);
  assert.equal(r.facesAdded, 4);
  assert.equal(surfaceDefects(r.model).boundaryEdges.length, 0);

  // The 10 source conditions keep ids 100..109; the 4 fill faces join the SAME block.
  assert.equal(r.model.blocks.length, 1);
  const block = r.model.blocks[0];
  assert.equal(block.name, "SurfaceCondition3D3N");
  assert.equal(block.kind, "Conditions");
  assert.equal(block.count, 14);
  const ids = [...block.entityIds];
  for (let id = 100; id < 110; id++) assert.ok(ids.includes(id));
  assert.equal(new Set(ids).size, 14, "entity ids stay unique");
  assert.deepEqual([...block.propertyIds!].slice(10), [1, 1, 1, 1], "fill faces take the block's property");

  // Explicit membership for the generated faces, and the original part is untouched.
  const fill = r.model.subModelParts.find((p) => p.name === REPAIR_FILL_PART)!;
  assert.equal(fill.conditionIds.length, 4);
  assert.ok(![...fill.conditionIds].some((id) => id >= 100 && id < 110));
  const wall = r.model.subModelParts.find((p) => p.name === "Wall")!;
  assert.deepEqual([...wall.conditionIds], [100, 101]);
  assert.deepEqual([...wall.nodeIds], [1, 2, 3, 4]);

  // Field policy: a nodal value exists on the new hole-centre point (the rim mean);
  // a per-condition field is a GAP on the fill faces, never 0.
  assert.equal(r.model.nodeCount, base.nodeCount + 1);
  const temp = field(r.model, "Nodal", "TEMP")!;
  assert.equal(temp.ids.length, base.nodeCount + 1);
  const newNode = [...r.model.nodeIds].find((id) => !base.nodeIds.includes(id))!;
  assert.equal(temp.values[temp.ids.indexOf(newNode)], (40 + 50 + 60 + 70) / 4);
  const qq = field(r.model, "Conditional", "QQ")!;
  assert.equal(qq.ids.length, 10);
  assert.ok(![...qq.ids].some((id) => !ids.slice(0, 10).includes(id)));
  assert.ok(!r.model.fields.some((f) => f.variable.includes(":")));
  assert.match(r.message, /4 boundary, 0 non-manifold, 0 inconsistent pair\(s\) → 0 boundary/);
  assert.match(r.message, /Repair_Fill/);
});

test("a flipped triangle is re-wound and the closed surface points outward", async () => {
  const base = load("flipped_triangle");
  const r = await repairSurfaceModel(base);
  assert.equal(r.changed, true);
  if (!r.changed) return;
  assert.ok(r.before.inconsistentPairs > 0);
  assert.equal(r.after.inconsistentPairs, 0);
  assert.equal(surfaceDefects(r.model).inconsistentFaces.length, 0);
  assert.ok(signedVolume(r.model) > 0, "normals point outward");
  assert.ok(Math.abs(signedVolume(r.model) - 1) < 1e-6, "still the unit cube");
  // Nothing was created or removed.
  assert.equal(r.model.blocks[0].count, 12);
  assert.equal(r.model.nodeCount, base.nodeCount);
  assert.ok(!r.model.subModelParts.some((p) => p.name === REPAIR_FILL_PART));
  assert.deepEqual([...r.model.blocks[0].entityIds].sort((a, b) => a - b), [...base.blocks[0].entityIds].sort((a, b) => a - b));
});

test("a bowtie vertex is split into two, each fan keeping its own node, with the nodal value copied", async () => {
  const base = load("bowtie");
  // Each fan is an open patch, so its rim is a "hole" too; isolate the split.
  const r = await repairSurfaceModel(base, { fillHoles: false, orientOutward: false });
  assert.equal(r.changed, true);
  if (!r.changed) return;
  assert.equal(r.model.nodeCount, base.nodeCount + 1);
  assert.equal(new Set(r.model.nodeIds).size, r.model.nodeCount, "node ids stay unique");
  const temp = field(r.model, "Nodal", "TEMP")!;
  const zero = [...r.model.nodeIds].filter((id) => temp.values[temp.ids.indexOf(id)] === 0);
  assert.equal(zero.length, 2, "the split vertex carries the original value on both copies");
  assert.match(r.message, /Split 1 non-manifold vertex\./);
});

test("a clean closed surface is a noop that says why", async () => {
  const r = await repairSurfaceModel(load("closed_cube"));
  assert.equal(r.changed, false);
  assert.match(r.message, /Nothing to repair/);
});

test("a hole above maxHoleEdges is left open and reported", async () => {
  const r = await repairSurfaceModel(load("open_box_hole"), { maxHoleEdges: 3 });
  assert.equal(r.changed, false);
  assert.match(r.message, /1 hole\(s\) exceed 3 boundary edges/);
});

test("switching every option off is a noop", async () => {
  const r = await repairSurfaceModel(load("open_box_hole"), {
    fixOrientation: false,
    orientOutward: false,
    fillHoles: false,
    splitNonManifold: false,
  });
  assert.equal(r.changed, false);
});

test("a volume mesh is refused by name, pointing at Export skin", async () => {
  const vol = parseMdpa(
    "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\nEnd Nodes\nBegin Elements Element3D4N\n1 0 1 2 3 4\nEnd Elements\n"
  );
  const r = await repairSurfaceModel(vol);
  assert.equal(r.changed, false);
  assert.match(r.message, /Export skin/);
});

test("repairSurface is an async, adopting op reachable from messages, applyOpAsync and recipes", async () => {
  assert.equal(isAsyncOp("repairSurface"), true);
  assert.ok(ADOPTING_OPS.includes("repairSurface"));
  const rec = opRecordFromMessage({ op: "repairSurface", maxHoleEdges: "20", weldTolerance: 0, fillHoles: true })!;
  assert.deepEqual(rec, { op: "repairSurface", fillHoles: true, maxHoleEdges: 20, weldTolerance: 0 });
  assert.equal(opRecordFromMessage({ op: "repairSurface", maxHoleEdges: -1 }), undefined);
  const out = await applyOpAsync(load("open_box_hole"), rec);
  assert.equal(out.noop, undefined);
  assert.match(out.message!, /Repaired/);
  const back = parseOpsJson(serializeOps([rec], "x.mdpa"));
  assert.deepEqual(back.operations, [rec]);
  assert.equal(parseOpsJson(JSON.stringify({ version: 1, operations: [{ op: "repairSurface", maxHoleEdges: -3 }] })).operations.length, 0);
});

test("repairing twice: the second run finds nothing, and a preexisting Repair_Fill part is not clobbered", async () => {
  const first = await repairSurfaceModel(load("open_box_hole"));
  assert.equal(first.changed, true);
  if (!first.changed) return;
  const second = await repairSurfaceModel(first.model);
  assert.equal(second.changed, false);
  // Reopen the hole to force a second fill: a distinct part name is chosen.
  const holed: MdpaModel = {
    ...first.model,
    blocks: first.model.blocks.map((b) => ({
      ...b,
      count: b.count - 2,
      entityIds: b.entityIds.slice(0, b.count - 2),
      connectivity: b.connectivity.slice(0, (b.count - 2) * b.stride),
      propertyIds: b.propertyIds?.slice(0, b.count - 2),
    })),
  };
  const again = await repairSurfaceModel(holed);
  if (again.changed) {
    const names = again.model.subModelParts.map((p) => p.name);
    assert.ok(names.includes(REPAIR_FILL_PART) && names.includes(`${REPAIR_FILL_PART}_2`), names.join(","));
  }
});
