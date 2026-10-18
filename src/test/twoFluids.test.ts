import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { preflightCase } from "../problemtype/preflight";
import { twoFluids } from "../problemtype/builtins/twoFluids";
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

Begin NodalData DISTANCE
1 0 -0.5
2 0 0.5
3 0 0.5
4 0 0.5
End NodalData

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

Begin SubModelPart Inlet
  Begin SubModelPartNodes
  1
  3
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Outlet
  Begin SubModelPartNodes
  2
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Walls
  Begin SubModelPartNodes
  1
  2
  End SubModelPartNodes
End SubModelPart
`;

/** The keys the solver's default parameters define (navier_stokes_two_fluids_solver.py plus the fluid solver base). */
const SOLVER_KEYS = new Set([
  "solver_type", "model_part_name", "domain_size", "model_import_settings", "enforce_element_and_conditions_replacement", "material_import_settings",
  "distance_reading_settings", "maximum_iterations", "echo_level", "time_order", "time_scheme", "compute_reactions", "analysis_type",
  "reform_dofs_at_each_step", "consider_periodic_conditions", "relative_velocity_tolerance", "absolute_velocity_tolerance",
  "relative_pressure_tolerance", "absolute_pressure_tolerance", "linear_solver_settings", "volume_model_part_name", "skin_parts",
  "assign_neighbour_elements_to_conditions", "no_skin_parts", "time_stepping", "periodic", "move_mesh_flag", "acceleration_limitation",
  "formulation", "levelset_convection_settings", "distance_reinitialization", "parallel_redistance_max_layers", "distance_smoothing",
  "distance_smoothing_coefficient", "distance_modification_settings",
]);
const subset = (o: JsonObject, allowed: Set<string>): string[] => Object.keys(o).filter((k) => !allowed.has(k));

function state(problem: Record<string, JsonValue> = {}, extra: Assignment[] = [], materials?: CaseState["materials"]): CaseState {
  const s = defaultCaseState(twoFluids.decl);
  Object.assign(s.values.problem, problem);
  s.assignments = [
    { conditionId: "parts", smpPath: "Parts/Fluid", values: {} },
    { conditionId: "outlet", smpPath: "Outlet", values: {} },
    { conditionId: "slip", smpPath: "Walls", values: {} },
    ...extra,
  ];
  s.materials = materials ?? [
    { smpPath: "Parts/Fluid", lawId: "phase_1_3d", values: {} },
    { smpPath: "Parts/Fluid", lawId: "phase_2_3d", values: {} },
  ];
  return s;
}

async function generate(problem: Record<string, JsonValue> = {}, extra: Assignment[] = [], materials?: CaseState["materials"]) {
  const out = await generateCase(twoFluids, parseMdpa(MDPA), state(problem, extra, materials), "case");
  return { out, pp: JSON.parse(out.projectParameters) as JsonObject & { solver_settings: JsonObject; processes: Record<string, JsonObject[]> } };
}

test("the solver document carries only keys the two-fluids solver defines, with the formulation and the interface choices", async () => {
  const { pp } = await generate({ surfaceTension: true, massSource: true, distanceReinitialization: "parallel", redistanceLayers: 30, distanceSmoothing: true, distanceSmoothingCoefficient: 2 });
  const s = pp.solver_settings;
  assert.equal(s.solver_type, "TwoFluids");
  assert.deepEqual(subset(s, SOLVER_KEYS), []);
  assert.deepEqual(s.formulation, { dynamic_tau: 1, surface_tension: true, mass_source: true, momentum_correction: false });
  assert.deepEqual(s.levelset_convection_settings, { max_CFL: 1, max_substeps: 0, eulerian_error_compensation: false });
  assert.equal(s.distance_reinitialization, "parallel");
  assert.equal(s.parallel_redistance_max_layers, 30);
  assert.equal(s.distance_smoothing_coefficient, 2);
  assert.deepEqual(s.distance_reading_settings, { import_mode: "from_mdpa" });
  const plain = (await generate()).pp.solver_settings;
  assert.ok(!("parallel_redistance_max_layers" in plain) && !("distance_smoothing_coefficient" in plain));
  assert.equal(plain.acceleration_limitation, true);
});

test("the two fluids are properties 1 and 2 in order, each with its own density and viscosity", async () => {
  const { out } = await generate({}, [], [
    { smpPath: "Parts/Fluid", lawId: "phase_1_3d", values: { DENSITY: 998, DYNAMIC_VISCOSITY: 1e-3 } },
    { smpPath: "Parts/Fluid", lawId: "phase_2_3d", values: { DENSITY: 1.2, DYNAMIC_VISCOSITY: 1.8e-5 } },
  ]);
  const props = JSON.parse(out.materials).properties;
  assert.deepEqual(props.map((p: { properties_id: number }) => p.properties_id), [1, 2]);
  assert.deepEqual(props.map((p: { Material: { Variables: { DENSITY: number } } }) => p.Material.Variables.DENSITY), [998, 1.2]);
  assert.equal(props[0].Material.constitutive_law.name, "Newtonian3DLaw");
});

test("the two-fluids inlet and the mass check are processes of the right modules and stay out of the skin", async () => {
  const { pp } = await generate({}, [
    { conditionId: "twoFluidsInlet", smpPath: "Inlet", values: { interfaceNormal: [0, 0, 1], pointOnInterface: [0, 0, 0.5], transitionRadius: 0.5, modulus1: "2.0*z", modulus2: "0.1", direction: [1, 0, 0] } },
    { conditionId: "massConservationCheck", smpPath: "Parts/Fluid", values: { perform: false, frequency: 10 } },
  ]);
  const inlet = pp.processes.constraints_process_list.find((p) => p.python_module === "apply_two_fluids_inlet_process")!;
  assert.deepEqual(inlet.Parameters, {
    model_part_name: "FluidModelPart.Inlet",
    interface_settings: { interface_normal: [0, 0, 1], point_on_interface: [0, 0, 0.5], inlet_transition_radius: 0.5 },
    fluid_1_settings: { modulus: "2.0*z", constrained: true, direction: [1, 0, 0], interval: [0, "End"] },
    fluid_2_settings: { modulus: 0.1, constrained: true, direction: [1, 0, 0], interval: [0, "End"] },
  });
  const mass = pp.processes.auxiliar_process_list.find((p) => p.python_module === "apply_mass_conservation_check_process")!;
  assert.deepEqual(mass.Parameters, { model_part_name: "FluidModelPart.Parts.Fluid", perform_corrections: false, correction_frequency_in_time_steps: 10, write_to_log_file: true, log_file_name: "mass_conservation.log" });
  assert.deepEqual([...(pp.solver_settings.skin_parts as string[])].sort(), ["FluidModelPart.Inlet", "FluidModelPart.Outlet", "FluidModelPart.Walls"]);
});

test("generation refuses what the solver would reject", async () => {
  await assert.rejects(generate({}, [], [{ smpPath: "Parts/Fluid", lawId: "phase_1_3d", values: {} }]), /two materials/);
  await assert.rejects(generate({}, [], [
    { smpPath: "Parts/Fluid", lawId: "phase_2_3d", values: {} },
    { smpPath: "Parts/Fluid", lawId: "phase_1_3d", values: {} },
  ]), /in this order/);
  await assert.rejects(generate({ distanceMode: "from_GiD_file" }), /post\.res/);
});

test("the preflight asks for the distance field the interface lives in", async () => {
  const withField = await preflightCase(twoFluids, parseMdpa(MDPA), state(), "case", { isMdpaSource: true });
  assert.deepEqual(withField.findings.filter((f) => f.severity === "error").map((f) => f.message), []);
  const without = parseMdpa(MDPA.replace(/Begin NodalData DISTANCE[\s\S]*?End NodalData\n/, ""));
  const missing = await preflightCase(twoFluids, without, state(), "case", { isMdpaSource: true });
  assert.ok(missing.findings.some((f) => /DISTANCE/.test(f.message)));
});
