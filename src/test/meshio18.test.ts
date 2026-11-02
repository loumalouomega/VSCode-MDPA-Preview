/**
 * The meshio++ 18.0.0 oracle ops over the real WASM: wall thickness per facet and
 * region selection (box / plane / sphere / grown patch / component).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyOpAsync, opRecordFromMessage } from "../parser/operations";
import { generateMesh } from "../parser/kernelMeshes";
import { extractSkinModel } from "../parser/extractSkin";
import { MdpaModel } from "../parser/types";
import { icosphere } from "./fixtures/shapes";

async function skinOf(dims: number[], size: number[]): Promise<MdpaModel> {
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims, size } })).model;
  return extractSkinModel(box).model;
}

const centroidZ = (m: MdpaModel, b: MdpaModel["blocks"][number], c: number): number => {
  const idx = new Map<number, number>();
  m.nodeIds.forEach((id, i) => idx.set(id, i));
  let z = 0;
  for (let k = 0; k < b.stride; k++) z += m.coords[idx.get(b.connectivity[c * b.stride + k])! * 3 + 2];
  return z / b.stride;
};

test("thickness measures a thin slab and writes a per-facet field", async () => {
  const slab = await skinOf([4, 4, 1], [1, 1, 0.1]);
  const out = await applyOpAsync(slab, { op: "thickness", threshold: 0.2 });
  assert.ok(!out.noop, out.message ?? "");
  const f = out.model.fields.find((x) => x.variable === "THICKNESS");
  assert.ok(f, "THICKNESS field");
  const min = Math.min(...f!.values);
  assert.ok(Math.abs(min - 0.1) < 1e-6, `least thickness ${min}`);
  assert.match(out.message ?? "", /thinner than 0\.2/);
});

test("thickness refuses a volume mesh by name and a miss is a gap, not zero", async () => {
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2] } })).model;
  const refused = await applyOpAsync(box, { op: "thickness" });
  assert.ok(refused.noop);
  assert.match(refused.message ?? "", /volume cells/);
  const sphere = await applyOpAsync(icosphere(1, 2), { op: "thickness", direction: "outward", maxDistance: 0.5 });
  assert.ok(sphere.noop, "an outward ray from a lone sphere reaches nothing");
  assert.match(sphere.message ?? "", /reached a surface|reached nothing/);
});

test("selectRegion by plane makes a SubModelPart of the cells above it", async () => {
  const sphere = icosphere(1, 2);
  const out = await applyOpAsync(sphere, { op: "selectRegion", name: "top", plane: [0, 0, 0, 0, 0, 1], mode: "centroid" });
  assert.ok(!out.noop, out.message ?? "");
  const part = out.model.subModelParts.find((p) => p.name === "top");
  assert.ok(part);
  let expected = 0;
  for (const b of sphere.blocks) for (let c = 0; c < b.count; c++) if (centroidZ(sphere, b, c) >= 0) expected++;
  assert.equal(part!.conditionIds.length + part!.elementIds.length, expected);
  assert.ok(part!.nodeIds.length > 0, "node closure rides in");
});

test("selectRegion grows a patch from a seed and stops at a cube edge", async () => {
  const cube = await skinOf([3, 3, 3], [1, 1, 1]);
  const out = await applyOpAsync(cube, { op: "selectRegion", name: "face", seed: [0.5, 0.5, 1], featureAngle: 30 });
  assert.ok(!out.noop, out.message ?? "");
  const part = out.model.subModelParts.find((p) => p.name === "face")!;
  assert.equal(part.conditionIds.length + part.elementIds.length, 9, "one 3x3 face");
  assert.match(out.message ?? "", /grown patch has 9/);
});

test("selectRegion by point criteria selects nodes, and bad requests are refused", async () => {
  const sphere = icosphere(1, 1);
  const pts = await applyOpAsync(sphere, { op: "selectRegion", name: "cap", kind: "point", sphere: [0, 0, 1, 0.3] });
  assert.ok(!pts.noop, pts.message ?? "");
  assert.ok(pts.model.subModelParts.find((p) => p.name === "cap")!.nodeIds.length > 0);
  assert.equal(opRecordFromMessage({ op: "selectRegion", name: "x" }), undefined, "no criterion");
  assert.equal(opRecordFromMessage({ op: "selectRegion", name: "a/b", plane: [0, 0, 0, 0, 0, 1] }), undefined, "slash in name");
  const side = await applyOpAsync(sphere, { op: "selectRegion", name: "s", kind: "side" as never, plane: [0, 0, 0, 0, 0, 1] });
  assert.ok(side.noop);
  assert.match(side.message ?? "", /side|facet/);
});

test("the new ops round-trip through the message parser", () => {
  assert.deepEqual(opRecordFromMessage({ op: "thickness", direction: "inward", threshold: "0.5" }), { op: "thickness", direction: "inward", threshold: 0.5 });
  assert.equal(opRecordFromMessage({ op: "thickness", direction: "sideways" }), undefined);
  const r = opRecordFromMessage({ op: "selectRegion", name: "r", box: [0, 0, 0, 1, 1, 1], mode: "any", where: ["TEMP", ">", 3] });
  assert.deepEqual(r, { op: "selectRegion", name: "r", mode: "any", box: [0, 0, 0, 1, 1, 1], where: ["TEMP", ">", 3] });
});

// --- findIntersections ------------------------------------------------------------------------------

import { findIntersectionsReport } from "../parser/analysisOps";
import { runMeshAnalysis } from "../meshAnalysis";
import { WORKER_KINDS } from "../meshAnalysis";
import { deriveMesh } from "../parser/deriveMesh";
import { translateCoords } from "../parser/transformCoords";
import { meshIntersections } from "../mcp/tools";
import { writeMeshFile } from "../parser/writers/meshWriter";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("a closed sphere has no self-intersections; two overlapping spheres meet", async () => {
  const clean = await findIntersectionsReport(icosphere(1, 2));
  assert.equal(clean.clean, true);
  assert.equal(clean.numPairs, 0);
  const moved = translateCoords(icosphere(1, 2), 0.8, 0, 0);
  const two = await findIntersectionsReport(icosphere(1, 2), { other: moved });
  assert.equal(two.clean, false);
  assert.equal(two.mode, "two-surface");
  assert.ok(two.numPairs > 0 && two.numSegments > 0);
  assert.ok(two.cells.total > 0 && two.otherCells!.total > 0);
  assert.ok(two.segments && two.segments.lines.length > 0);
});

test("a surface merged with a shifted copy of itself intersects itself", async () => {
  const { mergeModels } = await import("../parser/mergeMesh");
  const both = mergeModels(icosphere(1, 2), translateCoords(icosphere(1, 2), 0.8, 0, 0), { weld: false }).model;
  const r = await findIntersectionsReport(both, { segments: false });
  assert.equal(r.clean, false);
  assert.equal(r.mode, "self");
  assert.equal(r.segments, undefined);
});

test("intersections is a worker analysis kind that returns a selection set", async () => {
  assert.ok(WORKER_KINDS.has("intersections"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isect-"));
  const other = path.join(dir, "other.mdpa");
  fs.writeFileSync(other, (await writeMeshFile(translateCoords(icosphere(1, 2), 0.8, 0, 0), ".mdpa")) as string);
  const reply = await runMeshAnalysis({ type: "meshAnalysis", kind: "intersections", path: other, seq: 7 }, icosphere(1, 2));
  assert.equal(reply.kind, "intersections");
  assert.equal(reply.seq, 7);
  assert.match(String(reply.summary), /intersecting facet pair/);
  const sel = reply.selection as { name: string; kinds: Record<string, number[]> };
  assert.ok(sel.kinds.Conditions.length + sel.kinds.Elements.length > 0);
  const none = await runMeshAnalysis({ type: "meshAnalysis", kind: "intersections", seq: 8 }, icosphere(1, 2));
  assert.equal(none.selection, undefined);
  assert.match(String(none.summary), /No self-intersections/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a volume mesh is refused by name, and mesh_intersections reports a pair of files", async () => {
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2] } })).model;
  await assert.rejects(findIntersectionsReport(box), /volume cells/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isect-"));
  const a = path.join(dir, "a.mdpa");
  const b = path.join(dir, "b.mdpa");
  fs.writeFileSync(a, (await writeMeshFile(icosphere(1, 2), ".mdpa")) as string);
  fs.writeFileSync(b, (await writeMeshFile(translateCoords(icosphere(1, 2), 0.8, 0, 0), ".mdpa")) as string);
  const self = (await meshIntersections({ path: a })) as { clean: boolean };
  assert.equal(self.clean, true);
  const two = (await meshIntersections({ path: a, otherPath: b, idLimit: 5 })) as { clean: boolean; numPairs: number; cells: { Conditions: number[]; total: number } };
  assert.equal(two.clean, false);
  assert.ok(two.numPairs > 0);
  assert.ok(two.cells.Conditions.length <= 5 && two.cells.total > 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("findIntersections can write the intersection curve as a line mesh", async () => {
  const { mergeModels } = await import("../parser/mergeMesh");
  const both = mergeModels(icosphere(1, 2), translateCoords(icosphere(1, 2), 0.8, 0, 0), { weld: false }).model;
  const r = await deriveMesh(both, { kind: "findIntersections" });
  assert.ok(r.model.blocks.some((blk) => blk.count > 0));
  assert.match(r.summary, /Intersection curve/);
  await assert.rejects(deriveMesh(icosphere(1, 2), { kind: "findIntersections" }), /no self-intersections/);
});

test("tetToPoly builds the median dual and a .vtu keeps the polyhedra", async () => {
  const tets = await deriveMesh(icosphere(1, 2), { kind: "tetrahedralize", options: { maxSize: 0.5 } });
  const dual = await deriveMesh(tets.model, { kind: "tetToPoly" });
  assert.ok((dual.model.polyhedra?.count ?? 0) > 0, "polyhedra captured");
  assert.match(dual.summary, /Polyhedral dual: \d/);
  const vtu = (await writeMeshFile(dual.model, ".vtu")) as string;
  assert.match(vtu, /\b42\b/, "VTK_POLYHEDRON cells in the .vtu");
  assert.match(vtu, /faceoffsets/);
  const stl = await deriveMesh(icosphere(1, 2), { kind: "tetToPoly" }).catch((e: Error) => e);
  assert.ok(stl instanceof Error, "a surface mesh has no tetrahedra to dualize");
});
