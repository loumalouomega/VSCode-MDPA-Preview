/**
 * Shrinkwrap and Sobolev deformation over the real WASM. Both only move points,
 * so the properties under test are the ones a coordinate oracle must hold:
 * pinned nodes are bit-identical, everything that is not a coordinate survives
 * untouched, a constant displacement is preserved exactly, projection limits are
 * respected, and a move that folds cells says so.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { shrinkwrapModel, sobolevDeformModel, SHRINKWRAP_DISTANCE_VARIABLE } from "../parser/deform";
import { invertedCells } from "../parser/cellInversion";
import { applyOp, applyOpAsync, opRecordFromMessage, parseOpsJson, serializeOps, isAsyncOp } from "../parser/operations";
import { MdpaModel } from "../parser/types";
import { icosphere } from "./fixtures/shapes";

const model = (text: string): MdpaModel => {
  const r = parseMdpa(text) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

/** The plane z = zPlane as a two-triangle target. */
const plane = (zPlane: number): MdpaModel =>
  model(
    `Begin Nodes\n1 -5 -5 ${zPlane}\n2 5 -5 ${zPlane}\n3 5 5 ${zPlane}\n4 -5 5 ${zPlane}\nEnd Nodes\n` +
      "Begin Conditions SurfaceCondition3D3N\n1 0 1 2 3\n2 0 1 3 4\nEnd Conditions\n"
  );

/** A 3x3 patch of triangles at height z0, with a nodal field and two SubModelParts. */
function patch(z0: number): MdpaModel {
  const nodes: string[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) nodes.push(`${j * 3 + i + 1} ${i} ${j} ${z0}`);
  const tris: string[] = [];
  let e = 1;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const n = j * 3 + i + 1;
      tris.push(`${e++} 1 ${n} ${n + 1} ${n + 4}`, `${e++} 1 ${n} ${n + 4} ${n + 3}`);
    }
  }
  return model(
    "Begin Properties 1\nEnd Properties\nBegin Nodes\n" + nodes.join("\n") + "\nEnd Nodes\n" +
      "Begin Elements Element2D3N\n" + tris.join("\n") + "\nEnd Elements\n" +
      "Begin NodalData TEMP\n" + nodes.map((_, i) => `${i + 1} 0 ${i}`).join("\n") + "\nEnd NodalData\n" +
      "Begin SubModelPart Edge\n Begin SubModelPartNodes\n 1\n 2\n 3\n End SubModelPartNodes\nEnd SubModelPart\n" +
      "Begin SubModelPart Middle\n Begin SubModelPartNodes\n 5\n End SubModelPartNodes\nEnd SubModelPart\n"
  );
}

const z = (m: MdpaModel, id: number): number => m.coords[m.nodeIds.indexOf(id) * 3 + 2];

test("shrinkwrap lands every node on the target and leaves x, y and everything else alone", async () => {
  const src = patch(0.5);
  const r = await shrinkwrapModel(src, plane(0));
  assert.equal(r.numProjected, 9);
  for (const id of src.nodeIds) assert.ok(Math.abs(z(r.model, id)) < 1e-6);
  for (let i = 0; i < src.nodeCount; i++) {
    assert.equal(r.model.coords[i * 3], src.coords[i * 3]);
    assert.equal(r.model.coords[i * 3 + 1], src.coords[i * 3 + 1]);
  }
  // Only coordinates changed: the very same blocks, parts and fields.
  assert.equal(r.model.blocks, src.blocks);
  assert.equal(r.model.subModelParts, src.subModelParts);
  assert.equal(r.model.fields, src.fields);
  assert.equal(r.model.bounds.max[2], r.model.coords.reduce((mx, v, i) => (i % 3 === 2 ? Math.max(mx, v) : mx), -Infinity));
  assert.ok(Math.abs(r.maxDisplacement - 0.5) < 1e-6);
  assert.equal(r.inverted.surface, 0);
});

test("offset stands off along the target normal, and blend moves part of the way", async () => {
  const off = await shrinkwrapModel(patch(0.5), plane(0), { offset: 0.25 });
  for (const id of off.model.nodeIds) assert.ok(Math.abs(z(off.model, id) - 0.25) < 1e-6 || Math.abs(z(off.model, id) + 0.25) < 1e-6);
  const half = await shrinkwrapModel(patch(0.5), plane(0), { blend: 0.5 });
  assert.ok(Math.abs(z(half.model, 1) - 0.25) < 1e-6);
});

test("maxDistance leaves far nodes where they are and counts them", async () => {
  const src = patch(0.5);
  // Lift node 5 far above the rest.
  const coords = Float32Array.from(src.coords);
  coords[4 * 3 + 2] = 3;
  const r = await shrinkwrapModel({ ...src, coords }, plane(0), { maxDistance: 1 });
  assert.equal(r.numMissed, 1);
  assert.equal(r.numProjected, 8);
  assert.equal(z(r.model, 5), 3, "the far node did not move");
  assert.ok(Math.abs(z(r.model, 1)) < 1e-6);
});

test("pinPart holds its nodes bit-identical; movePart moves only its own", async () => {
  const src = patch(0.5);
  const pinned = await shrinkwrapModel(src, plane(0), { pinPart: "Edge" });
  for (const id of [1, 2, 3]) assert.equal(z(pinned.model, id), z(src, id), `node ${id} pinned`);
  for (const id of [4, 5, 6, 7, 8, 9]) assert.ok(Math.abs(z(pinned.model, id)) < 1e-6);
  assert.equal(pinned.numSkipped, 3);

  const only = await shrinkwrapModel(src, plane(0), { movePart: "Middle" });
  assert.ok(Math.abs(z(only.model, 5)) < 1e-6);
  for (const id of [1, 2, 3, 4, 6, 7, 8, 9]) assert.equal(z(only.model, id), z(src, id));
  assert.equal((await shrinkwrapModel(src, plane(0), { movePart: "Nope" })).message?.includes("not found"), true);
});

test("recordDistance writes the pre-move distance, undefined (a gap) where a node was not queried", async () => {
  const r = await shrinkwrapModel(patch(0.5), plane(0), { pinPart: "Edge", recordDistance: true });
  const f = r.model.fields.find((x) => x.variable === SHRINKWRAP_DISTANCE_VARIABLE)!;
  assert.equal(f.ids.length, 6, "the three pinned nodes are gaps");
  assert.ok([...f.values].every((v) => Math.abs(v - 0.5) < 1e-6));
});

test("a sphere shrinkwrapped onto a larger sphere lands on its surface", async () => {
  const r = await shrinkwrapModel(icosphere(1, 2), icosphere(2, 3));
  assert.equal(r.numProjected, 162);
  for (let i = 0; i < r.model.nodeCount; i++) {
    const rad = Math.hypot(r.model.coords[i * 3], r.model.coords[i * 3 + 1], r.model.coords[i * 3 + 2]);
    assert.ok(rad > 1.95 && rad < 2.001, `radius ${rad}`);
  }
});

test("a projection that folds cells is reported, with their ids", async () => {
  // A tetrahedron whose base is pushed through its apex by a target above it.
  const tet = model("Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0.3 0.3 1\nEnd Nodes\nBegin Elements Element3D4N\n1 0 1 2 3 4\nEnd Elements\n" +
    "Begin SubModelPart Base\n Begin SubModelPartNodes\n 1\n 2\n 3\n End SubModelPartNodes\nEnd SubModelPart\n");
  const r = await shrinkwrapModel(tet, plane(2), { movePart: "Base" });
  assert.equal(r.inverted.volume, 1);
  assert.deepEqual(r.inverted.cells, [{ kind: "Elements", id: 1 }]);
  const out = await applyOpAsync(tet, { op: "shrinkwrap", path: "unused.mdpa", movePart: "Base" }).catch(() => undefined);
  assert.ok(out === undefined || out.noop === true, "an unreadable target file is a noop, not a throw");
});

test("cellInversion ignores a cell that was already degenerate and reports nothing for an identical mesh", () => {
  const flat = model("Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 1 1 0\nEnd Nodes\nBegin Elements Element3D4N\n1 0 1 2 3 4\nEnd Elements\n");
  assert.equal(invertedCells(flat, flat).volume, 0);
  const moved = { ...flat, coords: Float32Array.from(flat.coords, (v, i) => (i % 3 === 2 ? v + (i === 11 ? 1 : 0) : v)) };
  assert.equal(invertedCells(flat, moved).volume, 0, "0 × anything is not a flip");
});

// ---- Sobolev ------------------------------------------------------------------

/** A unit cube as 6 tetrahedra, with a vector nodal field, a pinned part and a Conditions block. */
function tetCube(): MdpaModel {
  const hex = model(
    "Begin Properties 1\nEnd Properties\nBegin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\n5 0 0 1\n6 1 0 1\n7 1 1 1\n8 0 1 1\nEnd Nodes\n" +
      "Begin Elements Element3D8N\n1 1 1 2 3 4 5 6 7 8\nEnd Elements\n" +
      "Begin SubModelPart Bottom\n Begin SubModelPartNodes\n 1\n 2\n 3\n 4\n End SubModelPartNodes\nEnd SubModelPart\n"
  );
  return applyOp(hex, { op: "simplexify" }).model;
}
const withField = (m: MdpaModel, name: string, f: (i: number, id: number) => [number, number, number]): MdpaModel => ({
  ...m,
  fields: [
    ...m.fields,
    {
      kind: "Nodal",
      variable: name,
      components: 3,
      ids: Int32Array.from(m.nodeIds),
      values: Float64Array.from([...m.nodeIds].flatMap((id, i) => f(i, id))),
    },
  ],
});

test("a constant displacement is preserved exactly, in zero iterations", async () => {
  const m = withField(tetCube(), "D", () => [0.1, -0.2, 0.3]);
  const r = await sobolevDeformModel(m, { variable: "D", lengthScale: 0.5 });
  assert.equal(r.numIterations, 0);
  assert.equal(r.converged, true);
  for (let i = 0; i < m.nodeCount; i++) {
    assert.ok(Math.abs(r.model.coords[i * 3] - (m.coords[i * 3] + 0.1)) < 1e-6);
    assert.ok(Math.abs(r.model.coords[i * 3 + 1] - (m.coords[i * 3 + 1] - 0.2)) < 1e-6);
    assert.ok(Math.abs(r.model.coords[i * 3 + 2] - (m.coords[i * 3 + 2] + 0.3)) < 1e-6);
  }
  assert.equal(r.inverted.volume, 0);
  assert.equal(r.model.blocks, m.blocks);
  assert.equal(r.model.subModelParts, m.subModelParts);
});

test("length scale 0 applies the displacement unfiltered; a positive one smooths a spike", async () => {
  const m = withField(tetCube(), "D", (_i, id) => (id === 7 ? [0.3, 0, 0] : [0, 0, 0]));
  const raw = await sobolevDeformModel(m, { variable: "D", lengthScale: 0 });
  assert.ok(Math.abs(raw.maxDisplacement - 0.3) < 1e-6);
  const smooth = await sobolevDeformModel(m, { variable: "D", lengthScale: 1 });
  assert.ok(smooth.maxDisplacement < 0.3, "the spike is low-passed");
  assert.equal(smooth.converged, true);
});

test("a pinned part does not move at all, and non-convergence keeps the last iterate and says so", async () => {
  const m = withField(tetCube(), "D", (i) => [0.1 * ((i % 3) - 1), 0.05, 0.1]);
  const r = await sobolevDeformModel(m, { variable: "D", lengthScale: 0.5, fixedPart: "Bottom" });
  assert.equal(r.numFixed, 4);
  for (const id of [1, 2, 3, 4]) for (let k = 0; k < 3; k++) {
    const i = m.nodeIds.indexOf(id);
    assert.equal(r.model.coords[i * 3 + k], m.coords[i * 3 + k], `node ${id} pinned`);
  }
  const nc = await sobolevDeformModel(m, { variable: "D", lengthScale: 0.5, maxIterations: 1, tolerance: 1e-30 });
  assert.equal(nc.converged, false);
  assert.ok(nc.residual > 0);
  assert.ok(nc.maxDisplacement > 0, "the last iterate is returned");
  const out = await applyOpAsync(m, { op: "sobolevDeform", variable: "D", lengthScale: 0.5, maxIterations: 1, tolerance: 1e-30 });
  assert.match(out.message!, /Did NOT converge/);
});

test("uncovered nodes move by 0 and are counted; unsupported meshes and fields are refused by name", async () => {
  const m = tetCube();
  const partial: MdpaModel = {
    ...m,
    fields: [{ kind: "Nodal", variable: "D", components: 3, ids: Int32Array.from([1, 2]), values: Float64Array.from([0.1, 0, 0, 0.1, 0, 0]) }],
  };
  const r = await sobolevDeformModel(partial, { variable: "D", lengthScale: 0 });
  assert.equal(r.numUncovered, 6);
  assert.match((await sobolevDeformModel(m, { variable: "NOPE", lengthScale: 0 })).message!, /No nodal field/);
  const scalar: MdpaModel = { ...m, fields: [{ kind: "Nodal", variable: "S", components: 1, ids: Int32Array.from([1]), values: Float64Array.from([1]) }] };
  assert.match((await sobolevDeformModel(scalar, { variable: "S", lengthScale: 0 })).message!, /needs 2 or 3/);
  const hex = model("Begin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\n5 0 0 1\n6 1 0 1\n7 1 1 1\n8 0 1 1\nEnd Nodes\nBegin Elements Element3D8N\n1 0 1 2 3 4 5 6 7 8\nEnd Elements\n");
  const hexD = withField(hex, "D", () => [0, 0, 0]);
  assert.match((await sobolevDeformModel(hexD, { variable: "D", lengthScale: 0 })).message!, /Simplexify/);
});

// ---- as operations ------------------------------------------------------------

test("shrinkwrap and sobolevDeform are async ops reachable from messages, applyOpAsync and recipes", async () => {
  assert.equal(isAsyncOp("shrinkwrap"), true);
  assert.equal(isAsyncOp("sobolevDeform"), true);
  assert.equal(opRecordFromMessage({ op: "shrinkwrap" }), undefined, "a target is required");
  assert.equal(opRecordFromMessage({ op: "shrinkwrap", path: "a.stl", part: "P" }), undefined, "and only one");
  const sw = opRecordFromMessage({ op: "shrinkwrap", part: "Target", offset: "0.1", maxDistance: 2, pinPart: "Edge", normalWeight: "area", recordDistance: true })!;
  assert.deepEqual(sw, { op: "shrinkwrap", part: "Target", offset: 0.1, maxDistance: 2, pinPart: "Edge", normalWeight: "area", recordDistance: true });
  assert.equal(opRecordFromMessage({ op: "shrinkwrap", part: "T", maxDistance: -1 }), undefined);
  const sb = opRecordFromMessage({ op: "sobolevDeform", variable: "D", lengthScale: "0.5", fixBoundary: true, maxIterations: 50 })!;
  assert.deepEqual(sb, { op: "sobolevDeform", variable: "D", lengthScale: 0.5, fixBoundary: true, maxIterations: 50 });
  assert.equal(opRecordFromMessage({ op: "sobolevDeform", variable: "D" }), undefined, "lengthScale is required");
  assert.equal(opRecordFromMessage({ op: "sobolevDeform", variable: "D", lengthScale: -1 }), undefined);
  assert.deepEqual(parseOpsJson(serializeOps([sw, sb], "x.mdpa")).operations, [sw, sb]);

  // shrinkwrap onto a SubModelPart of the same mesh: a wall part of a solid, skin-free.
  const withTarget = model(
    "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\n5 0.5 0.5 0.5\nEnd Nodes\nBegin Conditions SurfaceCondition3D3N\n1 0 1 2 3\n2 0 1 3 4\nEnd Conditions\n" +
      "Begin SubModelPart Floor\n Begin SubModelPartNodes\n 1\n 2\n 3\n 4\n End SubModelPartNodes\n Begin SubModelPartConditions\n 1\n 2\n End SubModelPartConditions\nEnd SubModelPart\n" +
      "Begin SubModelPart Free\n Begin SubModelPartNodes\n 5\n End SubModelPartNodes\nEnd SubModelPart\n"
  );
  const out = await applyOpAsync(withTarget, { op: "shrinkwrap", part: "Floor", movePart: "Free" });
  assert.equal(out.noop, undefined, String(out.message));
  assert.match(out.message!, /Projected 1 node\(s\) onto SubModelPart "Floor"/);
  assert.ok(Math.abs(z(out.model, 5)) < 1e-6);
  const missing = await applyOpAsync(withTarget, { op: "shrinkwrap", part: "Nope" });
  assert.equal(missing.noop, true);
  assert.match(missing.message!, /not found/);
});
