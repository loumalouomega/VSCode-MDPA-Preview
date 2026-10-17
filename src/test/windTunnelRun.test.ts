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
import { generateCase } from "../problemtype/generate";
import { planCaseMesh } from "../problemtype/caseMesh";
import { preflightCase } from "../problemtype/preflight";
import { parseCaseJson } from "../problemtype/caseFile";
import { windTunnelCase } from "../problemtype/windTunnel/caseState";
import { fluid } from "../problemtype/builtins/fluid";
import { embeddedFluid } from "../problemtype/builtins/embeddedFluid";
import { rans } from "../problemtype/builtins/rans";

const params = {
  flow: { speed: 10 },
  tunnel: { upstream: 1.5, downstream: 3, side: 2, top: 2, bottom: 2 },
  mesh: { surfaceSize: 0.12, farSize: 1.0, firstHeight: 0.012, growth: 1.3, maxAspect: 10, wakeLength: 1, wakeSize: 0.3, fit: 0.004 },
};

test("the plan lists every step, its ops and a size law the evaluator accepts", () => {
  const plan = planWindTunnel(params, icosphere(0.5, 4));
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.steps.map((s) => s.id).filter((i) => !i.startsWith("size-")), ["body", "lattice", "carve", "tidy", "snap", "wall", "check", "write"]);
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

  // The prepared simulation reads back, passes the preflight and generates a solver case.
  const saved = parseCaseJson(fs.readFileSync(r.files.caseState, "utf8"));
  assert.deepEqual(saved.warnings, []);
  assert.equal(saved.state!.problemtypeId, "fluid");
  const pre = await preflightCase(fluid, back, saved.state!, "sphere", { isMdpaSource: true });
  assert.deepEqual(pre.findings.filter((f) => f.severity === "error").map((f) => f.message), []);
  const casePlan = planCaseMesh(fluid, back, saved.state!, "sphere", true);
  const gen = await generateCase(fluid, casePlan.caseModel, saved.state!, casePlan.caseStem);
  const pp = JSON.parse(gen.projectParameters);
  const coeff = pp.processes.auxiliar_process_list.find((p: { python_module: string }) => p.python_module === "compute_aerodynamic_coefficients_process");
  assert.ok(Math.abs(coeff.Parameters.reference_area - Math.PI * 0.25) / (Math.PI * 0.25) < 0.03, "reference area is the frontal area");
  assert.ok(Math.abs(coeff.Parameters.dynamic_pressure - 0.5 * 1.204 * 100) < 1e-9);
  const wall = pp.processes.constraints_process_list.find((p: { python_module: string }) => p.python_module === "apply_wall_law_process");
  assert.equal(wall.Parameters.model_part_name, "FluidModelPart.Body");
  assert.equal(wall.Parameters.wall_model_settings.y_wall, 0.012);
  // The same mesh prepared for a RANS model generates a CoupledRANS case with the wall function on the body.
  const ransPlan = planWindTunnel({ ...params, flow: { speed: 10, turbulence: "k_omega_sst", turbulenceIntensity: 0.02 } }, icosphere(0.5, 4));
  const ransCase = windTunnelCase(ransPlan);
  assert.equal(ransCase.problemtypeId, "rans");
  const ransGen = await generateCase(rans, casePlan.caseModel, ransCase.state, casePlan.caseStem);
  const rp = JSON.parse(ransGen.projectParameters);
  assert.equal(rp.analysis_stage, "KratosMultiphysics.RANSApplication.rans_analysis");
  assert.equal(rp.solver_settings.formulation_settings.formulation_name, "monolithic_k_omega_sst");
  assert.equal(rp.processes.constraints_process_list.find((p: { python_module: string }) => p.python_module === "apply_wall_function_process").Parameters.model_part_name, "FluidModelPart.Body");
  const ransPre = await preflightCase(rans, back, ransCase.state, "sphere", { isMdpaSource: true });
  assert.deepEqual(ransPre.findings.filter((f) => f.severity === "error").map((f) => f.message), []);
  assert.deepEqual(pp.solver_settings.skin_parts.sort(), ["FluidModelPart.Body", "FluidModelPart.Ceiling", "FluidModelPart.Floor", "FluidModelPart.Inlet", "FluidModelPart.Outlet", "FluidModelPart.SideHigh", "FluidModelPart.SideLow"]);
});

test("the prepared case follows the ground mode, the half model and the mode", () => {
  const moving = windTunnelCase(planWindTunnel({ ...params, tunnel: { ...params.tunnel, ground: "moving", clearance: 0.2 } }, icosphere(0.5, 3)));
  const floor = moving.state.assignments.find((a) => a.smpPath === "Floor")!;
  assert.equal(floor.conditionId, "velocityConstraints");
  assert.deepEqual(floor.values.value, [10, 0, 0]);
  const half = windTunnelCase(planWindTunnel({ ...params, tunnel: { ...params.tunnel, halfModel: true } }, icosphere(0.5, 3)));
  assert.ok(half.state.assignments.some((a) => a.smpPath === "Symmetry" && a.conditionId === "slip"));
  const area = half.state.assignments.find((a) => a.conditionId === "aerodynamicCoefficients")!.values.referenceArea as number;
  const full = windTunnelCase(planWindTunnel(params, icosphere(0.5, 3))).state.assignments.find((a) => a.conditionId === "aerodynamicCoefficients")!.values.referenceArea as number;
  assert.ok(Math.abs(area / full - 0.5) < 1e-6, "a half model uses half the reference area");
  const emb = windTunnelCase(planWindTunnel({ ...params, mesh: { ...params.mesh, mode: "embedded" } }, icosphere(0.5, 3)));
  assert.equal(emb.problemtypeId, "embeddedFluid");
  assert.ok(!emb.state.assignments.some((a) => a.smpPath === "Body"));
  assert.equal(emb.state.values.problem.computeDrag, true);
  assert.ok(embeddedFluid.decl.id === "embeddedFluid");
});

test("a turbulence model prepares the RANS case; an embedded body cannot take one", () => {
  const plan = planWindTunnel({ ...params, tunnel: { ...params.tunnel, ground: "noslip", clearance: 0.1 }, flow: { speed: 10, turbulence: "k_epsilon", turbulenceLength: 0.05 } }, icosphere(0.5, 3));
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.warnings.some((w) => /k-epsilon RANS model/.test(w)));
  assert.ok(!plan.warnings.some((w) => /no turbulence model is applied/.test(w)));
  const c = windTunnelCase(plan);
  assert.equal(c.problemtypeId, "rans");
  const wall = c.state.assignments.filter((a) => a.conditionId === "ransWall");
  assert.deepEqual(wall.map((a) => a.smpPath), ["Body"], "one wall function part");
  assert.equal(c.state.assignments.find((a) => a.smpPath === "Floor")!.conditionId, "velocityConstraints", "a no-slip floor cannot take the wall function");
  assert.deepEqual(c.state.materials.map((m) => m.lawId), ["rans_newtonian_3d", "rans_wall"]);
  assert.equal(c.state.values.problem.turbulenceLength, 0.05);
  assert.equal(c.state.values.problem.scheme, "steady");
  assert.equal(c.state.output.controlType, "step");
  const emb = planWindTunnel({ ...params, flow: { speed: 10, turbulence: "k_epsilon" }, mesh: { ...params.mesh, mode: "embedded" } }, icosphere(0.5, 3));
  assert.ok(emb.errors.some((e) => /body-fitted/.test(e)));
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
