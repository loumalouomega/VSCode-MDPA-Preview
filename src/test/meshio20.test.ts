/**
 * meshio++ 20.0.0 over the real WASM: the scan-metrology and surface-editing kernels as derive
 * kinds and in-place ops, the new options on existing ops, and the `dxf` format.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deriveMesh } from "../parser/deriveMesh";
import { loadMeshio, meshioPackageVersion } from "../parser/meshio";
import { parseMeshFile } from "../parser/meshFileParser";
import { writeMeshFileAsync } from "../parser/writers/meshWriter";
import { applyOpAsync, opRecordFromMessage } from "../parser/operations";
import { parseCommandLine } from "../parser/commandParse";
import { thicknessModel } from "../parser/thickness";
import { decimateModel } from "../parser/decimate";
import { MdpaModel } from "../parser/types";
import { exportEligibility } from "../parser/writers/exportEligibility";
import { icosphere } from "./fixtures/shapes";

const NEW_FUNCTIONS = [
  "deviation", "deviationRegions", "exaggerate", "colorize", "measure", "alignDatums", "measureElementPrimitive", "registerLandmarks",
  "findSymmetryPlane", "autoAlign", "constrainPrimitives", "faceSupport", "fitCadIterate", "profileSolid", "writeStepElements",
  "sections", "fitCurves", "silhouette", "clip", "offsetSurface", "thicken", "hollow", "flipNormals", "removeIslands",
] as const;

const rec = (msg: Record<string, unknown>) => {
  const r = opRecordFromMessage({ type: "applyOp", ...msg });
  assert.ok(r, `${String(msg.op)} must validate`);
  return r!;
};
const cells = (m: MdpaModel) => m.blocks.reduce((a, b) => a + b.count, 0);
const field = (m: MdpaModel, name: string) => m.fields.find((f) => f.variable === name);

test("the installed kernel is 20.0.0 and exposes the twenty-four new functions", async () => {
  assert.match(meshioPackageVersion()!, /^20\./);
  const k = (await loadMeshio()) as unknown as Record<string, unknown>;
  for (const fn of NEW_FUNCTIONS) assert.equal(typeof k[fn], "function", fn);
});

test("sections of a sphere are closed chains at the planes; silhouette outlines it", async () => {
  const sphere = icosphere(1, 2);
  const s = await deriveMesh(sphere, { kind: "sections", options: { direction: [0, 0, 1], offsets: [-0.5, 0, 0.5] } });
  assert.ok(cells(s.model) > 0);
  assert.ok(field(s.model, "SECTION_OFFSET"), "SECTION_OFFSET cell field");
  await assert.rejects(() => deriveMesh(sphere, { kind: "sections", options: {} }), /direction/);
  const sil = await deriveMesh(sphere, { kind: "silhouette", options: { normal: [0, 0, 1] } });
  assert.match(sil.summary, /1 loop/);
});

test("clip caps a sphere cut at the equator; thicken and hollow make shells", async () => {
  const sphere = icosphere(1, 2);
  const c = await deriveMesh(sphere, { kind: "clip", options: { origin: [0, 0, 0], normal: [0, 0, 1] } });
  assert.match(c.summary, /cap triangle/);
  const t = await deriveMesh(sphere, { kind: "thicken", options: { thickness: 0.1, side: "inward" } });
  assert.ok(cells(t.model) >= cells(sphere));
  const h = await deriveMesh(sphere, { kind: "hollow", options: { wall: 0.1 } });
  assert.ok(cells(h.model) >= 2 * cells(sphere) - 1, "an inner reversed wall is added");
  await assert.rejects(() => deriveMesh(sphere, { kind: "thicken", options: {} }), /thickness/);
});

test("deviation measures a sphere against a reference primitive and a reference file; regions and colorize follow", async () => {
  const scan = icosphere(1, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev20-"));
  const refFile = path.join(dir, "ref.stl");
  const w = await writeMeshFileAsync(icosphere(1.05, 2), ".stl", {});
  fs.writeFileSync(refFile, w.data);
  const prim = await applyOpAsync(scan, rec({ op: "deviation", primitive: "sphere", primitiveParams: [0, 0, 0, 1.05, 0, 0, 0, 0, 0, 0], tolerance: 0.1 }));
  assert.ok(!prim.noop, String(prim.message));
  const f = field(prim.model, "DEVIATION")!;
  assert.ok(f && f.ids.length === scan.nodeCount, "one value per node");
  assert.match(String(prim.message), /within/);
  // A reference FILE: the scan sits ~0.05 inside it, so every value is negative (positive is outside).
  const filed = await applyOpAsync(scan, rec({ op: "deviation", path: refFile }));
  assert.ok(!filed.noop, String(filed.message));
  assert.ok(Array.from(field(filed.model, "DEVIATION")!.values).every((v) => v < 0));
  fs.rmSync(dir, { recursive: true, force: true });
  // Exactly one reference.
  assert.equal(opRecordFromMessage({ type: "applyOp", op: "deviation" }), undefined);
  assert.equal(opRecordFromMessage({ type: "applyOp", op: "deviation", path: "a.stl", primitive: "plane", primitiveParams: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }), undefined);
  // Regions need a tolerance smaller than the offset; a huge one makes none.
  const none = await applyOpAsync(filed.model, rec({ op: "deviationRegions", tolerance: 10 }));
  assert.ok(none.noop);
  const some = await applyOpAsync(filed.model, rec({ op: "deviationRegions", tolerance: 0.01 }));
  assert.ok(!some.noop, String(some.message));
  assert.ok(some.model.subModelParts.some((p) => /^DEV_missing_\d+$/.test(p.name)), "a missing-material part");
  // colorize bakes the field into COLOR_R/G/B.
  const col = await deriveMesh(filed.model, { kind: "colorize", options: { field: "DEVIATION", cmap: "viridis" } });
  for (const n of ["COLOR_R", "COLOR_G", "COLOR_B"]) assert.ok(field(col.model, n), n);
});

test("flipNormals reverses the winding twice back to the start; removeIslands drops a detached piece", async () => {
  const sphere = icosphere(1, 1);
  const flipped = await applyOpAsync(sphere, rec({ op: "flipNormals" }));
  assert.ok(!flipped.noop, String(flipped.message));
  assert.equal(cells(flipped.model), cells(sphere));
  assert.equal(flipped.model.nodeCount, sphere.nodeCount);
  const back = await applyOpAsync(flipped.model, rec({ op: "flipNormals" }));
  assert.deepEqual(Array.from(back.model.blocks[0].connectivity).slice(0, 3).sort(), Array.from(sphere.blocks[0].connectivity).slice(0, 3).sort());
  const part = await applyOpAsync(sphere, rec({ op: "flipNormals", part: "NoSuchPart" }));
  assert.ok(part.noop && /not found/.test(String(part.message)));
  const none = await applyOpAsync(sphere, rec({ op: "removeIslands" }));
  assert.ok(none.noop && /threshold/.test(String(none.message)));
  const dry = await applyOpAsync(sphere, rec({ op: "removeIslands", minCells: 1000, dryRun: true }));
  assert.ok(dry.noop && /Dry run/.test(String(dry.message)));
});

test("offsetSurface moves points by the distance and autoAlign returns a rigid motion", async () => {
  const sphere = icosphere(1, 2);
  const out = await applyOpAsync(sphere, rec({ op: "offsetSurface", distance: 0.1 }));
  assert.ok(!out.noop, String(out.message));
  const r = (m: MdpaModel, i: number) => Math.hypot(m.coords[i * 3], m.coords[i * 3 + 1], m.coords[i * 3 + 2]);
  assert.ok(Math.abs(r(out.model, 0) - 1.1) < 0.02, `radius ${r(out.model, 0)}`);
  assert.equal(out.model.nodeIds[5], sphere.nodeIds[5]);
  const al = await applyOpAsync(sphere, rec({ op: "autoAlign" }));
  assert.ok(!al.noop, String(al.message));
  const dist = (m: MdpaModel, a: number, b: number) => Math.hypot(m.coords[a * 3] - m.coords[b * 3], m.coords[a * 3 + 1] - m.coords[b * 3 + 1], m.coords[a * 3 + 2] - m.coords[b * 3 + 2]);
  assert.ok(Math.abs(dist(al.model, 0, 7) - dist(sphere, 0, 7)) < 1e-4, "rigid: pair distances kept");
  assert.equal(opRecordFromMessage({ type: "applyOp", op: "offsetSurface" }), undefined, "distance is required");
});

test("thickness takes a method; repair a fill style; decimate a measured deviation bound", async () => {
  const sphere = icosphere(1, 2);
  const th = await thicknessModel(sphere, { method: "sphere" });
  assert.ok(th.written.length > 0, String(th.message));
  assert.match(String(th.method), /sphere/);
  assert.equal(opRecordFromMessage({ type: "applyOp", op: "thickness", method: "bogus" }), undefined);
  assert.equal((rec({ op: "thickness", method: "cone", coneAngle: 20 }) as { method?: string }).method, "cone");
  assert.equal(opRecordFromMessage({ type: "applyOp", op: "repairSurface", fillStyle: "bogus" }), undefined);
  assert.equal((rec({ op: "repairSurface", fillStyle: "curved" }) as { fillStyle?: string }).fillStyle, "curved");
  const dec = await decimateModel(icosphere(1, 3), { maxDeviation: 0.05 });
  assert.ok(dec.facesAfter < dec.facesBefore);
  assert.ok(dec.deviation === undefined || dec.deviation <= 0.0501 || dec.deviationMet === false);
  await assert.rejects(() => decimateModel(sphere, { ratio: 0.5, maxDeviation: 0.05 }), /exactly one/);
});

test("registerRigid starts from the best principal frame with autoInit", async () => {
  const sphere = icosphere(1, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg20-"));
  const f = path.join(dir, "t.stl");
  fs.writeFileSync(f, (await writeMeshFileAsync(sphere, ".stl", {})).data);
  const r = await applyOpAsync(sphere, rec({ op: "registerRigid", path: f, autoInit: true, symmetricCheck: true }));
  assert.ok(!r.noop, String(r.message));
  assert.match(String(r.message), /principal-frame/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the command line knows the new ops", () => {
  for (const line of ["flipNormals", "removeIslands minCells=5 dryRun=true", "offsetSurface distance=0.1", "deviationRegions tolerance=0.1", "thickness method=cone coneAngle=20"]) {
    const p = parseCommandLine(line);
    assert.ok(p.ok, `${line}: ${JSON.stringify(p)}`);
  }
});

test("dxf is a routed format for line sketches: sections survive a write and a read, a surface is refused by name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxf20-"));
  const f = path.join(dir, "m.dxf");
  const sphere = icosphere(1, 1);
  const sec = (await deriveMesh(sphere, { kind: "sections", options: { direction: [0, 0, 1], offsets: [0] } })).model;
  fs.writeFileSync(f, (await writeMeshFileAsync(sec, ".dxf", {})).data);
  const back = await parseMeshFile(f);
  assert.ok(back.nodeCount > 0 && cells(back) > 0);
  const refusal = exportEligibility(sphere, ".dxf");
  assert.ok(refusal && !refusal.ok && /line cells/.test(String(refusal.reason)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registerLandmarks moves the mesh by the pair-fitted rigid motion", async () => {
  const sphere = icosphere(1, 1);
  const out = await applyOpAsync(sphere, rec({ op: "registerLandmarks", source: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], target: [1, 0, 0, 2, 0, 0, 1, 1, 0, 1, 0, 1] }));
  assert.ok(!out.noop, String(out.message));
  assert.ok(Math.abs(out.model.coords[0] - sphere.coords[0] - 1) < 1e-4, "translated by +1 in x");
  assert.equal(opRecordFromMessage({ type: "applyOp", op: "registerLandmarks", source: [0, 0, 0, 1, 0, 0], target: [0, 0, 0, 1, 0, 0] }), undefined, "needs three pairs");
});

test("mesh_measure, mesh_symmetry_plane and mesh_fit_cad_iterate answer through the MCP handlers", async () => {
  const { meshMeasure, meshSymmetryPlane, meshFitCadIterate } = await import("../mcp/tools");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp20-"));
  const f = path.join(dir, "s.stl");
  fs.writeFileSync(f, (await writeMeshFileAsync(icosphere(1, 2), ".stl", {})).data);
  const meas = (await meshMeasure({ path: f, spec: { elements: [{ name: "p", type: "point", point: [0, 0, 0] }, { name: "q", type: "point", point: [1, 0, 0] }], dimensions: [{ name: "d", type: "distance", between: ["p", "q"], nominal: 1, tolerance: 0.01 }] } })) as { numFail: number; report: { dimensions?: unknown[] } };
  assert.equal(meas.numFail, 0);
  await assert.rejects(() => meshMeasure({ path: f }), /spec/);
  const sym = (await meshSymmetryPlane({ path: f })) as { share: number; normal: number[] };
  assert.ok(sym.share > 0.99 && sym.normal.length === 3);
  assert.equal(typeof meshFitCadIterate, "function");
  fs.rmSync(dir, { recursive: true, force: true });
});
