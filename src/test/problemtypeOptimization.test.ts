import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState, validateDeclaration } from "../problemtype/api";
import { newEntry, renameEntry } from "../problemtype/collections";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { optimization, OPTIMIZATION_COLLECTIONS } from "../problemtype/builtins/optimization";
import { scriptHonoursStopSentinel } from "../problemtype/mainKratosTemplate";
import type { CaseState, JsonObject } from "../problemtype/types";

// One tetrahedron with a solid part, a support (nodes), a loaded face (a
// condition) and a shell-like face part for the surface controls.
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

Begin Conditions SurfaceCondition3D3N
1 0 2 3 4
End Conditions

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

Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Load
  Begin SubModelPartNodes
  2
  3
  4
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart
`;

const decl = optimization.decl;
const spec = (id: string) => OPTIMIZATION_COLLECTIONS.find((c) => c.id === id)!;

/** A complete static primal: body, support, a surface pressure and a linear elastic material. */
function baseCase(): CaseState {
  const state = defaultCaseState(decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Solid", values: {} },
    { conditionId: "displacement", smpPath: "Support", values: {} },
    { conditionId: "surfacePressure", smpPath: "Load", values: { value: 1000 } },
  ];
  state.materials = [{ smpPath: "Solid", lawId: "linear_elastic_3d", values: {} }];
  return state;
}

function withControl(state: CaseState, type: string, name: string, parts: string[], values: Record<string, unknown> = {}): CaseState {
  const entry = newEntry(spec("controls"), type, name);
  entry.parts = parts;
  Object.assign(entry.values, values);
  return { ...state, collections: { ...state.collections, controls: [...(state.collections?.controls ?? []), entry] } };
}

function withConstraint(state: CaseState, response: string, values: Record<string, unknown> = {}): CaseState {
  const entry = newEntry(spec("constraints"), "limit", `limit_${response}`);
  Object.assign(entry.values, { response, ...values });
  return { ...state, collections: { ...state.collections, constraints: [...(state.collections?.constraints ?? []), entry] } };
}

const setValues = (state: CaseState, values: Record<string, unknown>): CaseState => ({
  ...state,
  values: { ...state.values, algorithm: { ...state.values.algorithm, ...values } as JsonObject },
});

async function generate(state: CaseState) {
  const out = await generateCase(optimization, parseMdpa(MDPA), state, "case");
  const extra = (name: string) => out.extraFiles.find((f) => f.name === name)?.content;
  return { out, opt: JSON.parse(out.projectParameters) as JsonObject, primal: JSON.parse(extra("primal_parameters.json")!) as JsonObject, extra };
}

test("registered as a valid optimization-family builtin with default responses", () => {
  assert.ok(BUILTIN_PROBLEMTYPES.includes(optimization));
  assert.deepEqual(validateDeclaration(decl), []);
  assert.equal(decl.family, "optimization");
  assert.equal(decl.primaryDocumentName, "optimization_parameters.json");
  assert.equal(decl.driverScriptName, "MainKratosOpt.py");
  const state = defaultCaseState(decl);
  assert.deepEqual(state.collections!.responses.map((r) => [r.name, r.type]), [["mass", "mass"], ["strain_energy", "strainEnergy"]]);
  assert.deepEqual(state.collections!.controls, []);
  assert.equal(state.values.algorithm.objectiveResponse, "strain_energy");
});

test("the default case is refused until a control is defined", async () => {
  await assert.rejects(() => generateCase(optimization, parseMdpa(MDPA), baseCase(), "case"), /Controls: add at least 1/);
});

test("material control + steepest descent: the shape of Kratos' algorithm_steepest_descent test", async () => {
  const state = withControl(setValues(baseCase(), { initStep: 1e9, maxIter: 10 }), "material", "material_control", ["Solid"]);
  const { out, opt, primal, extra } = await generate(state);
  assert.equal(out.primaryDocumentName, "optimization_parameters.json");
  assert.deepEqual(Object.keys(opt), ["problem_data", "model_parts", "analyses", "responses", "controls", "algorithm_settings", "processes"]);
  assert.deepEqual(opt.model_parts, [{ settings: { model_part_name: "Structure", domain_size: 3, input_filename: "case" } }]);
  assert.deepEqual(opt.analyses, [
    {
      name: "primal",
      type: "kratos_analysis_execution_policy",
      settings: {
        model_part_names: ["Structure"],
        analysis_module: "KratosMultiphysics.StructuralMechanicsApplication",
        analysis_type: "StructuralMechanicsAnalysis",
        analysis_settings: { "@include_json": "primal_parameters.json" },
        analysis_output_settings: { nodal_solution_step_data_variables: ["DISPLACEMENT", "REACTION"] },
      },
    },
  ]);
  assert.deepEqual(opt.responses, [
    { name: "mass", type: "mass_response_function", settings: { evaluated_model_part_names: ["Structure"], perturbation_size: 1e-6 } },
    {
      name: "strain_energy",
      type: "linear_strain_energy_response_function",
      settings: { evaluated_model_part_names: ["Structure"], primal_analysis_name: "primal", perturbation_size: 1e-8 },
    },
  ]);
  assert.deepEqual(opt.controls, [
    {
      name: "material_control",
      type: "material.material_properties_control",
      settings: { model_part_names: ["Structure.Solid"], control_variable_name: "YOUNG_MODULUS", consider_recursive_property_update: false },
    },
  ]);
  assert.deepEqual(opt.algorithm_settings, {
    type: "algorithm_steepest_descent",
    settings: {
      echo_level: 0,
      line_search: { type: "const_step", init_step: 1e9, gradient_scaling: "inf_norm" },
      conv_settings: { max_iter: 10 },
    },
    controls: ["material_control"],
    objective: { response_expression: "strain_energy", type: "minimization", scaling: 1.0 },
  });
  const processes = opt.processes as JsonObject;
  assert.deepEqual(processes.kratos_processes, {
    auxiliary_processes: [{ python_module: "kkss_optimization_stop", process_name: "OptimizationStopProcess", Parameters: {} }],
  });
  const outputs = (processes.optimization_data_processes as JsonObject).output_processes as JsonObject[];
  assert.deepEqual(outputs.map((o) => o.type), ["optimization_problem_ascii_output_process", "optimization_problem_vtu_output_process"]);
  assert.equal((outputs[0].settings as JsonObject).output_file_name, "summary.csv");
  assert.equal((outputs[1].settings as JsonObject).file_name, "<model_part_full_name>_0");
  assert.equal((outputs[1].settings as JsonObject).output_path, "Optimization_Results");

  // The primal is the Structural document, reading the optimizer's model part.
  assert.equal(primal.analysis_stage, "KratosMultiphysics.StructuralMechanicsApplication.structural_mechanics_analysis");
  const settings = primal.solver_settings as JsonObject;
  assert.deepEqual(settings.model_import_settings, { input_type: "use_input_model_part" });
  assert.deepEqual(settings.material_import_settings, { materials_filename: "StructuralMaterials.json" });
  assert.deepEqual(primal.output_processes, {});
  const loads = (primal.processes as JsonObject).loads_process_list as JsonObject[];
  assert.equal(((loads[0].Parameters as JsonObject).model_part_name), "Structure.Load");
  assert.equal(out.materialsFileName, "StructuralMaterials.json");
  assert.match(out.materials, /YOUNG_MODULUS/);
  assert.match(extra("kkss_optimization_stop.py")!, /def Factory\(settings, model\)/);
  assert.ok(scriptHonoursStopSentinel(out.mainScript));
  assert.match(out.mainScript, /OptimizationAnalysis\(model, parameters\)/);
  assert.match(out.mainScript, /open\("optimization_parameters\.json"/);
});

test("thickness + gradient projection + <= constraint: the shape of Kratos' gradient-projection test", async () => {
  let state = setValues(baseCase(), { algorithmType: "algorithm_gradient_projection", objectiveResponse: "mass", correctionSize: 2e-2 });
  state = withControl(state, "thickness", "thickness_control", ["Load"]);
  state = withConstraint(state, "strain_energy", { violationScaling: 5.0 });
  const { opt } = await generate(state);
  const algorithm = opt.algorithm_settings as JsonObject;
  assert.equal(algorithm.type, "algorithm_gradient_projection");
  assert.deepEqual((algorithm.settings as JsonObject).linear_solver_settings, { solver_type: "LinearSolversApplication.dense_col_piv_householder_qr" });
  assert.equal((algorithm.settings as JsonObject).correction_size, 2e-2);
  assert.deepEqual(algorithm.constraints, [
    { response_expression: "strain_energy", type: "<=", scaled_ref_value: "initial_value", scaling: 1.0, violation_scaling: 5.0 },
  ]);
  assert.deepEqual((opt.controls as JsonObject[])[0], {
    name: "thickness_control",
    type: "thickness.shell_thickness_control",
    settings: {
      controlled_model_part_names: ["Structure.Load"],
      filter_settings: { filter_type: "implicit_filter", filter_radius: 0.2, filtering_boundary_conditions: {} },
      output_all_fields: false,
      physical_thicknesses: [0.1, 0.2],
      thickness_projection_settings: {
        type: "adaptive_sigmoidal_projection",
        initial_value: 5,
        max_value: 30,
        increase_fac: 1.05,
        update_period: 50,
        penalty_factor: 1,
      },
    },
  });
});

test("relaxed gradient projection writes the RGP constraint form and a fixed reference value", async () => {
  let state = setValues(baseCase(), { algorithmType: "algorithm_relaxed_gradient_projection", objectiveResponse: "mass" });
  state = withControl(state, "material", "stiffness", ["Solid"]);
  state = withConstraint(state, "strain_energy", { refMode: "value", refValue: 0.5 });
  const { opt } = await generate(state);
  const algorithm = opt.algorithm_settings as JsonObject;
  assert.deepEqual(algorithm.constraints, [
    { response_expression: "strain_energy", type: "<=", scaled_ref_value: 0.5, buffer_factor: 2.0, max_w_c: 10.0, tolerance: 1e-3 },
  ]);
  const settings = algorithm.settings as JsonObject;
  assert.equal(settings.history_size, 20);
  assert.equal(settings.max_inner_iter, 20);
  assert.equal(settings.buffer_coeff_update_factor, 0.1);
});

test("shape control: explicit vertex morphing with damped parts; SIMP: paired materials and projections", async () => {
  let state = withControl(baseCase(), "shape", "shape_control", ["Load"], { dampedParts: ["Support"], filterRadius: 25, dampZ: false });
  state = withControl(state, "simp", "topology", ["Solid"]);
  state = setValues(state, { lsType: "QNBB_step", maxStep: 1e10, convCriterion: "l2_conv_criterion", convTolerance: 1e-9 });
  const { opt } = await generate(state);
  const [shape, simp] = opt.controls as JsonObject[];
  assert.deepEqual(shape.settings, {
    controlled_model_part_names: ["Structure.Load"],
    filter_settings: {
      filter_type: "explicit_filter",
      filter_function_type: "linear",
      filter_radius_settings: { filter_radius_type: "constant", filter_radius: 25 },
      filtering_boundary_conditions: {
        damping_type: "nearest_entity",
        damping_function_type: "cosine",
        damped_model_part_settings: { "Structure.Support": [true, true, false] },
      },
    },
    mesh_motion_solver_type: "none",
    output_all_fields: true,
  });
  const simpSettings = simp.settings as JsonObject;
  assert.equal(simp.type, "material.simp_control");
  assert.deepEqual(simpSettings.list_of_materials, [
    { density: 0, young_modulus: 2.1e6 },
    { density: 7850, young_modulus: 2.1e11 },
  ]);
  assert.equal((simpSettings.young_modulus_projection_settings as JsonObject).penalty_factor, 3);
  assert.equal((simpSettings.density_projection_settings as JsonObject).penalty_factor, 1);
  const settings = (opt.algorithm_settings as JsonObject).settings as JsonObject;
  assert.deepEqual(settings.line_search, { type: "QNBB_step", init_step: 0.01, gradient_scaling: "inf_norm", max_step: 1e10 });
  assert.deepEqual(settings.conv_settings, {
    max_iter: 10,
    type: "l2_conv_criterion",
    settings: { component_name: "algorithm", field_name: "search_direction:historical", tolerance: 1e-9 },
  });
});

test("the design-field output can be switched off", async () => {
  const state = setValues(withControl(baseCase(), "material", "m", ["Solid"]), { writeDesignFields: false, summaryFile: "progress.csv" });
  const { opt } = await generate(state);
  const outputs = ((opt.processes as JsonObject).optimization_data_processes as JsonObject).output_processes as JsonObject[];
  assert.equal(outputs.length, 1);
  assert.equal((outputs[0].settings as JsonObject).output_file_name, "progress.csv");
});

test("every refusal names what to fix", async () => {
  const material = (s: CaseState) => withControl(s, "material", "m", ["Solid"]);
  const refused = async (state: CaseState, pattern: RegExp) =>
    assert.rejects(() => generateCase(optimization, parseMdpa(MDPA), state, "case"), pattern);
  await refused(withConstraint(material(baseCase()), "mass"), /takes no constraints/);
  await refused(setValues(withConstraint(material(baseCase()), "strain_energy"), { algorithmType: "algorithm_gradient_projection" }), /both the objective and a constraint/);
  const dynamic = material(baseCase());
  dynamic.values.problem = { ...dynamic.values.problem, solverType: "dynamic" };
  await refused(dynamic, /primal analysis must be static/);
  const nonlinear = material(baseCase());
  nonlinear.values.problem = { ...nonlinear.values.problem, analysisType: "non_linear" };
  await refused(nonlinear, /needs a linear primal analysis/);
  const unloaded = material(baseCase());
  unloaded.assignments = unloaded.assignments.filter((a) => a.conditionId !== "surfacePressure");
  await refused(unloaded, /needs a loaded primal/);
  await refused(withControl(baseCase(), "thickness", "t", ["Load"], { physicalThicknesses: [0.1, 0.2, 0.3] }), /exactly two physical thicknesses/);
  await refused(withControl(baseCase(), "shape", "s", ["Load"], { meshMotion: "filter_based" }), /filter-based mesh motion needs the implicit filter/);
  await refused(withControl(baseCase(), "simp", "s", ["Solid"], { youngModuli: [1] }), /at least two materials/);
  await refused(withControl(baseCase(), "simp", "s", ["Solid"], { densities: [0, 1], youngModuli: [5, 1] }), /must increase with density/);
  await refused(withControl(material(baseCase()), "material", "m2", ["Solid"]), /both change the same quantity on "Solid"/);
  // Deleting the objective's response leaves a dangling reference, refused by name.
  const gone = material(baseCase());
  gone.collections!.responses = gone.collections!.responses.filter((r) => r.name !== "strain_energy");
  await refused(gone, /Objective names "strain_energy"/);
});

test("renaming a response carries the objective and the constraints with it", async () => {
  let state = setValues(withControl(baseCase(), "material", "m", ["Solid"]), { algorithmType: "algorithm_gradient_projection", objectiveResponse: "mass" });
  state = withConstraint(state, "strain_energy");
  const renamed = renameEntry(decl, state, "responses", "strain_energy", "compliance")!;
  const { opt } = await generate(renamed);
  const algorithm = opt.algorithm_settings as JsonObject;
  assert.equal((algorithm.constraints as JsonObject[])[0].response_expression, "compliance");
  assert.ok((opt.responses as JsonObject[]).some((r) => r.name === "compliance"));
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

test("the driver and the stop module are valid Python", { skip: !hasPython }, async () => {
  const { out, extra } = await generate(withControl(baseCase(), "material", "m", ["Solid"]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-opt-"));
  for (const [name, text] of [["MainKratosOpt.py", out.mainScript], ["kkss_optimization_stop.py", extra("kkss_optimization_stop.py")!]]) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    const check = spawnSync("python3", ["-c", "import ast, sys; ast.parse(open(sys.argv[1], 'rb').read())", file]);
    assert.equal(check.status, 0, `${name}: ${check.stderr}`);
  }
});

test("the stop module raises only for this run's id, under a stub Kratos", { skip: !hasPython }, async () => {
  const { extra } = await generate(withControl(baseCase(), "material", "m", ["Solid"]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-opt-stop-"));
  fs.mkdirSync(path.join(dir, "KratosMultiphysics"));
  fs.writeFileSync(path.join(dir, "KratosMultiphysics", "__init__.py"), "class Process:\n    def __init__(self):\n        pass\n");
  fs.writeFileSync(path.join(dir, "kkss_optimization_stop.py"), extra("kkss_optimization_stop.py")!);
  const stopFile = path.join(dir, "stop");
  const probe = `
import kkss_optimization_stop as m
p = m.Factory({}, None)
try:
    p.ExecuteInitializeSolutionStep()
    print("running")
except m.StopRequestedError:
    print("stopped")
`;
  const run = (env: Record<string, string>) =>
    spawnSync("python3", ["-c", probe], { cwd: dir, env: { ...process.env, PYTHONPATH: dir, ...env } }).stdout.toString().trim();
  assert.equal(run({}), "running");
  fs.writeFileSync(stopFile, "other-run");
  assert.equal(run({ KRATOS_PREVIEW_STOP_FILE: stopFile, KRATOS_PREVIEW_RUN_ID: "run-1" }), "running");
  fs.writeFileSync(stopFile, "run-1\n");
  assert.equal(run({ KRATOS_PREVIEW_STOP_FILE: stopFile, KRATOS_PREVIEW_RUN_ID: "run-1" }), "stopped");
});
