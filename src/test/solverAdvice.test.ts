import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adviseLinearSolver,
  estimateDofs,
  solverFindings,
  DIRECT_SOLVER_DOF_LIMIT,
} from "../problemtype/solverAdvice";
import { linearSolverSettings } from "../problemtype/builtins/common";

test("DOFs per node follow the problemtype and dimension", () => {
  assert.equal(estimateDofs("structural", 100, true), 300);
  assert.equal(estimateDofs("structural", 100, false), 200);
  assert.equal(estimateDofs("fluid", 100, true), 400);
  assert.equal(estimateDofs("unknown", 100, true), undefined);
});

test("automatic is reported but writes nothing", () => {
  const advice = adviseLinearSolver("structural", { linearSolver: "automatic" }, 10, true);
  assert.equal(advice?.kind, "automatic");
  assert.equal(linearSolverSettings({ linearSolver: "automatic" }), undefined);
  const findings = solverFindings(advice, true);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "solver-choice");
});

test("a problemtype without the field has no advice", () => {
  assert.equal(adviseLinearSolver("structural", {}, 10, true), undefined);
  assert.deepEqual(solverFindings(undefined, true), []);
});

test("a direct solver on a large 3D case warns; iterative or small does not", () => {
  const big = Math.ceil(DIRECT_SOLVER_DOF_LIMIT / 3) + 10;
  const direct = adviseLinearSolver("structural", { linearSolver: "LinearSolversApplication.sparse_lu" }, big, true);
  assert.ok(solverFindings(direct, true).some((f) => f.code === "solver-direct-large"));
  assert.ok(!solverFindings(direct, false).some((f) => f.code === "solver-direct-large"));
  const small = adviseLinearSolver("structural", { linearSolver: "LinearSolversApplication.sparse_lu" }, 100, true);
  assert.ok(!solverFindings(small, true).some((f) => f.code === "solver-direct-large"));
  const cg = adviseLinearSolver("structural", { linearSolver: "cg" }, big, true);
  assert.ok(!solverFindings(cg, true).some((f) => f.code === "solver-direct-large"));
});
