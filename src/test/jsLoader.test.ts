import { test } from "node:test";
import assert from "node:assert/strict";

import { loadJsProblemtypes } from "../problemtype/jsLoader";
import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";

const VALID = `
defineProblemtype({
  id: "customThermal",
  name: "Custom Thermal",
  analysisStage: "KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis",
  modelPartName: "ThermalModelPart",
  materialsFileName: "ThermalMaterials.json",
  domainSizes: [2, 3],
  sections: [
    { id: "problem", label: "Problem data", fields: [
      { id: "timeStep", label: "Δt", type: "number", default: 0.5 },
      { id: "endTime", label: "End time", type: "number", default: 10 },
    ] },
  ],
  conditions: [
    { id: "temperature", label: "Fixed temperature", list: "constraints_process_list", target: "any",
      fields: [{ id: "value", label: "T", type: "number", default: 0 }],
      processTemplate: {
        python_module: "assign_scalar_variable_process",
        kratos_module: "KratosMultiphysics",
        process_name: "AssignScalarVariableProcess",
        Parameters: { model_part_name: "$path", variable_name: "TEMPERATURE",
                      value: "$field:value", constrained: true },
      } },
  ],
  materialLaws: [],
  output: { nodalDefaults: ["TEMPERATURE"] },
}, {
  solverSettings: (v, ctx) => ({
    solver_type: "transient",
    model_part_name: ctx.modelPartName,
    domain_size: ctx.domainSize,
    model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
    material_import_settings: { materials_filename: ctx.materialsFileName },
    time_stepping: { time_step: v.timeStep },
  }),
});
`;

const MDPA = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin SubModelPart Boundary
  Begin SubModelPartNodes
  1
  2
  End SubModelPartNodes
End SubModelPart
`;

test("loadJsProblemtypes runs the file in a sandbox and returns runtimes", async () => {
  const [runtime] = loadJsProblemtypes(VALID, "custom.js");
  assert.equal(runtime.decl.id, "customThermal");
  assert.equal(runtime.source, "js");

  // The captured hooks work end-to-end through the generator.
  const model = parseMdpa(MDPA);
  const state = defaultCaseState(runtime.decl);
  state.values.problem.timeStep = 0.25;
  state.assignments = [{ conditionId: "temperature", smpPath: "Boundary", values: { value: 100 } }];
  const out = await generateCase(runtime, model, state, "plate");
  const pp = JSON.parse(out.projectParameters);
  assert.equal(pp.solver_settings.time_stepping.time_step, 0.25);
  assert.equal(pp.solver_settings.domain_size, 2);
  assert.equal(
    pp.processes.constraints_process_list[0].Parameters.model_part_name,
    "ThermalModelPart.Boundary"
  );
  assert.equal(pp.processes.constraints_process_list[0].Parameters.value, 100);
});

test("loadJsProblemtypes rejects files that define nothing", () => {
  assert.throws(() => loadJsProblemtypes("const x = 1;", "empty.js"), /defined no problemtype/);
});

test("loadJsProblemtypes surfaces syntax and validation errors", () => {
  assert.throws(() => loadJsProblemtypes("this is not js {", "broken.js"));
  assert.throws(
    () => loadJsProblemtypes('defineProblemtype({ id: "x" }, { solverSettings: () => ({}) });', "invalid.js"),
    /Invalid problemtype/
  );
});

test("loadJsProblemtypes times out runaway top-level code", () => {
  assert.throws(() => loadJsProblemtypes("while (true) {}", "loop.js"), /timed out|Script execution/i);
});

test("the sandbox exposes no require/process and mutes console", () => {
  assert.throws(() => loadJsProblemtypes('require("fs");', "escape1.js"), /require is not defined/);
  assert.throws(() => loadJsProblemtypes("process.exit(1);", "escape2.js"), /process is not defined/);
  // console.log must be callable but inert (and still "defined no problemtype").
  assert.throws(() => loadJsProblemtypes('console.log("hi");', "quiet.js"), /defined no problemtype/);
});
