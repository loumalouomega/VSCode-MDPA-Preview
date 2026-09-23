/**
 * Surface curvature, over the real WASM, validated against analytic shapes:
 * a sphere of radius R has H = 1/R and K = 1/R², every closed surface satisfies
 * Gauss–Bonnet (Σ angle defect = 2πχ), and a surface wound the wrong way flips
 * the sign of H — which the operation must say rather than let mislead.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { curvatureModel, eulerCharacteristic, gaussBonnetResidual } from "../parser/curvature";
import { applyOpAsync, opRecordFromMessage, parseOpsJson, serializeOps, isAsyncOp } from "../parser/operations";
import { parseMdpa } from "../parser/mdpaParser";
import { MdpaModel } from "../parser/types";
import { icosphere } from "./fixtures/shapes";

const nodal = (m: MdpaModel, name: string) => m.fields.find((f) => f.kind === "Nodal" && f.variable === name);

test("a sphere of radius R measures H = 1/R and K = 1/R² at every node", async () => {
  const R = 2;
  const r = await curvatureModel(icosphere(R, 3), { principal: true, area: true });
  assert.deepEqual(r.written, [
    "Nodal:CURVATURE_MEAN", "Nodal:CURVATURE_GAUSSIAN", "Nodal:CURVATURE_AREA", "Nodal:CURVATURE_K1", "Nodal:CURVATURE_K2",
  ]);
  for (const [name, want] of [["CURVATURE_MEAN", 1 / R], ["CURVATURE_GAUSSIAN", 1 / (R * R)], ["CURVATURE_K1", 1 / R], ["CURVATURE_K2", 1 / R]] as const) {
    const f = nodal(r.model, name)!;
    assert.equal(f.ids.length, 642, `${name} defined on every node`);
    for (const v of f.values) assert.ok(Math.abs(v - want) < 0.02 * want, `${name}: ${v} vs ${want}`);
  }
  // The dual areas tile the sphere: their sum is its surface area (to the mesh's polyhedral approximation).
  const areaSum = [...nodal(r.model, "CURVATURE_AREA")!.values].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(areaSum - 4 * Math.PI * R * R) < 0.02 * 4 * Math.PI * R * R);
  assert.deepEqual(r.warnings, []);
});

test("Gauss–Bonnet holds for a closed surface: the angle defects sum to 2πχ = 4π", async () => {
  const m = icosphere(1, 2);
  assert.equal(eulerCharacteristic(m), 2);
  const r = await curvatureModel(m);
  assert.ok(Math.abs(r.totalAngleDefect - 4 * Math.PI) < 1e-9);
  assert.ok(Math.abs(gaussBonnetResidual(r)!) < 1e-9);
});

test("a surface wound the wrong way reads H = −1/R and says the sign is unreliable only when winding is mixed", async () => {
  const inside = await curvatureModel(icosphere(1, 2, true), { gaussian: false });
  const h = nodal(inside.model, "CURVATURE_MEAN")!;
  assert.ok([...h.values].every((v) => v < 0), "uniformly inside-out: negative mean curvature");
  assert.deepEqual(inside.warnings, [], "uniformly inside-out is self-consistent, so no mixed-winding warning");

  // Flip ONE face of an outward sphere: an inconsistent pair the operation must call out.
  const m = icosphere(1, 2);
  const blk = m.blocks[0];
  const c = Int32Array.from(blk.connectivity);
  [c[1], c[2]] = [c[2], c[1]];
  const mixed = await curvatureModel({ ...m, blocks: [{ ...blk, connectivity: c }] });
  assert.ok(mixed.warnings.some((w) => /wound against each other/.test(w)), mixed.warnings.join("|"));
  assert.equal(gaussBonnetResidual(mixed) !== undefined, true);
});

test("an open surface leaves its boundary nodes as gaps, never 0, and reports them", async () => {
  const open = icosphere(1, 2, false, (p) => p[2] >= 0);
  const r = await curvatureModel(open);
  const h = nodal(r.model, "CURVATURE_MEAN")!;
  assert.ok(r.numBoundary > 0);
  assert.equal(h.ids.length, open.nodeCount - r.numBoundary - r.numIsolated);
  assert.ok([...h.values].every(Number.isFinite));
  assert.ok(r.warnings.some((w) => /boundary node\(s\) have no curvature/.test(w)));
  assert.equal(gaussBonnetResidual(r), undefined, "Gauss–Bonnet is only claimed for a closed surface");
  // includeBoundary asks upstream to fill them in.
  const incl = await curvatureModel(open, { includeBoundary: true });
  assert.ok(nodal(incl.model, "CURVATURE_MEAN")!.ids.length >= h.ids.length);
});

test("a re-run replaces its own output instead of stacking, and the prefix renames it", async () => {
  const m = icosphere(1, 1);
  const once = await curvatureModel(m);
  const twice = await curvatureModel(once.model);
  assert.equal(twice.model.fields.filter((f) => f.variable === "CURVATURE_MEAN").length, 1);
  const named = await curvatureModel(m, { outputPrefix: "KAPPA", gaussian: false });
  assert.deepEqual(named.written, ["Nodal:KAPPA_MEAN"]);
  assert.equal((await curvatureModel(m, { outputPrefix: "bad:name" })).written.length, 0);
});

test("refusals: a solid, a mesh with no surface, and nothing selected", async () => {
  const solid = parseMdpa("Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\nEnd Nodes\nBegin Elements Element3D4N\n1 0 1 2 3 4\nEnd Elements\n");
  assert.match((await curvatureModel(solid)).message!, /Export skin/);
  const lines = parseMdpa("Begin Nodes\n1 0 0 0\n2 1 0 0\nEnd Nodes\nBegin Elements Element2D2N\n1 0 1 2\nEnd Elements\n");
  assert.match((await curvatureModel(lines)).message!, /No surface/);
  assert.match((await curvatureModel(icosphere(1, 0), { mean: false, gaussian: false })).message!, /Nothing selected/);
});

test("curvature is an async op reachable from messages, applyOpAsync and recipes; it never adopts", async () => {
  assert.equal(isAsyncOp("curvature"), true);
  const rec = opRecordFromMessage({ op: "curvature", principal: true, dualArea: "barycentric", outputPrefix: "K" })!;
  assert.deepEqual(rec, { op: "curvature", principal: true, dualArea: "barycentric", outputPrefix: "K" });
  assert.equal(opRecordFromMessage({ op: "curvature", dualArea: "voronoi-ish" }), undefined);
  assert.equal(opRecordFromMessage({ op: "curvature", outputPrefix: "a b" }), undefined);
  const out = await applyOpAsync(icosphere(1, 2), { op: "curvature" });
  assert.equal(out.noop, undefined);
  assert.match(out.message!, /Wrote CURVATURE_MEAN, CURVATURE_GAUSSIAN\./);
  assert.match(out.message!, /Gauss–Bonnet: Σ angle defect = 12\.5664 vs 2πχ = 12\.5664/);
  assert.deepEqual(parseOpsJson(serializeOps([rec], "x.mdpa")).operations, [rec]);
  // The mesh itself is untouched: same blocks, same nodes.
  assert.equal(out.model.blocks[0].count, 320);
  assert.equal(out.model.nodeCount, 162);
});

test("the curvature-adaptive remesh preset parses against a curvature field and drives a real MMG surface remesh", async () => {
  const { validateSizeExpr, remeshSizeExprVars } = await import("../parser/sizeExpr");
  const preset = "clamp(0.3/max(abs(curvature_mean), 0.000001), 0.5*min, 1.5*max)";
  assert.match(validateSizeExpr(preset, remeshSizeExprVars(false, []))!, /unknown name/i, "unknown until the field exists");
  assert.equal(validateSizeExpr(preset, remeshSizeExprVars(false, ["curvature_mean"])), undefined);

  const m = icosphere(1, 2);
  const withH = await curvatureModel(m, { gaussian: false });
  const out = await applyOpAsync(withH.model, { op: "remesh", mode: "expr", sizeExpr: preset });
  assert.equal(out.noop, undefined, String(out.message));
  assert.ok(out.model.nodeCount > 0);
  // The remesh mapped the curvature field forward like any other nodal field.
  assert.ok(out.model.fields.some((f) => f.variable === "CURVATURE_MEAN"));
});
