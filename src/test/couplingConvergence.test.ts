/**
 * Coupling iterations in the convergence contract (roadmap item 16): the FSI
 * and CoSimulation drivers write kkss-convergence-v2.jsonl records whose
 * iterations are coupling iterations. The drivers run under a real python
 * child against stub Kratos modules shaped like the solvers they observe
 * (PartitionedFSIBaseSolver's `_CheckFSIConvergence`, a strong coupled
 * solver's `convergence_criteria_list`), so no Kratos is needed; skipped
 * (reported, not passed) when no python is installed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  COUPLING_ADAPTERS,
  convergenceRowText,
  parseConvergenceJsonl,
  summarizeConvergence,
} from "../problemtype/convergence";
import {
  COSIM_CONVERGENCE_ADAPTER,
  FSI_CONVERGENCE_ADAPTER,
  STOP_SENTINEL_MARKER,
  MAIN_KRATOS_PY,
  cosimMainKratosPy,
  driverTemplateScript,
  fsiMainKratosPy,
} from "../problemtype/mainKratosTemplate";
import { validateDeclaration } from "../problemtype/api";
import { fsi } from "../problemtype/builtins/fsi";
import { cosim } from "../problemtype/builtins/cosim";

function findPython(): string | undefined {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["-c", "print(40+2)"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "42") return cmd;
  }
  return undefined;
}
const PYTHON = findPython();
const HAS_NUMPY = !!PYTHON && spawnSync(PYTHON, ["-c", "import numpy"]).status === 0;

/** The stub KratosMultiphysics both drivers import. */
const KRATOS_INIT = [
  "import json",
  "STEP = 'STEP'",
  "TIME = 'TIME'",
  "class _Kernel:",
  "    @staticmethod",
  "    def Version(): return 'stub-10.4'",
  "class KratosGlobals:",
  "    Kernel = _Kernel",
  "class _Value:",
  "    def __init__(self, v): self.v = v",
  "    def GetString(self): return self.v",
  "    def GetDouble(self): return float(self.v)",
  "    def GetInt(self): return int(self.v)",
  "    def Has(self, key): return isinstance(self.v, dict) and key in self.v",
  "    def __getitem__(self, key): return _Value(self.v[key])",
  "class Parameters(_Value):",
  "    def __init__(self, text): super().__init__(json.loads(text) if isinstance(text, str) else text)",
  "class Model: pass",
  "",
].join("\n");

function caseFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coupling-conv-"));
  fs.mkdirSync(path.join(dir, "KratosMultiphysics"));
  fs.writeFileSync(path.join(dir, "KratosMultiphysics", "__init__.py"), KRATOS_INIT);
  return dir;
}

function run(dir: string, script: string): string {
  const file = path.join(dir, "driver.py");
  fs.writeFileSync(file, script);
  const r = spawnSync(PYTHON!, [file], { cwd: dir, encoding: "utf8", env: { ...process.env, PYTHONPATH: dir } });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(path.join(dir, "kkss-convergence-v2.jsonl"), "utf8");
}

test("coupling records parse: residual list, iteration count and the row text", () => {
  const lines = [
    { event: "step", iteration: 1, time: 0.1, converged: true, solverStepResult: true, criterion: "fsi_interface_residual", nonlinearIteration: 3, residual: 0.004, couplingResiduals: [0.5, null, 0.004, "x"] },
    { event: "end", completed: true },
  ].map((r) => JSON.stringify({ ...r, adapter: FSI_CONVERGENCE_ADAPTER, version: 2 }));
  const parsed = parseConvergenceJsonl(lines.join("\n") + "\n");
  assert.deepEqual(parsed.steps[0].couplingResiduals, [0.5, null, 0.004, null]);
  const summary = summarizeConvergence(parsed);
  assert.equal(summary.verdict, "converged");
  assert.equal(convergenceRowText(summary), "Convergence — step 1 · res 0.004 · 3 coupling iterations · converged");
  assert.ok(COUPLING_ADAPTERS.has(FSI_CONVERGENCE_ADAPTER) && COUPLING_ADAPTERS.has(COSIM_CONVERGENCE_ADAPTER));
});

test("weak coupling evaluates no criterion, so a completed run is never called converged", () => {
  const lines = [
    { event: "step", iteration: 1, time: 0.1, converged: null, solverStepResult: true, nonlinearIteration: 1, couplingResiduals: [] },
    { event: "end", completed: true },
  ].map((r) => JSON.stringify({ ...r, adapter: COSIM_CONVERGENCE_ADAPTER, version: 2 }));
  const summary = summarizeConvergence(parseConvergenceJsonl(lines.join("\n")));
  assert.equal(summary.verdict, "unavailable");
  assert.match(convergenceRowText(summary), /1 coupling iteration · unavailable/);
});

test("a declaration names its driver by template; an unknown template is refused", async () => {
  assert.equal(driverTemplateScript({}), MAIN_KRATOS_PY);
  assert.equal(driverTemplateScript({ driverTemplate: "fsi" }), fsiMainKratosPy());
  assert.equal(driverTemplateScript({ driverTemplate: "cosim", primaryDocumentName: "Co.json" }), cosimMainKratosPy("Co.json"));
  assert.equal(await cosim.mainScript({} as never), cosimMainKratosPy("ProjectParametersCoSim.json"));
  assert.match(validateDeclaration({ ...fsi.decl, driverTemplate: "mpm" as never }).join("|"), /driverTemplate must be one of standard, fsi, cosim/);
});

test("both drivers keep the cooperative stop and write every field the parser reads", async () => {
  const fsiScript = (await fsi.mainScript({} as never)) as string;
  assert.equal(fsiScript, fsiMainKratosPy());
  for (const script of [fsiMainKratosPy(), cosimMainKratosPy("ProjectParametersCoSim.json")]) {
    assert.ok(script.includes(STOP_SENTINEL_MARKER));
    for (const key of ["iteration", "time", "converged", "solverStepResult", "analysisType", "criterion", "residual", "nonlinearIteration", "residualUnavailableReason", "error", "couplingResiduals", "residualDefinition", "runtime", "criterionParameters"]) {
      assert.ok(script.includes(`"${key}"`), key);
    }
  }
});

test("the FSI driver records each step's coupling iterations and normalised residuals", { skip: !PYTHON }, () => {
  const dir = caseFolder();
  fs.writeFileSync(path.join(dir, "ProjectParameters.json"), JSON.stringify({ analysis_stage: "fake_fsi_analysis" }));
  // The shape of PartitionedFSIBaseSolver.SolveSolutionStep: check, then iterate.
  fs.writeFileSync(
    path.join(dir, "fake_fsi_analysis.py"),
    [
      "import math",
      "import KratosMultiphysics as KM",
      "class _Utilities:",
      "    def GetInterfaceResidualSize(self, part): return 4",
      "class _ModelPart:",
      "    def __init__(self): self.ProcessInfo = {KM.STEP: 0, KM.TIME: 0.0}",
      "class _Solver:",
      "    def __init__(self):",
      "        self.settings = KM.Parameters({'coupling_settings': {'nl_tol': 0.01, 'nl_max_it': 25}})",
      "        self.part = _ModelPart()",
      "        self.norms = [[1.0, 0.1, 0.01], [1.0, 0.004]]",
      "    def GetComputingModelPart(self): return self.part",
      "    def _GetPartitionedFSIUtilities(self): return _Utilities()",
      "    def _GetStructureInterfaceSubmodelPart(self): return None",
      "    def _CheckFSIConvergence(self, nl_it, residual_norm):",
      "        return residual_norm / math.sqrt(4) < 0.01",
      "    def SolveSolutionStep(self):",
      "        norms = self.norms.pop(0)",
      "        nl_it = 1",
      "        while nl_it < 25:",
      "            if self._CheckFSIConvergence(nl_it, norms[nl_it - 1]):",
      "                return True",
      "            nl_it += 1",
      "        return False",
      "class FakeFsiAnalysis:",
      "    parallel_type = 'OpenMP'",
      "    def __init__(self, model, parameters):",
      "        self.solver = _Solver()",
      "        self.time = 0.0",
      "    def _GetSolver(self): return self.solver",
      "    def Initialize(self): pass",
      "    def KeepAdvancingSolutionLoop(self): return self.solver.part.ProcessInfo[KM.STEP] < 2",
      "    def SolveSolutionStep(self): return self._GetSolver().SolveSolutionStep()",
      "    def FinalizeSolutionStep(self): pass",
      "    def Finalize(self): pass",
      "    def Run(self):",
      "        self.Initialize()",
      "        while self.KeepAdvancingSolutionLoop():",
      "            info = self.solver.part.ProcessInfo",
      "            info[KM.STEP] += 1",
      "            info[KM.TIME] += 0.5",
      "            self.SolveSolutionStep()",
      "            self.FinalizeSolutionStep()",
      "        self.Finalize()",
      "",
    ].join("\n")
  );
  const parsed = parseConvergenceJsonl(run(dir, fsiMainKratosPy()));
  assert.equal(parsed.adapter, FSI_CONVERGENCE_ADAPTER);
  assert.equal(parsed.ended, true);
  assert.deepEqual(parsed.steps.map((s) => [s.step, s.time, s.converged, s.nonlinearIteration]), [
    [1, 0.5, true, 3],
    [2, 1.0, true, 2],
  ]);
  assert.deepEqual(parsed.steps[0].couplingResiduals, [0.5, 0.05, 0.005]);
  assert.equal(parsed.steps[1].residual, 0.002);
  assert.equal(parsed.steps[0].criterion, "fsi_interface_residual");
  assert.equal(parsed.kratosVersion, "stub-10.4");
  const record = JSON.parse(fs.readFileSync(path.join(dir, "kkss-convergence-v2.jsonl"), "utf8").split("\n")[0]);
  assert.deepEqual(record.criterionParameters, { nl_tol: 0.01, nl_max_it: 25 });
  assert.equal(summarizeConvergence(parsed).verdict, "converged");
});

/** A stub CoSimulationAnalysis with the AnalysisStage loop and the coupled solver given. */
function cosimFolder(solverPy: string[]): string {
  const dir = caseFolder();
  fs.writeFileSync(path.join(dir, "ProjectParametersCoSim.json"), JSON.stringify({ problem_data: { end_time: 1.0 } }));
  const app = path.join(dir, "KratosMultiphysics", "CoSimulationApplication");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "__init__.py"), "");
  fs.writeFileSync(
    path.join(app, "co_simulation_analysis.py"),
    [
      ...solverPy,
      "class CoSimulationAnalysis:",
      "    def __init__(self, parameters):",
      "        self.end_time = parameters['problem_data']['end_time'].GetDouble()",
      "        self.solver = Solver()",
      "        self.time = 0.0",
      "        self.step = 0",
      "    def _GetSolver(self): return self.solver",
      "    def Initialize(self): pass",
      "    def KeepAdvancingSolutionLoop(self): return self.time < self.end_time - 1e-9",
      "    def SolveSolutionStep(self): return self._GetSolver().SolveSolutionStep()",
      "    def Finalize(self): pass",
      "    def Run(self):",
      "        self.Initialize()",
      "        while self.KeepAdvancingSolutionLoop():",
      "            self.time += 0.5",
      "            self.step += 1",
      "            self.SolveSolutionStep()",
      "        self.Finalize()",
      "",
    ].join("\n")
  );
  return dir;
}

test("the CoSim driver records strong coupling iterations and the largest criterion residual", { skip: !PYTHON }, () => {
  // Two criteria (two interface pairs); the second converges more slowly.
  const dir = cosimFolder([
    "class _Criterion:",
    "    abs_tolerance = 1e-3",
    "    rel_tolerance = 1e-5",
    "    def IsConverged(self, residual, current_data):",
    "        return max(abs(v) for v in residual) < 1e-3",
    "class _Wrapper:",
    "    def __init__(self, scale): self.conv_crit = _Criterion(); self.scale = scale; self.k = 0",
    "    def IsConverged(self):",
    "        value = self.scale * 0.1 ** self.k",
    "        self.k += 1",
    "        return self.conv_crit.IsConverged([value] * 4, [1.0] * 4)",
    "class Solver:",
    "    num_coupling_iterations = 10",
    "    def __init__(self):",
    "        self.convergence_criteria_list = [_Wrapper(0.1), _Wrapper(1.0)]",
    "    def SolveSolutionStep(self):",
    "        for wrapper in self.convergence_criteria_list: wrapper.k = 0",
    "        for k in range(self.num_coupling_iterations):",
    "            if all([c.IsConverged() for c in self.convergence_criteria_list]):",
    "                return True",
    "        return False",
  ]);
  const parsed = parseConvergenceJsonl(run(dir, cosimMainKratosPy("ProjectParametersCoSim.json")));
  assert.equal(parsed.adapter, COSIM_CONVERGENCE_ADAPTER);
  assert.equal(parsed.steps.length, 2);
  const first = parsed.steps[0];
  assert.equal(first.converged, true);
  assert.equal(first.criterion, "relative_norm_previous_residual");
  assert.equal(first.nonlinearIteration, 5); // the slower pair falls from 1.0 below 1e-3 at the fifth
  if (HAS_NUMPY) {
    assert.deepEqual(first.couplingResiduals?.map((v) => Number(v?.toPrecision(6))), [1, 0.1, 0.01, 0.001, 0.0001]);
    assert.equal(Number(first.residual?.toPrecision(6)), 0.0001);
  } else {
    assert.equal(first.residual, undefined);
    assert.match(first.residualUnavailableReason ?? "", /did not expose a readable residual/);
  }
  const record = JSON.parse(fs.readFileSync(path.join(dir, "kkss-convergence-v2.jsonl"), "utf8").split("\n")[0]);
  assert.deepEqual(record.criterionParameters, { num_coupling_iterations: 10, abs_tolerance: 1e-3, rel_tolerance: 1e-5 });
  assert.equal(summarizeConvergence(parsed).verdict, "converged");
});

test("the CoSim driver records a weak coupling as unevaluated", { skip: !PYTHON }, () => {
  const dir = cosimFolder(["class Solver:", "    def SolveSolutionStep(self): return True"]);
  const parsed = parseConvergenceJsonl(run(dir, cosimMainKratosPy("ProjectParametersCoSim.json")));
  assert.deepEqual(parsed.steps.map((s) => [s.converged, s.solverStepResult, s.nonlinearIteration, s.criterion]), [
    [null, true, 1, "none (weak coupling)"],
    [null, true, 1, "none (weak coupling)"],
  ]);
  assert.match(parsed.steps[0].residualUnavailableReason ?? "", /Weak coupling/);
  const summary = summarizeConvergence(parsed);
  assert.equal(summary.completed, true);
  assert.equal(summary.verdict, "unavailable");
});

test("a coupled solve that raises is recorded as an error, and the driver still fails", { skip: !PYTHON }, () => {
  const dir = cosimFolder(["class Solver:", "    def SolveSolutionStep(self): raise RuntimeError('mapper failed')"]);
  const file = path.join(dir, "driver.py");
  fs.writeFileSync(file, cosimMainKratosPy("ProjectParametersCoSim.json"));
  const r = spawnSync(PYTHON!, [file], { cwd: dir, encoding: "utf8", env: { ...process.env, PYTHONPATH: dir } });
  assert.notEqual(r.status, 0);
  const parsed = parseConvergenceJsonl(fs.readFileSync(path.join(dir, "kkss-convergence-v2.jsonl"), "utf8"));
  assert.equal(parsed.steps[0].error, "mapper failed");
  assert.equal(summarizeConvergence(parsed).verdict, "solver-error");
});
