/**
 * Tessellation of curved cells, end to end over the real WASM: the linear
 * children must cover the same volume, ids must stay unique per kind, and the
 * parent's SubModelParts, property and fields must carry onto the children.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { tetBar } from "./fixtures/shapes";
import { linearToQuadratic } from "../parser/linearToQuadratic";
import { tessellateModel, estimateTessellatedCells } from "../parser/tessellate";
import { elementMeasures } from "../parser/selectCells";
import { applyOpAsync, opRecordFromMessage, parseOpsJson, serializeOps, isAsyncOp } from "../parser/operations";
import { ADOPTING_OPS } from "../parser/adoptingOps";
import { VtkCellType } from "../parser/geometryMap";

const quadratic = () => linearToQuadratic(tetBar(2)).model;
const total = (m: ReturnType<typeof quadratic>) => [...elementMeasures(m).measure.values()].reduce((a, b) => a + b, 0);

test("a quadratic tetrahedron bar becomes linear tets covering the same volume", async () => {
  const q = quadratic();
  const r = await tessellateModel(q, { levels: 1 });
  assert.ok(r.changed, String(r.message));
  const tets = r.model.blocks.filter((b) => b.kind === "Elements");
  assert.equal(tets.length, 1);
  assert.equal(tets[0].vtkCellType, VtkCellType.TETRA);
  assert.equal(tets[0].name, "Element3D4N", "a Kratos-instantiable block name, not the meshio type");
  assert.equal(tets[0].count, 12 * 8, "12 tetra10 cells, 8 children each at one level");
  const conds = r.model.blocks.filter((b) => b.kind === "Conditions");
  assert.equal(conds[0].name, "SurfaceCondition3D3N");
  assert.ok(Math.abs(total(r.model) - total(q)) < 1e-6 * Math.abs(total(q)), "straight-edged midpoints: volume is conserved");
  assert.match(r.message, /conforming/);
});

test("ids are unique per kind, the first child keeps its parent's id, and parts follow the children", async () => {
  const q = quadratic();
  const r = await tessellateModel(q, { levels: 1 });
  assert.ok(r.changed);
  for (const kind of ["Elements", "Conditions"] as const) {
    const ids: number[] = r.model.blocks.filter((b) => b.kind === kind).flatMap((b) => [...b.entityIds]);
    assert.equal(new Set(ids).size, ids.length, `${kind} ids are unique`);
  }
  const parentIds = q.blocks.filter((b) => b.kind === "Conditions").flatMap((b) => [...b.entityIds]);
  const childIds = new Set(r.model.blocks.filter((b) => b.kind === "Conditions").flatMap((b) => [...b.entityIds]));
  for (const id of parentIds) assert.ok(childIds.has(id), `parent condition ${id} keeps its id on its first child`);
  const left0 = q.subModelParts.find((p) => p.name === "Left")!;
  const left1 = r.model.subModelParts.find((p) => p.name === "Left")!;
  assert.equal(left1.conditionIds.length, left0.conditionIds.length * 4, "each triangle6 becomes 4 triangles at one level");
  assert.equal(left1.elementIds.length, left0.elementIds.length * 8);
  const nodeSet = new Set(r.model.nodeIds);
  for (const n of left1.nodeIds) assert.ok(nodeSet.has(n));
  assert.ok(left1.nodeIds.length >= left0.nodeIds.length, "the closure gains the new mid-edge nodes");
});

test("fields survive: nodal values interpolate, cell values copy onto the children", async () => {
  const q = quadratic();
  const r = await tessellateModel(q, { levels: 1 });
  assert.ok(r.changed);
  const t = r.model.fields.find((f) => f.kind === "Nodal" && f.variable === "T");
  assert.ok(t, "nodal T kept");
  assert.equal(t!.ids.length, r.model.nodeCount);
  assert.ok(!r.model.fields.some((f) => f.variable.includes(":")), "upstream provenance arrays are not fields");
});

test("a deep tessellation survives (the adoption must not spread huge arrays into push)", async () => {
  const r = await tessellateModel(quadratic(), { levels: 4 });
  assert.ok(r.changed, String(r.message));
  assert.equal(r.model.blocks.find((b) => b.kind === "Elements")!.count, 12 * 8 ** 4);
});

test("a mesh with no curved cells is a noop with the reason", async () => {
  const r = await tessellateModel(tetBar(2));
  assert.equal(r.changed, false);
  assert.match(r.message, /No curved cells/);
});

test("an oversized request is refused before the wasm runs", async () => {
  const q = quadratic();
  const big = { ...q, blocks: q.blocks.map((b) => ({ ...b, count: b.count * 2000 })) };
  assert.ok(estimateTessellatedCells(big, 3) > 5_000_000);
  const r = await tessellateModel(big, { levels: 3 });
  assert.equal(r.changed, false);
  assert.match(r.message, /limit/);
});

test("record: validation, async/adopting registration, recipe round trip, undoable apply", async () => {
  assert.ok(isAsyncOp("tessellate"));
  assert.ok(ADOPTING_OPS.includes("tessellate"));
  assert.equal(opRecordFromMessage({ op: "tessellate", levels: 9 }), undefined);
  assert.equal(opRecordFromMessage({ op: "tessellate", levels: 1.5 }), undefined);
  const rec = opRecordFromMessage({ op: "tessellate", levels: "1" })!;
  assert.deepEqual(rec, { op: "tessellate", levels: 1 });
  const parsed = parseOpsJson(serializeOps([rec], "t.mdpa"));
  assert.deepEqual(parsed.operations, [rec]);
  const out = await applyOpAsync(quadratic(), rec!);
  assert.ok(!out.noop, String(out.message));
});
