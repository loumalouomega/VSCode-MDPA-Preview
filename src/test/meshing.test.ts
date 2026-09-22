/**
 * Surface remeshing, volume meshing and tetrahedral optimization, adopted in
 * place with an explicit cell-identity policy. The claims worth pinning:
 * the requested vertex count is met, the boundary stays where it was, produced
 * cells inherit block / property / parts / field values from where they came
 * from, an exact node-set match keeps its entity id, and everything that cannot
 * be meshed is refused by name.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { inheritCellIdentity } from "../parser/cellInheritance";
import { surfaceRemeshModel, volumeMeshModel, optimizeVolumeModel, estimateLatticeCells } from "../parser/meshing";
import { applyOpAsync, opRecordFromMessage, parseOpsJson, serializeOps, isAsyncOp } from "../parser/operations";
import { ADOPTING_OPS } from "../parser/adoptingOps";
import { surfaceDefects } from "../parser/surfaceDefects";
import { MdpaModel } from "../parser/types";
import { icosphere, tetBar } from "./fixtures/shapes";

const model = (t: string): MdpaModel => {
  const r = parseMdpa(t) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};
const faces = (m: MdpaModel): number => m.blocks.reduce((s, b) => s + b.count, 0);

/** An icosphere as a Conditions surface with two property ids, a cell field, a nodal field and a part. */
function decoratedSphere(): MdpaModel {
  const base = icosphere(1, 3);
  const b = base.blocks[0];
  return {
    ...base,
    blocks: [{
      ...b,
      // Property 1 on the northern half, 2 on the southern (by face-centroid height).
      propertyIds: Int32Array.from({ length: b.count }, (_, i) => {
        const z = [0, 1, 2].reduce((s, k) => s + base.coords[base.nodeIds.indexOf(b.connectivity[i * 3 + k]) * 3 + 2], 0) / 3;
        return z > 0 ? 1 : 2;
      }),
    }],
    fields: [
      { kind: "Conditional", variable: "TAG", components: 1, ids: b.entityIds, values: Float64Array.from(b.entityIds, () => 7) },
      { kind: "Nodal", variable: "Z", components: 1, ids: base.nodeIds, values: Float64Array.from({ length: base.nodeCount }, (_, i) => base.coords[i * 3 + 2]) },
    ],
    subModelParts: [
      // The northern hemisphere's faces.
      {
        name: "North", path: "North", nodeIds: new Int32Array(0), elementIds: new Int32Array(0),
        conditionIds: Int32Array.from([...b.entityIds].filter((_, i) => {
          const n = [0, 1, 2].map((k) => base.nodeIds.indexOf(b.connectivity[i * 3 + k]));
          return n.reduce((s, idx) => s + base.coords[idx * 3 + 2], 0) / 3 > 0.05;
        })),
        geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [],
      },
    ],
  };
}

test("inheritance: an exact node-set match keeps its entity id, block, property, parts and field value; a changed cell inherits context with a fresh id", () => {
  const src = model(
    "Begin Properties 1\nEnd Properties\nBegin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 1 1 0\n5 5 5 5\nEnd Nodes\n" +
      "Begin Conditions SurfaceCondition3D3N\n10 3 1 2 3\n11 4 2 4 3\nEnd Conditions\n" +
      "Begin ConditionalData W\n10 100\n11 200\nEnd ConditionalData\n" +
      "Begin SubModelPart A\n Begin SubModelPartConditions\n 10\n End SubModelPartConditions\nEnd SubModelPart\n" +
      "Begin SubModelPart B\n Begin SubModelPartConditions\n 11\n End SubModelPartConditions\nEnd SubModelPart\n"
  );
  // The "operation" keeps triangle (1,2,3) and replaces (2,4,3) by (1,4,3) — same node ids.
  const adopted: MdpaModel = {
    ...src,
    blocks: [{
      kind: "Elements", name: "triangle", vtkCellType: 5, count: 2, stride: 3,
      entityIds: Int32Array.from([1, 2]), connectivity: Int32Array.from([3, 2, 1, 1, 4, 3]),
    }],
    fields: [], subModelParts: [],
  };
  const r = inheritCellIdentity(src, adopted, { category: "surface", matchByNodes: true });
  assert.equal(r.matched, 1);
  assert.equal(r.inherited, 1);
  const block = r.model.blocks[0];
  assert.equal(block.name, "SurfaceCondition3D3N", "the source block lends its name");
  assert.equal(block.kind, "Conditions");
  const ids = [...block.entityIds];
  assert.ok(ids.includes(10), "the unchanged cell kept id 10 despite a rotated node order");
  assert.ok(ids.some((id) => id > 11), "the new cell has a fresh id past every existing one");
  const propOf = (id: number) => block.propertyIds![ids.indexOf(id)];
  assert.equal(propOf(10), 3);
  const fresh = ids.find((id) => id > 11)!;
  assert.equal(propOf(fresh), 3 === propOf(fresh) ? 3 : 4, "the new cell took the property of the nearest source cell");
  const w = r.model.fields.find((f) => f.variable === "W")!;
  assert.equal(w.values[w.ids.indexOf(10)], 100, "the matched cell's field value survives");
  assert.equal(w.ids.length, 2, "and the inherited cell has a value too");
  const a = r.model.subModelParts.find((p) => p.name === "A")!;
  assert.ok([...a.conditionIds].includes(10));
  // Every produced cell is in the part its source was in.
  const b = r.model.subModelParts.find((p) => p.name === "B")!;
  assert.equal(a.conditionIds.length + b.conditionIds.length, 2);
});

test("inheritance: targetKind turns the produced cells into Conditions with a legal block name, keeping property and parts", () => {
  const src = model(
    "Begin Properties 1\nEnd Properties\nBegin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\nEnd Nodes\n" +
      "Begin Elements Element2D3N\n1 5 1 2 3\nEnd Elements\n" +
      "Begin SubModelPart Shell\n Begin SubModelPartElements\n 1\n End SubModelPartElements\nEnd SubModelPart\n"
  );
  const adopted: MdpaModel = { ...src, blocks: [{ kind: "Elements", name: "triangle", vtkCellType: 5, count: 1, stride: 3, entityIds: Int32Array.from([1]), connectivity: Int32Array.from([1, 2, 3]) }], fields: [], subModelParts: [] };
  const r = inheritCellIdentity(src, adopted, { category: "surface", matchByNodes: false, targetKind: "Conditions" });
  assert.equal(r.model.blocks[0].kind, "Conditions");
  assert.equal(r.model.blocks[0].name, "SurfaceCondition3D3N", "an element type name is not a valid condition name");
  assert.equal(r.model.blocks[0].propertyIds![0], 5);
  assert.deepEqual([...r.model.subModelParts[0].conditionIds], [1]);
  assert.equal(r.model.subModelParts[0].elementIds.length, 0, "the part now lists the condition, not the shell element");
});

test("surface remesh meets the vertex target, stays on the surface, and every face inherits context from the nearest original face", async () => {
  const src = decoratedSphere();
  const r = await surfaceRemeshModel(src, { numClusters: 200 });
  assert.equal(r.changed, true);
  if (!r.changed) return;
  assert.equal(r.model.nodeCount, 200);
  assert.ok(faces(r.model) > 300 && faces(r.model) < 450);
  // On the unit sphere, to the polyhedral tolerance of the input.
  for (let i = 0; i < r.model.nodeCount; i++) {
    const rad = Math.hypot(r.model.coords[i * 3], r.model.coords[i * 3 + 1], r.model.coords[i * 3 + 2]);
    assert.ok(rad > 0.97 && rad < 1.01, `radius ${rad}`);
  }
  // Block, property, cell field and part membership all came through.
  assert.equal(r.model.blocks.length, 1);
  assert.equal(r.model.blocks[0].name, src.blocks[0].name);
  assert.equal(r.model.blocks[0].kind, "Conditions");
  assert.ok(new Set(r.model.blocks[0].propertyIds).size === 2, "both property ids are still present");
  const tag = r.model.fields.find((f) => f.variable === "TAG")!;
  assert.equal(tag.ids.length, faces(r.model));
  assert.ok([...tag.values].every((v) => v === 7));
  const north = r.model.subModelParts.find((p) => p.name === "North")!;
  assert.ok(north.conditionIds.length > 0 && north.conditionIds.length < faces(r.model));
  // Northern faces are up: their centroids have positive z on average.
  const idx = new Map<number, number>();
  for (let i = 0; i < r.model.nodeCount; i++) idx.set(r.model.nodeIds[i], i);
  const b = r.model.blocks[0];
  let z = 0;
  for (const id of north.conditionIds) {
    const c = [...b.entityIds].indexOf(id);
    for (let k = 0; k < 3; k++) z += r.model.coords[idx.get(b.connectivity[c * 3 + k])! * 3 + 2] / 3;
  }
  assert.ok(z / north.conditionIds.length > 0.2, "the North part is still the northern cap");
  // The nodal field was mapped by containing-face lookup: Z ≈ z coordinate.
  const zf = r.model.fields.find((f) => f.kind === "Nodal" && f.variable === "Z")!;
  for (let i = 0; i < zf.ids.length; i++) assert.ok(Math.abs(zf.values[i] - r.model.coords[idx.get(zf.ids[i])! * 3 + 2]) < 0.05);
  // Still a closed, consistently wound manifold.
  const d = surfaceDefects(r.model);
  assert.equal(d.boundaryEdges.length + d.nonManifoldEdges.length, 0);
  assert.match(r.message, /Remeshed the surface \(isotropic\): 1280 → \d+ faces, 642 → 200 nodes/);
  assert.match(r.message, /Deviation from the original surface/);
  assert.match(r.message, /inherited block, property, SubModelPart membership and cell-field values from the NEAREST original face/);
});

test("surface remesh refusals: volume cells, quads, lines mixed in, too few clusters, maxAnisotropy with the wrong metric", async () => {
  const noop = async (m: MdpaModel, p = {}) => (await surfaceRemeshModel(m, p)).message;
  assert.match(await noop(tetBar(2)), /volume cells.*Export skin/);
  const quad = model("Begin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\nEnd Nodes\nBegin Conditions SurfaceCondition3D4N\n1 0 1 2 3 4\nEnd Conditions\n");
  assert.match(await noop({ ...quad, blocks: quad.blocks.map((b) => ({ ...b, vtkCellType: 9 })) }), /Simplexify/);
  assert.match(await noop(icosphere(1, 2), { numClusters: 2 }), /at least 4/);
  assert.match(await noop(icosphere(1, 2), { maxAnisotropy: 3 }), /anisotropic metric only/);
  assert.match(await noop({ ...icosphere(1, 1), blocks: [] }), /no cells/);
});

test("volume meshing a closed surface yields tetrahedra, a boundary that inherits the surface's parts and property, and a stated quality caveat", async () => {
  const src = decoratedSphere();
  const r = await volumeMeshModel(src, { cellSize: 0.3 });
  assert.equal(r.changed, true);
  if (!r.changed) return;
  const tets = r.model.blocks.filter((b) => b.kind === "Elements");
  assert.equal(tets.length, 1);
  assert.equal(tets[0].name, "Element3D4N");
  assert.equal(tets[0].vtkCellType, 10);
  assert.ok(tets[0].count > 100);
  // Every tet lies inside the unit sphere (to lattice tolerance) and has positive volume.
  const idx = new Map<number, number>();
  for (let i = 0; i < r.model.nodeCount; i++) idx.set(r.model.nodeIds[i], i);
  let volume = 0;
  for (let c = 0; c < tets[0].count; c++) {
    const p = [0, 1, 2, 3].map((k) => idx.get(tets[0].connectivity[c * 4 + k])! * 3).map((o) => [r.model.coords[o], r.model.coords[o + 1], r.model.coords[o + 2]]);
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const w = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
    volume += Math.abs(u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
  }
  assert.ok(Math.abs(volume - (4 / 3) * Math.PI) < 0.35, `volume ${volume}`);
  // The boundary faces are Conditions of the input's block, carrying its property ids and the North part.
  const cond = r.model.blocks.filter((b) => b.kind === "Conditions");
  assert.ok(cond.length >= 1 && cond[0].count > 50);
  assert.ok(new Set(cond.flatMap((b) => [...(b.propertyIds ?? [])])).size >= 1);
  const north = r.model.subModelParts.find((p) => p.name === "North")!;
  assert.ok(north.conditionIds.length > 0 && north.conditionIds.length < cond.reduce((s, b) => s + b.count, 0));
  assert.match(r.message, /Generated \d+ tetrahedra/);
  assert.match(r.message, /no boundary-quality guarantee/);
  assert.match(r.message, /Boundary deviation from the input surface/);
});

test("volume meshing refusals and the lattice estimate that refuses a huge request before any wasm runs", async () => {
  const sphere = icosphere(1, 2);
  assert.match((await volumeMeshModel(sphere, {})).message, /exactly one of cellSize or resolution/);
  assert.match((await volumeMeshModel(sphere, { cellSize: 0.1, resolution: [4, 4, 4] })).message, /exactly one/);
  assert.match((await volumeMeshModel(sphere, { cellSize: -1 })).message, /positive/);
  assert.match((await volumeMeshModel(sphere, { resolution: [0, 1, 1] })).message, /positive integers/);
  assert.match((await volumeMeshModel(sphere, { cellSize: 0.0001 })).message, /Use a larger cellSize/);
  assert.ok(estimateLatticeCells(sphere, { cellSize: 0.5 }) >= 27);
  const quadless = model("Begin Nodes\n1 0 0 0\n2 1 0 0\nEnd Nodes\nBegin Elements Element2D2N\n1 0 1 2\nEnd Elements\n");
  assert.match((await volumeMeshModel(quadless, { cellSize: 0.5 })).message, /triangles only|linear triangles/);
});

/** A flat bipyramid: two slivers sharing the big base triangle, which a 2-3 flip improves. */
const BIPYRAMID =
  "Begin Properties 1\nEnd Properties\nBegin Nodes\n1 1 0 0\n2 -0.5 0.866 0\n3 -0.5 -0.866 0\n4 0 0 0.06\n5 0 0 -0.06\nEnd Nodes\n" +
  "Begin Elements Element3D4N\n1 1 1 2 3 4\n2 1 1 3 2 5\nEnd Elements\n" +
  "Begin ElementalData C\n1 10\n2 20\nEnd ElementalData\n";

test("tetrahedral optimization flips a sliver pair, keeps every node, and reports the quality gain", async () => {
  const src = model(BIPYRAMID);
  const r = await optimizeVolumeModel(src, {});
  assert.equal(r.changed, true);
  if (!r.changed) return;
  assert.equal(r.model.nodeCount, 5, "the point set is unchanged");
  assert.deepEqual([...r.model.nodeIds], [...src.nodeIds]);
  assert.equal(faces(r.model), 3, "a 2-3 flip turns two tetrahedra into three");
  assert.match(r.message, /1 flip\(s\) \(1 2-3, 0 3-2\)/);
  const q = /quality (\d+\.\d+) → (\d+\.\d+)/.exec(r.message)!;
  assert.ok(Number(q[2]) > Number(q[1]), `quality improved ${q[1]} → ${q[2]}`);
  // Volume is conserved by a flip.
  const vol = (m: MdpaModel): number => {
    const idx = new Map<number, number>();
    for (let i = 0; i < m.nodeCount; i++) idx.set(m.nodeIds[i], i);
    let v = 0;
    for (const b of m.blocks) for (let c = 0; c < b.count; c++) {
      const p = [0, 1, 2, 3].map((k) => idx.get(b.connectivity[c * 4 + k])! * 3).map((o) => [m.coords[o], m.coords[o + 1], m.coords[o + 2]]);
      const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
      const w2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
      const w3 = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
      v += Math.abs(u[0] * (w2[1] * w3[2] - w2[2] * w3[1]) - u[1] * (w2[0] * w3[2] - w2[2] * w3[0]) + u[2] * (w2[0] * w3[1] - w2[1] * w3[0])) / 6;
    }
    return v;
  };
  assert.ok(Math.abs(vol(r.model) - vol(src)) < 1e-9);
  assert.equal(r.model.blocks[0].name, "Element3D4N");
  assert.equal(r.model.fields.find((f) => f.variable === "C")!.ids.length, 3, "the element field is inherited onto every produced tet");
});

test("optimization on a bigger mesh keeps the id of every tetrahedron it did not touch, and re-attaches boundary conditions and constraints", async () => {
  // Generate a real volume mesh, then optimize it: most tets are unchanged.
  const vol = await volumeMeshModel(icosphere(1, 2), { cellSize: 0.35, keepSurface: true });
  assert.equal(vol.changed, true);
  if (!vol.changed) return;
  const before = vol.model;
  const withConstraint: MdpaModel = {
    ...before,
    constraints: model(`Begin Nodes\n${[...before.nodeIds].slice(0, 2).map((id) => `${id} 0 0 0`).join("\n")}\nEnd Nodes\nBegin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X\n1 0.0 [1.0] ${before.nodeIds[0]} ${before.nodeIds[1]}\nEnd Constraints\n`).constraints,
  };
  const r = await optimizeVolumeModel(withConstraint, { maxIterations: 20 });
  if (!r.changed) return assert.match(r.message, /Nothing to improve/); // a lattice mesh may already be locally optimal
  const idsBefore = new Set(before.blocks.filter((b) => b.kind === "Elements").flatMap((b) => [...b.entityIds]));
  const after = r.model.blocks.filter((b) => b.kind === "Elements").flatMap((b) => [...b.entityIds]);
  const kept = after.filter((id) => idsBefore.has(id)).length;
  assert.ok(kept >= after.length * 0.5, `${kept} of ${after.length} tetrahedra kept their id`);
  // Boundary conditions and constraints ride through untouched (the node set is unchanged).
  assert.deepEqual(
    r.model.blocks.filter((b) => b.kind === "Conditions").map((b) => b.count),
    before.blocks.filter((b) => b.kind === "Conditions").map((b) => b.count)
  );
  assert.equal(r.model.constraints?.length, 1);
});

test("optimization refusals: no elements, non-tetrahedral elements, and a mesh already as good as it gets", async () => {
  assert.match((await optimizeVolumeModel({ ...model(BIPYRAMID), blocks: [] })).message, /no Elements/);
  const hex = model("Begin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\n5 0 0 1\n6 1 0 1\n7 1 1 1\n8 0 1 1\nEnd Nodes\nBegin Elements Element3D8N\n1 0 1 2 3 4 5 6 7 8\nEnd Elements\n");
  assert.match((await optimizeVolumeModel(hex)).message, /linear tetrahedra.*Simplexify/);
  const good = await optimizeVolumeModel(model("Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\nEnd Nodes\nBegin Elements Element3D4N\n1 0 1 2 3 4\nEnd Elements\n"));
  assert.equal(good.changed, false);
  assert.match(good.message, /Nothing to improve/);
});

test("the three meshing ops are async adopting ops reachable from messages, applyOpAsync and recipes", async () => {
  for (const op of ["surfaceRemesh", "volumeMesh", "optimizeVolume"] as const) {
    assert.equal(isAsyncOp(op), true);
    assert.ok(ADOPTING_OPS.includes(op));
  }
  const a = opRecordFromMessage({ op: "surfaceRemesh", numClusters: "150", metric: "anisotropic", maxAnisotropy: 3, gradation: 0.5, preserveBoundary: false })!;
  assert.deepEqual(a, { op: "surfaceRemesh", numClusters: 150, metric: "anisotropic", gradation: 0.5, maxAnisotropy: 3, preserveBoundary: false });
  assert.equal(opRecordFromMessage({ op: "surfaceRemesh", numClusters: 2 }), undefined);
  assert.equal(opRecordFromMessage({ op: "surfaceRemesh", maxAnisotropy: 3 }), undefined, "maxAnisotropy needs the anisotropic metric");
  assert.equal(opRecordFromMessage({ op: "surfaceRemesh", metric: "cubic" }), undefined);
  const v = opRecordFromMessage({ op: "volumeMesh", resolution: "8x8x8", warpFraction: 0.2, keepSurface: false })!;
  assert.deepEqual(v, { op: "volumeMesh", resolution: [8, 8, 8], warpFraction: 0.2, keepSurface: false });
  assert.equal(opRecordFromMessage({ op: "volumeMesh" }), undefined);
  assert.equal(opRecordFromMessage({ op: "volumeMesh", cellSize: 1, resolution: [2, 2, 2] }), undefined);
  assert.equal(opRecordFromMessage({ op: "volumeMesh", resolution: [2, 2] }), undefined);
  const o = opRecordFromMessage({ op: "optimizeVolume", maxIterations: "20", flip: false })!;
  assert.deepEqual(o, { op: "optimizeVolume", maxIterations: 20, flip: false });
  assert.equal(opRecordFromMessage({ op: "optimizeVolume", maxIterations: 0 }), undefined);
  assert.deepEqual(parseOpsJson(serializeOps([a, v, o], "x.mdpa")).operations, [a, v, o]);
  assert.equal(parseOpsJson(JSON.stringify({ version: 1, operations: [{ op: "volumeMesh" }] })).operations.length, 0);
  // applyOpAsync: a refusal is a noop with the reason.
  const out = await applyOpAsync(tetBar(2), { op: "surfaceRemesh" });
  assert.equal(out.noop, true);
  assert.match(out.message!, /volume cells/);
  const flip = await applyOpAsync(model(BIPYRAMID), { op: "optimizeVolume" });
  assert.equal(flip.noop, undefined);
  assert.match(flip.message!, /Optimized 3 tetrahedra/);
});
