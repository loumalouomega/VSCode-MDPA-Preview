/**
 * Surface decimation over the real WASM. The properties that matter: the target
 * is met, survivors keep their identity (entity ids, property ids, cell-field
 * values, block names, SubModelPart membership), an open patch keeps its outline
 * exactly, the geometry stays close to the source, and everything upstream
 * cannot decimate is refused by name before the wasm runs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { decimateModel } from "../parser/decimate";
import { deriveMesh } from "../parser/deriveMesh";
import { parseMdpa } from "../parser/mdpaParser";
import { surfaceDefects } from "../parser/surfaceDefects";
import { MdpaModel } from "../parser/types";
import { icosphere, tetBar } from "./fixtures/shapes";

const model = (t: string): MdpaModel => {
  const r = parseMdpa(t) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

const faces = (m: MdpaModel): number => m.blocks.reduce((s, b) => s + b.count, 0);

/** icosphere with an elemental field, a property id per face, a part and two blocks. */
function decorated(): MdpaModel {
  const base = icosphere(1, 3); // 642 nodes, 1280 faces
  const b = base.blocks[0];
  const half = b.count / 2;
  const mk = (name: string, from: number, to: number) => ({
    ...b,
    name,
    count: to - from,
    entityIds: b.entityIds.slice(from, to),
    connectivity: b.connectivity.slice(from * 3, to * 3),
    propertyIds: Int32Array.from({ length: to - from }, (_, i) => 1 + ((from + i) % 3)),
  });
  return {
    ...base,
    blocks: [mk("SurfaceCondition3D3N", 0, half), mk("SurfaceCondition3D3N_b", half, b.count)],
    fields: [
      { kind: "Conditional", variable: "TAG", components: 1, ids: b.entityIds, values: Float64Array.from(b.entityIds, (id) => id * 10) },
      { kind: "Nodal", variable: "T", components: 1, ids: base.nodeIds, values: Float64Array.from(base.nodeIds, (id) => id) },
    ],
    subModelParts: [
      { name: "Cap", path: "Cap", nodeIds: Int32Array.from(base.nodeIds.slice(0, 40)), elementIds: new Int32Array(0), conditionIds: Int32Array.from(b.entityIds.slice(0, 100)), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [] },
    ],
  };
}

test("a ratio is met to within one collapse, and the surface stays close to the sphere", async () => {
  const src = decorated();
  const r = await decimateModel(src, { ratio: 0.25 });
  assert.equal(r.facesBefore, 1280);
  assert.ok(Math.abs(r.facesAfter - 320) <= 2, `faces after ${r.facesAfter}`);
  assert.ok(Math.abs(r.reduction - 0.75) < 0.01);
  assert.equal(faces(r.model), r.facesAfter);
  // Geometric fidelity: every node stays on (or very near) the unit sphere.
  for (let i = 0; i < r.model.nodeCount; i++) {
    const rad = Math.hypot(r.model.coords[i * 3], r.model.coords[i * 3 + 1], r.model.coords[i * 3 + 2]);
    assert.ok(rad > 0.9 && rad < 1.05, `radius ${rad}`);
  }
  assert.ok(r.relativeError < 0.05, `error ${r.relativeError}`);
  // Still a closed, consistently wound surface.
  const d = surfaceDefects(r.model);
  assert.equal(d.boundaryEdges.length + d.nonManifoldEdges.length + d.inconsistentFaces.length, 0);
});

test("targetFaces and maxError are alternative criteria; exactly one is required", async () => {
  const src = decorated();
  assert.equal((await decimateModel(src, { targetFaces: 200 })).facesAfter, 200);
  const err = await decimateModel(src, { maxError: 1e-3 });
  assert.ok(err.facesAfter < 1280 && err.facesAfter > 20);
  assert.ok(err.maxErrorApplied <= 1e-3 * 1.001);
  await assert.rejects(decimateModel(src, {}), /exactly one/);
  await assert.rejects(decimateModel(src, { ratio: 0.5, targetFaces: 100 }), /exactly one/);
  await assert.rejects(decimateModel(src, { ratio: 1.5 }), /\(0, 1\]/);
  await assert.rejects(decimateModel(src, { targetFaces: 0 }), /positive integer/);
  await assert.rejects(decimateModel(src, { maxError: -1 }), /positive/);
});

test("survivors keep their identity: entity ids, property ids, block names, cell-field values and part membership", async () => {
  const src = decorated();
  const r = await decimateModel(src, { ratio: 0.5 });
  assert.deepEqual(r.model.blocks.map((b) => b.name), ["SurfaceCondition3D3N", "SurfaceCondition3D3N_b"], "blocks stay 1:1");
  const srcIndex = new Map<string, { prop: number }>();
  for (const b of src.blocks) for (let c = 0; c < b.count; c++) srcIndex.set(`${b.name}:${b.entityIds[c]}`, { prop: b.propertyIds![c] });
  let n = 0;
  for (const b of r.model.blocks) {
    for (let c = 0; c < b.count; c++) {
      const s = srcIndex.get(`${b.name}:${b.entityIds[c]}`);
      assert.ok(s, "a survivor exists in the source under the same id and block");
      assert.equal(b.propertyIds![c], s!.prop, "property id kept");
      n++;
    }
  }
  assert.equal(n, r.facesAfter);
  // The cell field is exact (no averaging): TAG = 10 * id on every survivor.
  const tag = r.model.fields.find((f) => f.variable === "TAG")!;
  assert.equal(tag.ids.length, r.facesAfter);
  for (let i = 0; i < tag.ids.length; i++) assert.equal(tag.values[i], tag.ids[i] * 10);
  // Part membership narrowed to survivors.
  const cap = r.model.subModelParts[0];
  const survivors = new Set(r.model.blocks.flatMap((b) => [...b.entityIds]));
  assert.ok(cap.conditionIds.length > 0 && cap.conditionIds.every((id) => survivors.has(id)));
  assert.ok(cap.conditionIds.length < 100);
  // Node ids: every output node has a unique id that existed in the source.
  assert.equal(new Set(r.model.nodeIds).size, r.model.nodeCount);
  assert.ok([...r.model.nodeIds].every((id) => src.nodeIds.includes(id)));
  // Every connectivity entry names an output node.
  const ids = new Set(r.model.nodeIds);
  for (const b of r.model.blocks) assert.ok([...b.connectivity].every((id) => ids.has(id)));
  // The source is untouched.
  assert.equal(faces(src), 1280);
});

test("nodal fields follow the collapse: exact at nodes that were not merged", async () => {
  const src = decorated();
  const r = await decimateModel(src, { ratio: 0.5, placement: "endpoint" });
  const t = r.model.fields.find((f) => f.kind === "Nodal" && f.variable === "T")!;
  assert.equal(t.ids.length, r.model.nodeCount);
  // T equals the node id in the source, so a node that kept its id and was not blended reads exactly that id.
  let exact = 0;
  for (let i = 0; i < t.ids.length; i++) if (t.values[i] === t.ids[i]) exact++;
  assert.ok(exact > r.model.nodeCount / 4, `${exact} of ${r.model.nodeCount} nodes read their own id`);
  assert.ok([...t.values].every(Number.isFinite));
});

test("an open patch keeps its outline exactly (preserveBoundary), and frozenPart pins a part's nodes", async () => {
  const open = icosphere(1, 3, false, (p) => p[2] >= 0); // a hemisphere
  const before = surfaceDefects(open).boundaryEdges;
  const r = await decimateModel(open, { ratio: 0.3 });
  const after = surfaceDefects(r.model).boundaryEdges;
  assert.equal(after.length, before.length, "the rim has the same number of edges");
  const rimBefore = new Set(before.flat());
  const idx = new Map<number, number>();
  for (let i = 0; i < r.model.nodeCount; i++) idx.set(r.model.nodeIds[i], i);
  const srcIdx = new Map<number, number>();
  for (let i = 0; i < open.nodeCount; i++) srcIdx.set(open.nodeIds[i], i);
  for (const id of rimBefore) {
    const a = idx.get(id)!;
    const b = srcIdx.get(id)!;
    for (let k = 0; k < 3; k++) assert.equal(r.model.coords[a * 3 + k], open.coords[b * 3 + k], `rim node ${id} did not move`);
  }
  // Freeze the first 40 nodes of a closed sphere.
  const src = decorated();
  const frozen = await decimateModel(src, { ratio: 0.4, frozenPart: "Cap" });
  const srcI = new Map<number, number>();
  for (let i = 0; i < src.nodeCount; i++) srcI.set(src.nodeIds[i], i);
  const outI = new Map<number, number>();
  for (let i = 0; i < frozen.model.nodeCount; i++) outI.set(frozen.model.nodeIds[i], i);
  for (const id of src.subModelParts[0].nodeIds) {
    const o = outI.get(id);
    assert.notEqual(o, undefined, `frozen node ${id} survives`);
    for (let k = 0; k < 3; k++) assert.equal(frozen.model.coords[o! * 3 + k], src.coords[srcI.get(id)! * 3 + k]);
  }
  await assert.rejects(decimateModel(src, { ratio: 0.5, frozenPart: "Nope" }), /not found/);
});

test("constraints are dropped with a stated reason", async () => {
  const src = decorated();
  const withC: MdpaModel = {
    ...src,
    constraints: parseMdpa("Begin Nodes\n1 0 0 0\n2 1 0 0\nEnd Nodes\nBegin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X\n1 0.0 [1.0] 1 2\nEnd Constraints\n").constraints,
  };
  const r = await decimateModel(withC, { ratio: 0.5 });
  assert.equal(r.droppedConstraints, 1);
  assert.equal(r.model.constraints, undefined);
  assert.ok(r.warnings.some((w) => /constraint row\(s\) were dropped/.test(w)));
});

test("everything upstream cannot decimate is refused by name before the wasm runs", async () => {
  await assert.rejects(decimateModel(tetBar(2), { ratio: 0.5 }), /volume cells.*Export skin/);
  const quad = model("Begin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\nEnd Nodes\nBegin Conditions SurfaceCondition3D4N\n1 0 1 2 3 4\nEnd Conditions\n");
  await assert.rejects(decimateModel({ ...quad, blocks: quad.blocks.map((b) => ({ ...b, vtkCellType: 9 })) }, { ratio: 0.5 }), /quadrilateral.*Simplexify/);
  const withLine = decorated();
  const lineBlock = { ...withLine.blocks[0], name: "Line", vtkCellType: 3, stride: 2, count: 1, entityIds: Int32Array.from([999]), connectivity: Int32Array.from([1, 2]), propertyIds: undefined };
  await assert.rejects(decimateModel({ ...withLine, blocks: [...withLine.blocks, lineBlock] }, { ratio: 0.5 }), /line or point/);
  await assert.rejects(decimateModel({ ...withLine, blocks: [] }, { ratio: 0.5 }), /no cells/);
});

test("decimate is a derived kind with a summary that states the reduction and the error", async () => {
  const r = await deriveMesh(decorated(), { kind: "decimate", ratio: 0.5 });
  assert.match(r.summary, /Decimated 1280 → 6\d\d faces \(5\d\.?\d*% removed\)/);
  assert.match(r.summary, /of the bounding-box diagonal/);
  assert.equal(r.suffix, "decimated");
  assert.equal(faces(r.model), 640);
});

// ---- preview level of detail -----------------------------------------------------

import { lodSurface, lodRatio } from "../parser/lodSurface";
import { runMeshAnalysis } from "../meshAnalysis";

test("the LOD surface is a light triangle soup drawn from the mesh's own faces, indices in range, mesh untouched", async () => {
  const src = icosphere(1, 3);
  const lod = await lodSurface(src, 0.25);
  assert.equal(lod.sourceFaces, 1280);
  assert.ok(Math.abs(lod.keptFaces - 320) <= 2);
  assert.equal(lod.triangles.length, lod.keptFaces * 3);
  assert.equal(lod.points.length % 3, 0);
  const n = lod.points.length / 3;
  assert.ok([...lod.triangles].every((i) => i >= 0 && i < n));
  assert.equal(lod.skin, false);
  assert.equal(src.blocks[0].count, 1280, "the source is untouched");
});

test("a solid is drawn by its boundary skin (quads split), and a mesh with no faces is refused by name", async () => {
  const lod = await lodSurface(tetBar(4), 0.5);
  assert.equal(lod.skin, true);
  assert.ok(lod.keptFaces > 0 && lod.keptFaces <= lod.sourceFaces);
  const lines = model("Begin Nodes\n1 0 0 0\n2 1 0 0\nEnd Nodes\nBegin Elements Element2D2N\n1 0 1 2\nEnd Elements\n");
  await assert.rejects(lodSurface(lines), /no surface faces/);
  assert.equal(lodRatio(1000), 0.5);
  assert.ok(lodRatio(1_000_000) <= 0.05 + 1e-9, "a big mesh is cut down to about 50 000 triangles");
});

test("the host serves it as a read-only meshAnalysis kind, and an unavailable mesh becomes a message", async () => {
  const ok = (await runMeshAnalysis({ type: "meshAnalysis", kind: "lod" }, icosphere(1, 2))) as { kind: string; lod?: { keptFaces: number } };
  assert.equal(ok.kind, "lod");
  assert.ok(ok.lod && ok.lod.keptFaces > 0);
  const lines = model("Begin Nodes\n1 0 0 0\n2 1 0 0\nEnd Nodes\nBegin Elements Element2D2N\n1 0 1 2\nEnd Elements\n");
  const bad = (await runMeshAnalysis({ type: "meshAnalysis", kind: "lod" }, lines)) as { lod?: unknown; message?: string };
  assert.equal(bad.lod, undefined);
  assert.match(bad.message!, /no surface faces/);
});
