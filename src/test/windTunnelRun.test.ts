import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { icosphere } from "./fixtures/shapes";
import { planWindTunnel, wakeSizeExpr } from "../problemtype/windTunnel/plan";
import { runWindTunnel } from "../problemtype/windTunnel/run";
import { parseMdpaFile } from "../parser/mdpaParser";
import { validateSizeExpr } from "../parser/sizeExpr";

const params = {
  flow: { speed: 10 },
  tunnel: { upstream: 1.5, downstream: 3, side: 2, top: 2, bottom: 2 },
  mesh: { surfaceSize: 0.12, farSize: 1.0, firstHeight: 0.012, growth: 1.3, maxAspect: 10, wakeLength: 1, wakeSize: 0.3, fit: 0.004 },
};

test("the plan lists every step, its ops and a size law the evaluator accepts", () => {
  const plan = planWindTunnel(params, icosphere(0.5, 4));
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.steps.map((s) => s.id).filter((i) => !i.startsWith("size-")), ["body", "lattice", "carve", "tidy", "wall", "check", "write"]);
  assert.ok(plan.passes >= 2);
  assert.equal(validateSizeExpr(plan.sizeExpr, ["d", "x", "y", "z"]), undefined);
  assert.equal(validateSizeExpr(wakeSizeExpr(plan.domain, 1, 1, 0.3, 0.25), ["x", "y", "z"]), undefined);
  const wall = plan.steps.find((s) => s.id === "wall")!.ops!.find((o) => o.op === "remesh")!;
  assert.equal((wall as { mode: string }).mode, "wall");
  assert.ok(plan.boundaryLayer.reynolds > 0);
});

test("an absurd request is refused with the numbers, and a bad unit is named", () => {
  const plan = planWindTunnel({ ...params, mesh: { ...params.mesh, surfaceSize: 0.0005, firstHeight: 0.00002, maxTetrahedra: 1_000_000 } }, icosphere(0.5, 3));
  assert.ok(plan.errors.some((e) => /tetrahedra, above the limit/.test(e)));
  assert.throws(() => planWindTunnel({ ...params, unit: "parsec" }, icosphere(0.5, 3)), /Unknown unit "parsec"/);
  const mm = planWindTunnel({ ...params, unit: "mm" }, icosphere(0.5, 3));
  assert.ok(mm.warnings.some((w) => /check the unit/.test(w)));
});

test("a sphere in a tunnel meshes body-fitted: the wall holds, the boundary is named, nothing is inverted", async () => {
  const plan = planWindTunnel(params, icosphere(0.5, 4));
  assert.deepEqual(plan.errors, []);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vwt-"));
  const seen: string[] = [];
  const r = await runWindTunnel(plan, { folder, stem: "sphere", onProgress: (p) => { if (!seen.includes(p.id)) seen.push(p.id); } });
  assert.ok(seen.includes("carve") && seen.includes("wall") && seen.includes("write"));
  const rep = r.report;
  assert.equal(rep.check.inverted, 0, "no inverted tetrahedra");
  assert.equal(rep.check.degenerate, 0);
  assert.equal(rep.check.unnamedBoundaryFaces, 0, "every boundary face has a condition");
  assert.ok(rep.wallFit && rep.wallFit.max < 0.01, `wall fit ${rep.wallFit?.max}`);
  const names = r.model.subModelParts.map((p) => p.name);
  for (const n of ["Fluid", "Body", "Inlet", "Outlet", "Floor", "Ceiling", "SideLow", "SideHigh"]) assert.ok(names.includes(n), `${n} present: ${names.join(",")}`);
  assert.ok(!names.some((n) => n.startsWith("MMG_")));
  assert.ok(r.model.blocks.every((b) => /^(Element3D4N|SurfaceCondition3D3N)$/.test(b.name)));
  assert.ok(!r.model.fields.some((f) => f.variable === "d"));
  // The fluid volume is the tunnel minus the sphere.
  const idx = new Map(Array.from(r.model.nodeIds, (id, i) => [id, i]));
  let vol = 0;
  for (const b of r.model.blocks) {
    if (b.stride !== 4) continue;
    for (let c = 0; c < b.count; c++) {
      const p = [0, 1, 2, 3].map((k) => idx.get(b.connectivity[c * 4 + k])! * 3);
      const u = [1, 2, 3].map((k) => [0, 1, 2].map((a) => r.model.coords[p[k] + a] - r.model.coords[p[0] + a]));
      vol += (u[0][0] * (u[1][1] * u[2][2] - u[1][2] * u[2][1]) - u[0][1] * (u[1][0] * u[2][2] - u[1][2] * u[2][0]) + u[0][2] * (u[1][0] * u[2][1] - u[1][1] * u[2][0])) / 6;
    }
  }
  const expected = plan.domain.volume;
  assert.ok(Math.abs(vol - expected) / expected < 0.01, `volume ${vol} vs ${expected}`);
  // It is a file a solver could read.
  const back = await parseMdpaFile(r.files.mesh);
  assert.equal(back.nodeCount, r.model.nodeCount);
  assert.ok(fs.existsSync(r.files.body) && fs.existsSync(r.files.recipe));
  const recipe = JSON.parse(fs.readFileSync(r.files.recipe, "utf8"));
  assert.equal(recipe.report.mode, "bodyFitted");
});

test("cancelling stops the run between steps", async () => {
  const plan = planWindTunnel(params, icosphere(0.5, 3));
  const ctl = new AbortController();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vwt-"));
  await assert.rejects(runWindTunnel(plan, { folder, signal: ctl.signal, onProgress: (p) => { if (p.id === "lattice") ctl.abort(); } }), /cancelled/);
});

test("a half model closes the cut with a symmetry plane and names every boundary face", async () => {
  const plan = planWindTunnel({ ...params, tunnel: { ...params.tunnel, halfModel: true, ground: "slip", clearance: 0.3 } }, icosphere(0.5, 3));
  assert.deepEqual(plan.errors, []);
  const r = await runWindTunnel(plan, { folder: fs.mkdtempSync(path.join(os.tmpdir(), "vwt-")), stem: "half" });
  const names = r.model.subModelParts.map((p) => p.name);
  assert.ok(names.includes("Symmetry") && !names.includes("SideLow"));
  assert.ok(!names.some((n) => n.startsWith("MMG_")), names.join(","));
  assert.equal(r.report.check.unnamedBoundaryFaces, 0);
  assert.equal(r.report.check.inverted, 0);
  assert.ok(Math.min(...Array.from({ length: r.model.nodeCount }, (_, i) => r.model.coords[3 * i + 1])) >= -1e-6, "nothing on the far side of the plane");
});

test("embedded mode keeps the surface unfitted and writes the signed distance", async () => {
  const plan = planWindTunnel({ ...params, mesh: { ...params.mesh, mode: "embedded" } }, icosphere(0.5, 3));
  assert.deepEqual(plan.errors, []);
  assert.ok(!plan.steps.some((s) => s.id === "carve" || s.id === "wall"));
  const r = await runWindTunnel(plan, { folder: fs.mkdtempSync(path.join(os.tmpdir(), "vwt-")), stem: "emb" });
  const d = r.model.fields.find((f) => f.variable === "DISTANCE");
  assert.ok(d, "DISTANCE field");
  assert.ok(Array.from(d!.values).some((v) => v < 0) && Array.from(d!.values).some((v) => v > 0), "negative inside, positive in the fluid");
  assert.ok(!r.model.subModelParts.some((p) => p.name === "Body"));
  assert.equal(r.report.check.inverted, 0);
});
