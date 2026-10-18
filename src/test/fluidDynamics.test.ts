import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { fluid } from "../problemtype/builtins/fluid";
import { embeddedFluid } from "../problemtype/builtins/embeddedFluid";
import type { Assignment, CaseState, JsonObject, JsonValue } from "../problemtype/types";

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
End SubModelPart

Begin SubModelPart Wall
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Left
  Begin SubModelPartNodes
  1
  3
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Right
  Begin SubModelPartNodes
  2
  4
  End SubModelPartNodes
End SubModelPart
`;

const MDPA_2D = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin SubModelPart Parts
  Begin SubModelPart Fluid
    Begin SubModelPartNodes
    1
    2
    3
    End SubModelPartNodes
    Begin SubModelPartElements
    1
    End SubModelPartElements
  End SubModelPart
End SubModelPart
`;

/** The keys Kratos' own default parameters define, read from the solver sources (FluidDynamicsApplication). */
const MONOLITHIC_KEYS = new Set([
  "solver_type", "model_part_name", "domain_size", "model_import_settings", "enforce_element_and_conditions_replacement", "material_import_settings",
  "formulation", "maximum_iterations", "echo_level", "consider_periodic_conditions", "compute_reactions", "analysis_type", "reform_dofs_at_each_step",
  "assign_neighbour_elements_to_conditions", "relative_velocity_tolerance", "absolute_velocity_tolerance", "relative_pressure_tolerance",
  "absolute_pressure_tolerance", "linear_solver_settings", "volume_model_part_name", "skin_parts", "no_skin_parts", "time_stepping", "time_scheme",
  "alpha", "velocity_relaxation", "pressure_relaxation", "move_mesh_strategy", "periodic", "move_mesh_flag",
]);
const FRACTIONAL_KEYS = new Set([
  "solver_type", "model_part_name", "domain_size", "model_import_settings", "enforce_element_and_conditions_replacement", "material_import_settings",
  "predictor_corrector", "maximum_velocity_iterations", "maximum_pressure_iterations", "velocity_tolerance", "pressure_tolerance", "dynamic_tau",
  "oss_switch", "echo_level", "consider_periodic_conditions", "time_order", "compute_reactions", "reform_dofs_at_each_step",
  "assign_neighbour_elements_to_conditions", "pressure_linear_solver_settings", "velocity_linear_solver_settings", "volume_model_part_name",
  "skin_parts", "no_skin_parts", "time_stepping", "move_mesh_flag", "use_slip_conditions", "formulation",
]);
const STOKES_KEYS = new Set([
  "solver_type", "model_part_name", "domain_size", "model_import_settings", "material_import_settings", "formulation", "echo_level", "compute_reactions",
  "analysis_type", "reform_dofs_at_each_step", "consider_periodic_conditions", "relative_velocity_tolerance", "absolute_velocity_tolerance",
  "relative_pressure_tolerance", "absolute_pressure_tolerance", "linear_solver_settings", "volume_model_part_name", "skin_parts",
  "assign_neighbour_elements_to_conditions", "no_skin_parts", "time_stepping", "time_scheme", "force_steady_state", "move_mesh_flag",
]);
/** The formulation keys each element accepts (its `_SetUp…` default settings). */
const FORMULATION_KEYS: Record<string, string[]> = {
  qsvms: ["element_type", "use_orthogonal_subscales", "dynamic_tau", "element_manages_time_integration"],
  dvms: ["element_type", "dynamic_tau", "use_orthogonal_subscales"],
  fic: ["element_type", "beta", "adjust_beta_dynamically", "dynamic_tau"],
  vms: ["element_type", "use_orthogonal_subscales", "dynamic_tau", "non_newtonian_fluid_parameters"],
  weakly_compressible: ["element_type", "dynamic_tau", "sound_velocity"],
  axisymmetric_navier_stokes: ["element_type", "dynamic_tau"],
  p2p1: ["element_type", "dynamic_tau"],
};

function state(problem: Record<string, JsonValue>, assignments: Assignment[], materials: CaseState["materials"] = []): CaseState {
  const s = defaultCaseState(fluid.decl);
  Object.assign(s.values.problem, problem);
  s.assignments = [{ conditionId: "parts", smpPath: "Parts/Fluid", values: {} }, ...assignments];
  s.materials = materials.length ? materials : [{ smpPath: "Parts/Fluid", lawId: "newtonian_3d", values: {} }];
  return s;
}

async function generate(problem: Record<string, JsonValue>, assignments: Assignment[] = [], materials?: CaseState["materials"], mesh = MDPA) {
  const out = await generateCase(fluid, parseMdpa(mesh), state(problem, assignments, materials), "case");
  return { out, pp: JSON.parse(out.projectParameters) as JsonObject & { solver_settings: JsonObject; processes: Record<string, JsonObject[]>; output_processes: JsonObject } };
}

const keysOf = (o: JsonObject): string[] => Object.keys(o);
const subset = (o: JsonObject, allowed: Set<string>): string[] => keysOf(o).filter((k) => !allowed.has(k));

test("every monolithic element writes exactly the formulation keys Kratos validates, and no key outside its solver defaults", async () => {
  const cases: [string, Record<string, JsonValue>, string][] = [
    ["qsvms", { elementType: "qsvms", timeIntegrated: true }, "qsvms"],
    ["dvms", { elementType: "dvms" }, "dvms"],
    ["fic", { elementType: "fic", ficBeta: 0.5 }, "fic"],
    ["vms", { elementType: "vms", nonNewtonian: true }, "vms"],
    ["weakly", { elementType: "weakly_compressible", soundVelocity: 340 }, "weakly_compressible"],
    ["axisym", { elementType: "axisymmetric" }, "axisymmetric_navier_stokes"],
    ["p2p1", { elementType: "p2p1" }, "p2p1"],
  ];
  for (const [name, values, type] of cases) {
    const flat = type === "axisymmetric_navier_stokes";
    const { pp } = await generate({ ...values, timeScheme: "bossak" }, [], flat ? [{ smpPath: "Parts/Fluid", lawId: "newtonian_2d", values: {} }] : undefined, flat ? MDPA_2D : MDPA);
    const s = pp.solver_settings;
    assert.deepEqual(subset(s, MONOLITHIC_KEYS), [], `${name}: unknown top-level key`);
    const f = s.formulation as JsonObject;
    assert.equal(f.element_type, type);
    assert.deepEqual(subset(f, new Set(FORMULATION_KEYS[type])), [], `${name}: unknown formulation key`);
    assert.equal(s.alpha, undefined, "Kratos' default alpha is not written");
  }
  const { pp: custom } = await generate({ timeScheme: "bossak", bossakAlpha: -0.2 });
  assert.equal(custom.solver_settings.alpha, -0.2);
  const { pp: weak } = await generate({ elementType: "weakly_compressible", soundVelocity: 340 });
  assert.equal((weak.solver_settings.formulation as JsonObject).sound_velocity, 340);
  const { pp: fic } = await generate({ elementType: "fic", ficBeta: 0.5 });
  assert.equal((fic.solver_settings.formulation as JsonObject).beta, 0.5);
  const { pp: ti } = await generate({ elementType: "qsvms", timeIntegrated: true });
  assert.equal((ti.solver_settings.formulation as JsonObject).element_manages_time_integration, true);
});

test("the legacy VMS carries the Herschel-Bulkley parameters inside the formulation", async () => {
  const { pp } = await generate({ elementType: "vms", nonNewtonian: true, powerLawK: 0.02, powerLawN: 0.7, yieldStress: 3, regularization: 80 });
  assert.deepEqual((pp.solver_settings.formulation as JsonObject).non_newtonian_fluid_parameters, {
    power_law_k: 0.02, power_law_n: 0.7, yield_stress: 3, regularization_coefficient: 80,
  });
  const { pp: plain } = await generate({ elementType: "vms" });
  assert.ok(!("non_newtonian_fluid_parameters" in (plain.solver_settings.formulation as JsonObject)));
});

test("the Stokes strategy and the fractional step write only keys their solvers define", async () => {
  const { pp: stokes } = await generate({ strategy: "stokes", forceSteadyState: true });
  assert.equal(stokes.solver_settings.solver_type, "monolithic_stokes");
  assert.deepEqual(subset(stokes.solver_settings, STOKES_KEYS), []);
  assert.deepEqual(stokes.solver_settings.formulation, { element_type: "symbolic_stokes" });
  assert.equal(stokes.solver_settings.force_steady_state, true);
  assert.equal(stokes.solver_settings.analysis_type, "linear");

  const { pp: fs } = await generate({ strategy: "fractional_step", timeOrder: 1, useSlipConditions: false, considerPeriodic: true });
  assert.deepEqual(subset(fs.solver_settings, FRACTIONAL_KEYS), []);
  assert.equal(fs.solver_settings.time_order, 1);
  assert.equal(fs.solver_settings.use_slip_conditions, false);
  assert.equal(fs.solver_settings.consider_periodic_conditions, true);
});

test("monitors are processes of the right module, stay out of the skin lists and add their output variables", async () => {
  const { pp } = await generate({}, [
    { conditionId: "noSlip", smpPath: "Wall", values: {} },
    { conditionId: "flowForces", smpPath: "Wall", values: { referencePoint: [0.5, 0, 0] } },
    { conditionId: "aerodynamicCoefficients", smpPath: "Wall", values: { referenceArea: 2, referenceChord: 1.5, dynamicPressure: 100 } },
    { conditionId: "pressureCoefficient", smpPath: "Wall", values: { freestreamDensity: 1.2, freestreamVelocity: 40 } },
    { conditionId: "yPlus", smpPath: "Wall", values: {} },
  ]);
  const list = pp.processes.auxiliar_process_list;
  assert.deepEqual(list.map((p) => p.python_module), [
    "compute_body_fitted_flow_forces_and_moments_process",
    "compute_aerodynamic_coefficients_process",
    "compute_pressure_coefficient_process",
    "compute_y_plus_process",
  ]);
  const forces = list[0].Parameters as JsonObject;
  assert.deepEqual(forces.reference_point, [0.5, 0, 0]);
  assert.equal(forces.write_forces_output_file, true);
  const coefficients = list[1].Parameters as JsonObject;
  assert.deepEqual([coefficients.reference_area, coefficients.reference_chord, coefficients.dynamic_pressure, coefficients.is_embedded], [2, 1.5, 100, false]);
  // The wall appears once in the skin list (the no-slip), not once per monitor.
  assert.deepEqual(pp.solver_settings.skin_parts, ["FluidModelPart.Wall"]);
  const vtk = ((pp.output_processes.vtk_output as JsonObject[])[0].Parameters) as JsonObject;
  assert.deepEqual(vtk.nodal_data_value_variables, ["PRESSURE_COEFFICIENT", "Y_PLUS"]);
});

// One master node and its slave 3 m above it: the translation runs from the master to the slave.
const PAIRED = MDPA.replace("4 0.0 0.0 1.0\nEnd Nodes", "4 0.0 0.0 1.0\n5 0.0 0.0 3.0\nEnd Nodes")
  .replace("Begin SubModelPart Left\n  Begin SubModelPartNodes\n  1\n  3\n", "Begin SubModelPart Left\n  Begin SubModelPartNodes\n  1\n")
  .replace("Begin SubModelPart Right\n  Begin SubModelPartNodes\n  2\n  4\n", "Begin SubModelPart Right\n  Begin SubModelPartNodes\n  5\n");

test("a periodic pair writes the core process on the slave with the master and the translation", async () => {
  const { pp } = await generate({ considerPeriodic: true }, [{ conditionId: "periodic", smpPath: "Right", values: { master: "Left", translation: [0, 0, 1], magnitude: 3 } }], undefined, PAIRED);
  const process = pp.processes.constraints_process_list[0] as JsonObject;
  assert.equal(process.python_module, "apply_periodic_condition_process");
  assert.deepEqual(process.Parameters, {
    model_part_name: "FluidModelPart",
    // Relative to the main model part: the wrapper prefixes it itself (a full dotted name was looked up twice).
    computing_model_part_name: "fluid_computational_model_part",
    first_model_part_name: "Left",
    second_model_part_name: "Right",
    variable_names: ["VELOCITY", "PRESSURE"],
    transformation_settings: { translation_settings: { dir_of_translation: [0, 0, 1], magnitude: 3 } },
  });
  assert.equal(pp.solver_settings.consider_periodic_conditions, true);
  assert.deepEqual(pp.solver_settings.skin_parts, [], "a periodic part is no skin");
});

test("generation refuses what the solver would ignore or reject", async () => {
  await assert.rejects(generate({}, [{ conditionId: "periodic", smpPath: "Right", values: { master: "Left" } }], undefined, PAIRED), /Periodic boundaries/);
  await assert.rejects(generate({ considerPeriodic: true }, [{ conditionId: "periodic", smpPath: "Right", values: {} }], undefined, PAIRED), /no master boundary/);
  // A pair the translation does not match is refused, naming the reversed direction when that is the fix.
  await assert.rejects(
    generate({ considerPeriodic: true }, [{ conditionId: "periodic", smpPath: "Right", values: { master: "Left", translation: [0, 0, -1], magnitude: 3 } }], undefined, PAIRED),
    /no master node at that distance[\s\S]*reversed/
  );
  await assert.rejects(generate({ elementType: "axisymmetric" }), /two-dimensional/);
  await generate({ elementType: "axisymmetric" }, [], [{ smpPath: "Parts/Fluid", lawId: "newtonian_2d", values: {} }], MDPA_2D);
});

test("non-Newtonian laws write their properties and are offered to the monolithic strategy only", async () => {
  const { out } = await generate({}, [], [{ smpPath: "Parts/Fluid", lawId: "herschel_bulkley_3d", values: { YIELD_STRESS: 4, POWER_LAW_K: 0.5, POWER_LAW_N: 0.6 } }]);
  const material = JSON.parse(out.materials).properties[0].Material;
  assert.equal(material.constitutive_law.name, "HerschelBulkley3DLaw");
  assert.deepEqual(
    Object.keys(material.Variables).sort(),
    ["DENSITY", "POWER_LAW_K", "POWER_LAW_N", "REGULARIZATION_COEFFICIENT", "YIELD_STRESS"]
  );
  await assert.rejects(generate({ strategy: "fractional_step" }, [], [{ smpPath: "Parts/Fluid", lawId: "bingham_3d", values: {} }]), /Bingham/);
  assert.ok(!embeddedFluid.decl.materialLaws.some((l) => l.group === "Non-Newtonian"), "the embedded element is Newtonian only");
});

test("the embedded drag uses the force-and-moment process Kratos ships", async () => {
  const s = defaultCaseState(embeddedFluid.decl);
  s.values.problem.computeDrag = true;
  s.assignments = [{ conditionId: "parts", smpPath: "Parts/Fluid", values: {} }];
  s.materials = [{ smpPath: "Parts/Fluid", lawId: "newtonian_3d", values: {} }];
  const out = await generateCase(embeddedFluid, parseMdpa(MDPA), s, "case");
  const aux = (JSON.parse(out.projectParameters).processes.auxiliar_process_list as JsonObject[]);
  const drag = aux.find((p) => p.python_module === "compute_embedded_flow_forces_and_moments_process");
  assert.ok(drag, "embedded forces process");
  assert.deepEqual(Object.keys(drag!.Parameters as JsonObject).sort(), ["interval", "model_part_name", "print_to_screen", "write_forces_output_file"]);
});

const EMBEDDED_KEYS = new Set([
  "solver_type", "model_part_name", "domain_size", "model_import_settings", "enforce_element_and_conditions_replacement", "material_import_settings",
  "distance_reading_settings", "distance_modification_settings", "maximum_iterations", "echo_level", "time_order", "time_scheme", "compute_reactions",
  "analysis_type", "reform_dofs_at_each_step", "consider_periodic_conditions", "assign_neighbour_elements_to_conditions", "relative_velocity_tolerance",
  "absolute_velocity_tolerance", "relative_pressure_tolerance", "absolute_pressure_tolerance", "linear_solver_settings", "volume_model_part_name",
  "skin_parts", "no_skin_parts", "time_stepping", "move_mesh_flag", "formulation", "fm_ale_settings",
]);
const EMBEDDED_FORMULATION_KEYS = ["element_type", "is_slip", "slip_length", "penalty_coefficient", "dynamic_tau", "level_set_type"];

test("every embedded element goes through the Embedded solver with keys it validates", async () => {
  for (const variant of [
    "embedded_navier_stokes",
    "embedded_weakly_compressible_navier_stokes",
    "embedded_ausas_navier_stokes",
    "embedded_weakly_compressible_navier_stokes_discontinuous",
  ]) {
    const s = defaultCaseState(embeddedFluid.decl);
    s.values.problem.embeddedFormulation = variant;
    s.values.problem.isSlip = true;
    s.assignments = [{ conditionId: "parts", smpPath: "Parts/Fluid", values: {} }];
    const weakly = variant.includes("weakly");
    s.materials = [{ smpPath: "Parts/Fluid", lawId: weakly ? "newtonian_3d_weakly_compressible" : "newtonian_3d", values: {} }];
    const out = await generateCase(embeddedFluid, parseMdpa(MDPA), s, "case");
    const settings = JSON.parse(out.projectParameters).solver_settings as JsonObject;
    assert.equal(settings.solver_type, "Embedded", variant);
    assert.deepEqual(subset(settings, EMBEDDED_KEYS), [], variant);
    const f = settings.formulation as JsonObject;
    assert.equal(f.element_type, variant);
    assert.deepEqual(subset(f, new Set(EMBEDDED_FORMULATION_KEYS)), [], variant);
    assert.equal("slip_length" in f, variant !== "embedded_ausas_navier_stokes", `${variant}: the Ausas element defines no slip length`);
    const material = JSON.parse(out.materials).properties[0].Material.Variables;
    assert.equal("SOUND_VELOCITY" in material, weakly, `${variant}: speed of sound only where the element reads it`);
  }
});

test("the embedded material laws follow the chosen element", async () => {
  const s = defaultCaseState(embeddedFluid.decl);
  s.assignments = [{ conditionId: "parts", smpPath: "Parts/Fluid", values: {} }];
  s.materials = [{ smpPath: "Parts/Fluid", lawId: "newtonian_3d_weakly_compressible", values: {} }];
  await assert.rejects(generateCase(embeddedFluid, parseMdpa(MDPA), s, "case"), /weakly|Newtonian/i);
});
