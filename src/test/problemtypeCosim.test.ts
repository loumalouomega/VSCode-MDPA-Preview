import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase, domainProblems } from "../problemtype/generate";
import { planCaseMesh } from "../problemtype/caseMesh";
import { defaultCaseState, validateDeclaration } from "../problemtype/api";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { cosim } from "../problemtype/builtins/cosim";
import { fluid } from "../problemtype/builtins/fluid";
import { structural } from "../problemtype/builtins/structural";
import { STOP_SENTINEL_MARKER, scriptHonoursStopSentinel } from "../problemtype/mainKratosTemplate";
import { parsePreparationReport, writePreparedCase } from "../problemtype/preparation";
import { CaseState } from "../problemtype/types";

// The mesh of problemtypeCoupled.test.ts: a fluid tetrahedron and a solid one, an
// interface face on each, the same SubModelParts. Copied rather than imported, so
// this file does not re-run that file's tests.
const MDPA = `Begin Properties 0
End Properties

Begin Nodes
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

function cosimState(): CaseState {
  const state = defaultCaseState(cosim.decl);
  state.assignments = [
    { conditionId: "f_parts", smpPath: "Fluid", values: {} },
    { conditionId: "f_inlet", smpPath: "Inlet", values: { modulus: 2 } },
    { conditionId: "fluidInterface", smpPath: "FluidWall", values: {} },
    { conditionId: "s_parts", smpPath: "Solid", values: {} },
    { conditionId: "s_displacement", smpPath: "SolidWall", values: {} },
    { conditionId: "structureInterface", smpPath: "SolidWall", values: {} },
  ];
  state.materials = [
    { smpPath: "Fluid", lawId: "newtonian_3d", values: {} },
    { smpPath: "Solid", lawId: "linear_elastic_3d", values: {} },
  ];
  return state;
}

const documentOf = (out: { extraFiles: { name: string; content: string }[] }, name: string) =>
  JSON.parse(out.extraFiles.find((f) => f.name === name)!.content);

test("cosim: a valid coupled declaration, registered with the built-ins", () => {
  assert.deepEqual(validateDeclaration(cosim.decl), []);
  assert.equal(cosim.decl.family, "coupled");
  assert.equal(cosim.decl.primaryDocumentName, "ProjectParametersCoSim.json");
  assert.equal(cosim.decl.driverScriptName, "MainKratosCoSim.py");
  assert.ok(BUILTIN_PROBLEMTYPES.some((r) => r.decl.id === "cosim"));
});

test("a declaration's primary document and driver names are plain file names with the right extension", () => {
  assert.match(
    validateDeclaration({ ...cosim.decl, primaryDocumentName: "../escape.json" }).join("|"),
    /primaryDocumentName must be a plain file name ending in \.json/
  );
  assert.match(
    validateDeclaration({ ...cosim.decl, driverScriptName: "driver.json" }).join("|"),
    /driverScriptName must be a plain file name ending in \.py/
  );
});

test("cosim: one coupling document, one document per participant, and the driver", async () => {
  const out = await generateCase(cosim, parseMdpa(MDPA), cosimState(), "flap");
  assert.equal(out.primaryDocumentName, "ProjectParametersCoSim.json");
  assert.equal(out.driverScriptName, "MainKratosCoSim.py");

  const primary = JSON.parse(out.projectParameters);
  assert.deepEqual(Object.keys(primary).sort(), ["problem_data", "solver_settings"]);
  assert.equal(primary.problem_data.problem_name, "flap");
  const settings = primary.solver_settings;
  assert.equal(settings.type, "coupled_solvers.gauss_seidel_weak");
  assert.deepEqual(settings.coupling_sequence.map((s: { name: string }) => s.name), ["fluid", "structure"]);
  assert.equal(settings.solvers.fluid.type, "solver_wrappers.kratos.fluid_dynamics_wrapper");
  assert.equal(settings.solvers.fluid.solver_wrapper_settings.input_file, "ProjectParametersCFD.json");
  assert.equal(settings.solvers.structure.type, "solver_wrappers.kratos.structural_mechanics_wrapper");
  assert.equal(settings.solvers.structure.solver_wrapper_settings.input_file, "ProjectParametersCSM.json");
  // The interface data is one pair, on the fluid and the structure interface SubModelParts.
  assert.deepEqual(settings.solvers.fluid.data.fluid_interface_load, {
    model_part_name: "FluidModelPart.FluidWall",
    variable_name: "REACTION",
    dimension: 3,
  });
  assert.deepEqual(settings.solvers.structure.data.structure_interface_load, {
    model_part_name: "Structure.SolidWall",
    variable_name: "POINT_LOAD",
    dimension: 3,
  });
  assert.deepEqual(settings.predictors, [{ type: "average_value_based", beta: 0.5 }]);
  assert.equal(settings.data_transfer_operators.kratos_mapping.type, "kratos_mapping");

  const cfd = documentOf(out, "ProjectParametersCFD.json");
  const csm = documentOf(out, "ProjectParametersCSM.json");
  assert.equal(cfd.analysis_stage, fluid.decl.analysisStage);
  assert.equal(cfd.problem_data.problem_name, "flap_Fluid");
  assert.equal(cfd.solver_settings.model_import_settings.input_filename, "flap_Fluid");
  // The interface is a skin of the fluid solver, though it is not one of its processes.
  assert.ok(cfd.solver_settings.skin_parts.includes("FluidModelPart.FluidWall"));
  assert.ok(cfd.solver_settings.skin_parts.includes("FluidModelPart.Inlet"));
  assert.ok(JSON.stringify(cfd.processes).includes("FluidModelPart.Inlet"));
  assert.ok(!JSON.stringify(cfd.processes).includes("FluidModelPart.FluidWall"));

  assert.equal(csm.analysis_stage, structural.decl.analysisStage);
  assert.equal(csm.problem_data.problem_name, "flap_Structural");
  assert.equal(csm.solver_settings.model_import_settings.input_filename, "flap_Structural");
  // Both participants advance with the same time stepping.
  assert.deepEqual(csm.solver_settings.time_stepping, cfd.solver_settings.time_stepping);
  assert.equal(csm.output_processes.vtk_output[0].Parameters.model_part_name, "Structure");
  assert.deepEqual(csm.output_processes.vtk_output[0].Parameters.nodal_solution_step_data_variables, structural.decl.output.nodalDefaults);

  // One materials file per physics, each against its own root model part.
  assert.equal(out.materialsFileName, "FluidMaterials.json");
  assert.equal(JSON.parse(out.materials).properties[0].model_part_name, "FluidModelPart.Fluid");
  const structureMaterials = out.extraFiles.find((f) => f.name === "StructuralMaterials.json");
  assert.equal(JSON.parse(structureMaterials!.content).properties[0].model_part_name, "Structure.Solid");

  // The driver reads the coupling document and carries the cooperative stop.
  assert.ok(out.mainScript.includes('open("ProjectParametersCoSim.json"'));
  assert.ok(out.mainScript.includes("CoSimulationAnalysisWithStop"));
  assert.ok(out.mainScript.includes(STOP_SENTINEL_MARKER));
  assert.ok(scriptHonoursStopSentinel(out.mainScript));
});

test("cosim: a missing or doubled interface refuses generation before anything is written", async () => {
  const model = parseMdpa(MDPA);
  const missing = cosimState();
  missing.assignments = missing.assignments.filter((a) => a.conditionId !== "fluidInterface");
  await assert.rejects(() => generateCase(cosim, model, missing, "flap"), /Coupling interface \(fluid side\)/);
  assert.match(domainProblems(cosim.decl, missing.assignments).join("|"), /Domain "Fluid"/);

  const doubled = cosimState();
  doubled.assignments.push({ conditionId: "fluidInterface", smpPath: "Inlet", values: {} });
  await assert.rejects(() => generateCase(cosim, model, doubled, "flap"), /couples one interface pair: .*\(2 fluid, 1 structure\)/);
});

test("cosim: the source mesh is sliced into one mesh per physics", () => {
  const plan = planCaseMesh(cosim, parseMdpa(MDPA), cosimState(), "flap", true);
  assert.deepEqual(plan.domainMeshes.map((m) => m.stem), ["flap_Fluid", "flap_Structural"]);
});

test("cosim: the preparation record names the coupling document and the driver", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cosim-prep-"));
  try {
    const mesh = path.join(dir, "flap.mdpa");
    fs.writeFileSync(mesh, MDPA);
    const state = cosimState();
    const out = await generateCase(cosim, parseMdpa(MDPA), state, "flap");
    writePreparedCase({
      directory: dir, sourcePath: mesh, solverMeshPath: mesh, runtime: cosim, state, generated: out, warnings: [],
    });
    const report = parsePreparationReport(fs.readFileSync(path.join(dir, "kkss-preparation-v1.json"), "utf8"));
    assert.equal(report.primaryDocument, "ProjectParametersCoSim.json");
    assert.equal(report.driverScript, "MainKratosCoSim.py");
    assert.ok(report.inputs.some((input) => input.name === "ProjectParametersCFD.json"));
    assert.ok(report.inputs.some((input) => input.name === "MainKratosCoSim.py"));
    assert.ok(fs.existsSync(path.join(dir, "ProjectParametersCoSim.json")));
    assert.ok(fs.existsSync(path.join(dir, "MainKratosCoSim.py")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;
test("cosim: the generated driver is valid Python", { skip: !hasPython }, async () => {
  const out = await generateCase(cosim, parseMdpa(MDPA), cosimState(), "flap");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cosim-driver-"));
  try {
    const file = path.join(dir, "MainKratosCoSim.py");
    fs.writeFileSync(file, out.mainScript);
    const check = spawnSync("python3", ["-c", "import ast, sys; ast.parse(open(sys.argv[1], 'rb').read())", file]);
    assert.equal(check.status, 0, String(check.stderr));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
