import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { loadJsProblemtypes } from "../problemtype/jsLoader";
import { loadPyProblemtypes } from "../problemtype/pyRuntime";

// Pyodide is a real dependency but heavyweight; skip cleanly when absent so
// plain checkouts without node_modules extras still pass.
let pyodideAvailable = true;
try {
  require.resolve("pyodide");
} catch {
  pyodideAvailable = false;
}

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

// The same problemtype authored in both languages — outputs must match.
const JS_SRC = `
defineProblemtype({
  id: "parityThermal",
  name: "Parity Thermal",
  analysisStage: "KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis",
  modelPartName: "ThermalModelPart",
  materialsFileName: "ThermalMaterials.json",
  domainSizes: [2, 3],
  sections: [
    { id: "problem", label: "Problem data", fields: [
      { id: "timeStep", label: "\\u0394t", type: "number", default: 0.5 },
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

const PY_SRC = `
from kratos_problemtype import define_problemtype, section, field, condition

def solver_settings(values, ctx):
    return {
        "solver_type": "transient",
        "model_part_name": ctx["model_part_name"],
        "domain_size": ctx["domain_size"],
        "model_import_settings": {"input_type": "mdpa", "input_filename": ctx["mdpa_stem"]},
        "material_import_settings": {"materials_filename": ctx["materials_file_name"]},
        "time_stepping": {"time_step": values["timeStep"]},
    }

define_problemtype(
    id="parityThermal",
    name="Parity Thermal",
    analysis_stage="KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis",
    model_part_name="ThermalModelPart",
    materials_file_name="ThermalMaterials.json",
    domain_sizes=[2, 3],
    sections=[section("problem", "Problem data",
                      field("timeStep", "\\u0394t", "number", default=0.5),
                      field("endTime", "End time", "number", default=10))],
    conditions=[condition("temperature", "Fixed temperature",
                          list="constraints_process_list", target="any",
                          fields=[field("value", "T", "number", default=0)],
                          process_template={
                              "python_module": "assign_scalar_variable_process",
                              "kratos_module": "KratosMultiphysics",
                              "process_name": "AssignScalarVariableProcess",
                              "Parameters": {"model_part_name": "$path",
                                             "variable_name": "TEMPERATURE",
                                             "value": "$field:value",
                                             "constrained": True}})],
    output={"nodal_defaults": ["TEMPERATURE"]},
    solver_settings=solver_settings,
)
`;

test("python problemtype ≡ JS problemtype (declaration + generated case)", { skip: !pyodideAvailable }, async () => {
  const [jsRt] = loadJsProblemtypes(JS_SRC, "parity.js");
  const [pyRt] = await loadPyProblemtypes(PY_SRC, "parity.py");

  assert.equal(pyRt.source, "py");
  // JSON round-trip: the JS decl was born in a vm realm, so prototypes differ
  // even though the structures are identical (decls are JSON-able by design).
  assert.deepEqual(
    JSON.parse(JSON.stringify(pyRt.decl)),
    JSON.parse(JSON.stringify(jsRt.decl))
  );

  const model = parseMdpa(MDPA);
  const mkState = (decl: typeof jsRt.decl) => {
    const s = defaultCaseState(decl);
    s.values.problem.timeStep = 0.25;
    s.assignments = [{ conditionId: "temperature", smpPath: "Boundary", values: { value: 100 } }];
    return s;
  };
  const jsOut = await generateCase(jsRt, model, mkState(jsRt.decl), "plate");
  const pyOut = await generateCase(pyRt, model, mkState(pyRt.decl), "plate");
  assert.equal(pyOut.projectParameters, jsOut.projectParameters);
  assert.equal(pyOut.materials, jsOut.materials);
  assert.equal(pyOut.mainScript, jsOut.mainScript);
});

test("python loader rejects empty and hook-less files", { skip: !pyodideAvailable }, async () => {
  await assert.rejects(loadPyProblemtypes("x = 1", "empty.py"), /defined no problemtype/);
  await assert.rejects(
    loadPyProblemtypes(
      `from kratos_problemtype import define_problemtype
define_problemtype(id="x", name="X", analysis_stage="a.b", model_part_name="M",
                   materials_file_name="M.json", domain_sizes=[3],
                   output={"nodal_defaults": []})`,
      "nohook.py"
    ),
    /solver_settings/
  );
});

test("python syntax errors surface as load failures", { skip: !pyodideAvailable }, async () => {
  await assert.rejects(loadPyProblemtypes("def broken(:", "broken.py"));
});

// A minimal valid problemtype using the sugar helpers (process(), INTERVAL_TOTAL).
const SUGAR_SRC = `
from kratos_problemtype import (define_problemtype, section, field, condition,
                                process, INTERVAL_TOTAL)

define_problemtype(
    id="sugar", name="Sugar",
    analysis_stage="KratosMultiphysics.X.y_analysis",
    model_part_name="Root", materials_file_name="M.json", domain_sizes=[3],
    sections=[section("problem", "P", field("endTime", "End", "number", default=1.0))],
    conditions=[condition("bc", "BC", fields=[field("value", "V", "number", default=0)],
                          process_template=process(
                              "assign_scalar_variable_process",
                              parameters={"model_part_name": "$path",
                                          "value": "$field:value",
                                          "interval": INTERVAL_TOTAL}))],
    output={"nodal_defaults": []},
    solver_settings=lambda values, ctx: {"solver_type": "static"},
)
`;

test("process() helper derives the CamelCase process_name and INTERVAL_TOTAL rides along", { skip: !pyodideAvailable }, async () => {
  const [rt] = await loadPyProblemtypes(SUGAR_SRC, "sugar.py");
  const template = rt.decl.conditions[0].processTemplate as {
    python_module: string;
    kratos_module: string;
    process_name: string;
    Parameters: { interval: [number, string] };
  };
  assert.equal(template.python_module, "assign_scalar_variable_process");
  assert.equal(template.kratos_module, "KratosMultiphysics");
  assert.equal(template.process_name, "AssignScalarVariableProcess");
  assert.deepEqual(template.Parameters.interval, [0, "End"]);
});

test("python API validates eagerly with the offending id in the message", { skip: !pyodideAvailable }, async () => {
  const define = (body: string): string =>
    `from kratos_problemtype import define_problemtype, section, field, condition\n${body}`;
  // Unknown field type.
  await assert.rejects(
    loadPyProblemtypes(define(`field("f1", "F", "floaty")`), "badtype.py"),
    /f1.*unknown type/s
  );
  // Enum without options.
  await assert.rejects(
    loadPyProblemtypes(define(`field("mode", "M", "enum")`), "badenum.py"),
    /mode.*options/s
  );
  // Unknown process list.
  await assert.rejects(
    loadPyProblemtypes(define(`condition("bc", "BC", list="nope_list")`), "badlist.py"),
    /bc.*unknown list/s
  );
  // Duplicate field ids across sections.
  await assert.rejects(
    loadPyProblemtypes(
      define(
        `define_problemtype(id="dup", name="D", analysis_stage="a.b",
                            model_part_name="R", materials_file_name="M.json",
                            domain_sizes=[3],
                            sections=[section("a", "A", field("x", "X", "number")),
                                      section("b", "B", field("x", "X", "number"))],
                            output={"nodal_defaults": []},
                            solver_settings=lambda v, c: {})`
      ),
      "dupfield.py"
    ),
    /duplicate field id "x"/
  );
  // parts_condition referencing a missing condition.
  await assert.rejects(
    loadPyProblemtypes(
      define(
        `define_problemtype(id="pc", name="P", analysis_stage="a.b",
                            model_part_name="R", materials_file_name="M.json",
                            domain_sizes=[3], parts_condition="nope",
                            output={"nodal_defaults": []},
                            solver_settings=lambda v, c: {})`
      ),
      "badparts.py"
    ),
    /parts_condition "nope"/
  );
});
