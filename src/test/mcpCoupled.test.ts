/**
 * MCP parity for the coupled problemtypes and the required-applications check
 * (roadmap item 16): problemtype_describe publishes the interface pairs and the
 * driver template, case_validate refuses an unbalanced interface and, with
 * checkInstall, names the applications a python cannot import, case_generate
 * writes the CoSimulation documents and records the applications, and case_run
 * refuses before launching when one is missing. The install checks run a real
 * python child against a fake `KratosMultiphysics` package; they are skipped
 * (reported, not passed) when no python is installed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { caseGenerate, caseRun, caseValidate, problemtypeDescribe } from "../mcp/tools";
import { defaultCaseState } from "../problemtype/api";
import { cosim } from "../problemtype/builtins/cosim";
import { preparedApplications } from "../problemtype/preparation";
import type { CaseState, JsonValue } from "../problemtype/types";

function findPython(): string | undefined {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["-c", "print(40+2)"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "42") return cmd;
  }
  return undefined;
}
const PYTHON = findPython();

// A fluid and a solid tetrahedron sharing the interface triangle.
const MDPA = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
5 0.0 0.0 0.0
6 1.0 0.0 0.0
7 0.0 1.0 0.0
8 0.0 0.0 -1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
2 0 5 6 7 8
End Elements

Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
2 0 5 6 7
End Conditions

Begin SubModelPart Fluid
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

Begin SubModelPart Solid
  Begin SubModelPartNodes
  5
  6
  7
  8
  End SubModelPartNodes
  Begin SubModelPartElements
  2
  End SubModelPartElements
End SubModelPart

Begin SubModelPart FluidWall
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart

Begin SubModelPart SolidWall
  Begin SubModelPartNodes
  5
  6
  7
  End SubModelPartNodes
  Begin SubModelPartConditions
  2
  End SubModelPartConditions
End SubModelPart

Begin SubModelPart Inlet
  Begin SubModelPartNodes
  4
  End SubModelPartNodes
End SubModelPart
`;

function caseFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-coupled-"));
  const mesh = path.join(dir, "flap.mdpa");
  fs.writeFileSync(mesh, MDPA);
  return mesh;
}

function cosimState(over: Record<string, JsonValue> = {}): CaseState {
  const state = defaultCaseState(cosim.decl);
  state.values.coupling = { ...state.values.coupling, ...over };
  state.assignments = [
    { conditionId: "f_parts", smpPath: "Fluid", values: {} },
    { conditionId: "fluidInterface", smpPath: "FluidWall", values: {} },
    { conditionId: "s_parts", smpPath: "Solid", values: {} },
    { conditionId: "structureInterface", smpPath: "SolidWall", values: {} },
  ];
  state.materials = [
    { smpPath: "Fluid", lawId: "newtonian_3d", values: {} },
    { smpPath: "Solid", lawId: "linear_elastic_3d", values: {} },
  ];
  return state;
}

/** A folder holding a fake KratosMultiphysics with the given applications. */
function fakeKratos(apps: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-kratos-"));
  fs.mkdirSync(path.join(root, "KratosMultiphysics"));
  fs.writeFileSync(path.join(root, "KratosMultiphysics", "__init__.py"), "");
  for (const app of apps) {
    fs.mkdirSync(path.join(root, "KratosMultiphysics", app));
    fs.writeFileSync(path.join(root, "KratosMultiphysics", app, "__init__.py"), "");
  }
  return root;
}

test("problemtype_describe publishes the interface pairs, the driver template and the applications", async () => {
  const described = (await problemtypeDescribe({ problemtype: "cosim" })) as {
    declaration: { couplingInterfaces: unknown; driverTemplate: string; applications: unknown[] };
  };
  assert.deepEqual(described.declaration.couplingInterfaces, [{ label: "Coupling interface", sides: ["fluidInterface", "structureInterface"] }]);
  assert.equal(described.declaration.driverTemplate, "cosim");
  assert.ok(described.declaration.applications.some((a) => typeof a === "object" && (a as { application: string }).application === "MeshMovingApplication"));
});

test("case_validate refuses an unbalanced interface, naming both condition labels", async () => {
  const mesh = caseFolder();
  const state = cosimState();
  state.assignments.push({ conditionId: "fluidInterface", smpPath: "Inlet", values: {} });
  const res = (await caseValidate({ meshPath: mesh, state })) as { ok: boolean; issues: string[] };
  assert.equal(res.ok, false);
  assert.match(res.issues.join("|"), /Coupling interface: 2 SubModelParts assigned as "Coupling interface \(fluid side\)" but 1 as/);
});

test("case_validate lists the applications and, with checkInstall, the missing ones", { skip: !PYTHON }, async () => {
  const mesh = caseFolder();
  const root = fakeKratos(["FluidDynamicsApplication", "StructuralMechanicsApplication"]);
  const res = (await caseValidate({
    meshPath: mesh,
    state: cosimState({ couplingType: "strong", aleMesh: true }),
    checkInstall: true,
    python: PYTHON,
    extraEnv: { PYTHONPATH: root },
  })) as { ok: boolean; applications: string[]; install: { checked: boolean; missingApplications: string[]; message: string } };
  assert.equal(res.ok, true);
  assert.ok(res.applications.includes("MeshMovingApplication"));
  assert.deepEqual(res.install.missingApplications, ["CoSimulationApplication", "MappingApplication", "MeshMovingApplication"]);
  assert.equal(res.install.checked, true);
  assert.match(res.install.message, /CoSimulationApplication, MappingApplication, MeshMovingApplication/);
});

test("case_generate writes the CoSimulation documents and records the applications", async () => {
  const mesh = caseFolder();
  const res = (await caseGenerate({ meshPath: mesh, state: cosimState({ couplingType: "strong", aleMesh: true }) })) as { written: string[] };
  const names = res.written.map((p) => path.basename(p));
  for (const name of ["ProjectParametersCoSim.json", "ProjectParametersCFD.json", "ProjectParametersCSM.json", "MainKratosCoSim.py"]) {
    assert.ok(names.includes(name), name);
  }
  const dir = path.dirname(mesh);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, "ProjectParametersCoSim.json"), "utf8")).solver_settings;
  assert.equal(settings.type, "coupled_solvers.gauss_seidel_strong");
  assert.ok(preparedApplications(dir)?.includes("MeshMovingApplication"));
  // The driver checks the applications first and records the coupling iterations.
  const driver = fs.readFileSync(path.join(dir, "MainKratosCoSim.py"), "utf8");
  assert.match(driver, /Missing Kratos applications/);
  assert.match(driver, /kkss\.cosim-convergence/);
});

test("case_run refuses before launching when the python cannot import an application", { skip: !PYTHON }, async () => {
  const mesh = caseFolder();
  await caseGenerate({ meshPath: mesh, state: cosimState() });
  const root = fakeKratos(["FluidDynamicsApplication", "StructuralMechanicsApplication", "CoSimulationApplication"]);
  await assert.rejects(
    caseRun({ meshPath: mesh, python: PYTHON, generate: false, extraEnv: { PYTHONPATH: root } }),
    /application that .*: MappingApplication\. Install it/
  );
  // Nothing was launched, so there is no run record.
  assert.equal(fs.existsSync(path.join(path.dirname(mesh), "flap.kratosrun.json")), false);
});
