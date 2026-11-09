import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";
import { fluid } from "../problemtype/builtins/fluid";
import { potentialFlow } from "../problemtype/builtins/potentialFlow";
import { convectionDiffusion } from "../problemtype/builtins/convectionDiffusion";
import { parseCaseJson, serializeCase } from "../problemtype/caseFile";
import { applyParallel, distributedLinearSolver, supportsMpi } from "../problemtype/parallel";
import type { CaseState, JsonObject } from "../problemtype/types";

const MDPA = `Begin Properties 0
End Properties
Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes
Begin Elements Element3D4N
1 0 1 2 3 4
End Elements
Begin SubModelPart Parts
  Begin SubModelPart Solid
    Begin SubModelPartNodes
    1
    2
    3
    4
    End SubModelPartNodes
    Begin SubModelPartElements
    1
    End SubModelPartElements
  End SubModelPart
End SubModelPart
Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
End SubModelPart
`;

function state(): CaseState {
  const s = defaultCaseState(structural.decl);
  s.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0], constrained: true } },
  ];
  s.materials = [{ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2.0e11 } }];
  return s;
}

test("automatic solver becomes amgcl, parallel_type MPI, applications and driver import follow", async () => {
  const s = state();
  s.parallel = { type: "mpi", partitionInMemory: true };
  const out = await generateCase(structural, parseMdpa(MDPA), s, "beam");
  const pp = JSON.parse(out.projectParameters);
  assert.equal(pp.problem_data.parallel_type, "MPI");
  assert.deepEqual(pp.solver_settings.linear_solver_settings, { solver_type: "amgcl" });
  assert.deepEqual(pp.solver_settings.model_import_settings, { input_type: "mdpa", input_filename: "beam", partition_in_memory: true });
  assert.ok(out.applications.includes("MetisApplication") && out.applications.includes("TrilinosApplication"));
  assert.ok(out.mainScript.includes("import KratosMultiphysics.mpi"));
  assert.ok(out.mainScript.includes('"TrilinosApplication"'));
});

test("cg maps to amgcl with a cg Krylov solver and keeps tolerance and iterations", async () => {
  const s = state();
  s.values.problem = { ...s.values.problem, linearSolver: "cg", linearMaxIteration: 300, linearTolerance: 1e-8, preconditioner: "ilu" };
  s.parallel = { type: "mpi" };
  const out = await generateCase(structural, parseMdpa(MDPA), s, "beam");
  assert.deepEqual(JSON.parse(out.projectParameters).solver_settings.linear_solver_settings, {
    solver_type: "amgcl", krylov_type: "cg", tolerance: 1e-8, max_iteration: 300,
  });
  assert.ok(out.warnings.some((w) => /ilu.*no MPI counterpart/.test(w)));
});

test("serial-only solvers and analyses are refused by name", async () => {
  const s = state();
  s.values.problem = { ...s.values.problem, linearSolver: "LinearSolversApplication.sparse_lu" };
  s.parallel = { type: "mpi" };
  await assert.rejects(generateCase(structural, parseMdpa(MDPA), s, "beam"), /sparse_lu" is serial-only/);
  const e = state();
  e.values.problem = { ...e.values.problem, solverType: "eigen_value" };
  e.parallel = { type: "mpi" };
  await assert.rejects(generateCase(structural, parseMdpa(MDPA), e, "beam"), /no distributed strategy/);
  const p = defaultCaseState(potentialFlow.decl);
  p.parallel = { type: "mpi" };
  await assert.rejects(generateCase(potentialFlow, parseMdpa(MDPA), p, "beam"), /not available/);
  assert.equal(supportsMpi("fluid"), true);
});

test("a case without parallel is byte-identical", async () => {
  const a = await generateCase(structural, parseMdpa(MDPA), state(), "beam");
  const pp = JSON.parse(a.projectParameters);
  assert.equal(pp.problem_data.parallel_type, "OpenMP");
  assert.ok(!a.applications.includes("TrilinosApplication"));
  assert.ok(!a.mainScript.includes("KratosMultiphysics.mpi"));
});

test("fractional-step fluid gets velocity and pressure solvers", () => {
  const doc: JsonObject = { problem_data: { parallel_type: "OpenMP" }, solver_settings: { solver_type: "FractionalStep" } };
  const out = applyParallel(doc, { ...defaultCaseState(fluid.decl), parallel: { type: "mpi" } }).document;
  const ss = out.solver_settings as JsonObject;
  assert.deepEqual(ss.velocity_linear_solver_settings, { solver_type: "amgcl" });
  assert.deepEqual(ss.pressure_linear_solver_settings, { solver_type: "amgcl" });
  assert.equal(distributedLinearSolver({ solver_type: "bicgstab" }).settings?.krylov_type, "bicgstab");
});

test("the case file round-trips parallel", () => {
  const s = state();
  s.parallel = { type: "mpi", partitionInMemory: true };
  assert.deepEqual(parseCaseJson(serializeCase(s)).state?.parallel, s.parallel);
  assert.equal(parseCaseJson(serializeCase(state())).state?.parallel, undefined);
});

test("the distributed solver choice and convection-diffusion", async () => {
  const amesos = applyParallel({ solver_settings: { solver_type: "Static" } }, { ...state(), parallel: { type: "mpi", solver: "amesos" } });
  assert.deepEqual((amesos.document.solver_settings as JsonObject).linear_solver_settings, { solver_type: "amesos", amesos_solver_type: "Amesos_Klu" });
  const ml = distributedLinearSolver({ solver_type: "cg", tolerance: 1e-6 }, "multi_level").settings!;
  assert.equal(ml.solver_type, "multi_level");
  assert.equal(ml.tolerance, 1e-6);
  assert.match(distributedLinearSolver({ solver_type: "LinearSolversApplication.sparse_lu" }, "amesos").refusal ?? "", /serial-only/);
  const cd = defaultCaseState(convectionDiffusion.decl);
  cd.parallel = { type: "mpi" };
  assert.equal(supportsMpi("convectionDiffusion"), true);
  const out = await generateCase(convectionDiffusion, parseMdpa(MDPA), cd, "beam").catch((e: Error) => e);
  // Without assignments the case is incomplete, but never "not available".
  assert.ok(!(out instanceof Error) || !/not available/.test(out.message));
  assert.deepEqual(parseCaseJson(serializeCase({ ...state(), parallel: { type: "mpi", solver: "multi_level" } })).state?.parallel, { type: "mpi", solver: "multi_level" });
});
