import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { rans, freestreamTurbulence } from "../problemtype/builtins/rans";
import type { Assignment, CaseState, JsonObject, JsonValue } from "../problemtype/types";

const MDPA = `Begin Properties 0
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

Begin SubModelPart Wall
  Begin SubModelPartNodes
  1
  2
  End SubModelPartNodes
End SubModelPart
`;

// A periodic pair that really pairs: Inlet is the master node 1 and Outlet its slave 6.28 along x.
const PAIRED = MDPA.replace("3 0.0 1.0 0.0\nEnd Nodes", "3 0.0 1.0 0.0\n4 6.28 0.0 0.0\nEnd Nodes")
  .replace("Begin SubModelPart Inlet\n  Begin SubModelPartNodes\n  1\n  3\n", "Begin SubModelPart Inlet\n  Begin SubModelPartNodes\n  1\n")
  .replace("Begin SubModelPart Outlet\n  Begin SubModelPartNodes\n  2\n", "Begin SubModelPart Outlet\n  Begin SubModelPartNodes\n  4\n");

/** What Kratos' RANSApplication validates, read from the formulation classes' default settings. */
const SOLVER_KEYS = new Set([
  "solver_type", "model_part_name", "domain_size", "model_import_settings", "material_import_settings", "consider_periodic_conditions",
  "formulation_settings", "wall_function_settings", "echo_level", "volume_model_part_name", "skin_parts", "no_skin_parts",
  "assign_neighbour_elements_to_conditions", "move_mesh", "time_scheme_settings", "time_stepping", "constants",
]);
const WRAPPER_KEYS = (flow: string, model: string) =>
  new Set(["formulation_name", "incompressible_potential_flow_initialization_settings", flow, `${model}_solver_settings`, "max_iterations"]);
const MONOLITHIC_FLOW = new Set([
  "formulation_name", "maximum_iterations", "echo_level", "compute_reactions", "reform_dofs_at_each_step", "relative_velocity_tolerance",
  "absolute_velocity_tolerance", "relative_pressure_tolerance", "absolute_pressure_tolerance", "linear_solver_settings", "move_mesh_strategy",
  "move_mesh_flag", "velocity_relaxation", "pressure_relaxation", "flow_solver_formulation",
]);
const FRACTIONAL_FLOW = new Set([
  "formulation_name", "predictor_corrector", "maximum_velocity_iterations", "maximum_pressure_iterations", "velocity_tolerance", "pressure_tolerance",
  "dynamic_tau", "oss_switch", "echo_level", "time_order", "compute_reactions", "reform_dofs_at_each_step", "pressure_linear_solver_settings",
  "velocity_linear_solver_settings", "steady_convergence_settings",
]);
const TURBULENCE_KEYS = (dissipation: string) =>
  new Set(["formulation_name", "stabilization_method", "turbulent_kinetic_energy_solver_settings", dissipation, "coupling_settings", "auxiliar_process_list", "echo_level", "minimum_turbulent_viscosity", "wall_distance_calculation_settings"]);
const SCALAR_KEYS = new Set(["relative_tolerance", "absolute_tolerance", "max_iterations", "relaxation_factor", "echo_level", "linear_solver_settings", "boundary_flags"]);

const subset = (o: JsonObject, allowed: Set<string>): string[] => Object.keys(o).filter((k) => !allowed.has(k));

function state(problem: Record<string, JsonValue>, extra: Assignment[] = [], wall = true): CaseState {
  const s = defaultCaseState(rans.decl);
  Object.assign(s.values.problem, problem);
  s.assignments = [
    { conditionId: "parts", smpPath: "Parts/Fluid", values: {} },
    { conditionId: "inlet", smpPath: "Inlet", values: { modulus: 2 } },
    { conditionId: "outlet", smpPath: "Outlet", values: {} },
    ...(wall ? [{ conditionId: "ransWall", smpPath: "Wall", values: {} }] : []),
    ...extra,
  ];
  s.materials = [
    { smpPath: "Parts/Fluid", lawId: "rans_newtonian_2d", values: { DENSITY: 1.2, DYNAMIC_VISCOSITY: 0.002 } },
    ...(wall ? [{ smpPath: "Wall", lawId: "rans_wall", values: {} }] : []),
  ];
  return s;
}

async function generate(problem: Record<string, JsonValue> = {}, extra: Assignment[] = [], wall = true, mesh = MDPA) {
  const out = await generateCase(rans, parseMdpa(mesh), state(problem, extra, wall), "case");
  return { out, pp: JSON.parse(out.projectParameters) as JsonObject & { solver_settings: JsonObject; processes: Record<string, JsonObject[]>; output_processes: JsonObject } };
}

test("every flow solver and turbulence model writes only the keys the RANS formulations validate", async () => {
  for (const flow of ["monolithic", "fractional_step"]) {
    for (const model of ["k_epsilon", "k_omega", "k_omega_sst"]) {
      const { pp } = await generate({ flowSolver: flow, turbulenceModel: model });
      const s = pp.solver_settings;
      assert.equal(s.solver_type, "CoupledRANS");
      assert.deepEqual(subset(s, SOLVER_KEYS), [], `${flow}/${model}: solver keys`);
      const f = s.formulation_settings as JsonObject;
      assert.equal(f.formulation_name, `${flow}_${model}`);
      const flowKey = flow === "monolithic" ? "monolithic_flow_solver_settings" : "fractional_step_flow_solver_settings";
      assert.deepEqual(subset(f, WRAPPER_KEYS(flowKey, model)), [], `${flow}/${model}: wrapper keys`);
      assert.deepEqual(subset(f[flowKey] as JsonObject, flow === "monolithic" ? MONOLITHIC_FLOW : FRACTIONAL_FLOW), [], `${flow}/${model}: flow keys`);
      const t = f[`${model}_solver_settings`] as JsonObject;
      const dissipation = model === "k_epsilon" ? "turbulent_energy_dissipation_rate_solver_settings" : "turbulent_specific_energy_dissipation_rate_solver_settings";
      assert.deepEqual(subset(t, TURBULENCE_KEYS(dissipation)), [], `${flow}/${model}: turbulence keys`);
      assert.ok(dissipation in t, "the dissipation equation settings");
      assert.deepEqual(subset(t.turbulent_kinetic_energy_solver_settings as JsonObject, SCALAR_KEYS), []);
    }
  }
});

test("the case runs the RANS analysis stage and requires both applications", async () => {
  const { out, pp } = await generate();
  assert.equal(pp.analysis_stage, "KratosMultiphysics.RANSApplication.rans_analysis");
  assert.ok(out.applications.includes("RANSApplication") && out.applications.includes("FluidDynamicsApplication"), out.applications.join(","));
});

test("the time scheme, wall function and element choices reach the settings", async () => {
  const { pp } = await generate({ scheme: "bossak", bossakAlpha: -0.2, wallFrictionMethod: "turbulent_kinetic_energy_based", elementType: "qsvms", oss: true, stabilization: "residual_based_flux_corrected" });
  const s = pp.solver_settings;
  assert.deepEqual(s.time_scheme_settings, { scheme_type: "bossak", alpha_bossak: -0.2 });
  assert.deepEqual(s.wall_function_settings, { wall_function_region_type: "logarithmic_region_only", wall_friction_velocity_calculation_method: "turbulent_kinetic_energy_based" });
  const f = s.formulation_settings as JsonObject;
  assert.deepEqual((f.monolithic_flow_solver_settings as JsonObject).flow_solver_formulation, { element_type: "qsvms", use_orthogonal_subscales: true, dynamic_tau: 0.01 });
  assert.equal((f.k_epsilon_solver_settings as JsonObject).stabilization_method, "residual_based_flux_corrected");
  const steady = (await generate()).pp.solver_settings;
  assert.deepEqual(steady.time_scheme_settings, { scheme_type: "steady" });
});

test("the wall is one part with the wall function process; the skin lists and the wall material follow", async () => {
  const { out, pp } = await generate();
  const wall = pp.processes.constraints_process_list.find((p) => p.python_module === "apply_wall_function_process")!;
  assert.deepEqual(wall.Parameters, { model_part_name: "FluidModelPart.Wall" });
  assert.deepEqual([...(pp.solver_settings.skin_parts as string[])].sort(), ["FluidModelPart.Inlet", "FluidModelPart.Outlet", "FluidModelPart.Wall"]);
  const props = JSON.parse(out.materials).properties;
  const fluid = props.find((p: { model_part_name: string }) => p.model_part_name === "FluidModelPart.Parts.Fluid");
  assert.equal(fluid.Material.constitutive_law.name, "RansNewtonian2DLaw");
  const w = props.find((p: { model_part_name: string }) => p.model_part_name === "FluidModelPart.Wall");
  assert.equal(w.Material.constitutive_law, undefined, "the wall property carries no constitutive law");
  assert.equal(w.Material.Variables.WALL_SMOOTHNESS_BETA, 5.2);
});

test("free-stream turbulence is derived once and written to the initial state and every inlet", async () => {
  const { pp } = await generate({ turbulenceModel: "k_epsilon", freestreamSpeed: 10, turbulenceIntensity: 0.05, turbulenceLength: 0.2 });
  const t = freestreamTurbulence(10, 0.05, 0.2, "k_epsilon");
  assert.ok(Math.abs(t.k - 1.5 * 0.25) < 1e-12);
  const initial = Object.fromEntries(pp.processes.initial_conditions_process_list.map((p) => [(p.Parameters as JsonObject).variable_name as string, (p.Parameters as JsonObject).value]));
  assert.equal(initial.TURBULENT_KINETIC_ENERGY, t.k);
  assert.equal(initial.TURBULENT_ENERGY_DISSIPATION_RATE, t.dissipation);
  assert.ok(Math.abs((initial.TURBULENT_VISCOSITY as number) - (0.09 * t.k * t.k) / t.dissipation) < 1e-15);
  assert.equal(initial.DENSITY, 1.2);
  assert.ok(Math.abs((initial.VISCOSITY as number) - 0.002 / 1.2) < 1e-15);
  const inlet = pp.processes.constraints_process_list.filter((p) => p.process_name === "KTurbulentIntensityInletProcess" || p.process_name === "EpsilonTurbulentMixingLengthInletProcess");
  assert.deepEqual(inlet.map((p) => p.Parameters), [
    { model_part_name: "FluidModelPart.Inlet", turbulent_intensity: 0.05 },
    { model_part_name: "FluidModelPart.Inlet", turbulent_mixing_length: 0.2 },
  ]);
  const omega = (await generate({ turbulenceModel: "k_omega_sst", freestreamSpeed: 10, turbulenceIntensity: 0.05, turbulenceLength: 0.2 })).pp;
  assert.ok(omega.processes.initial_conditions_process_list.some((p) => (p.Parameters as JsonObject).variable_name === "TURBULENT_SPECIFIC_ENERGY_DISSIPATION_RATE"));
  assert.ok(omega.processes.constraints_process_list.some((p) => p.process_name === "OmegaTurbulentMixingLengthInletProcess"));
  const vtk = (omega.output_processes.vtk_output as JsonObject[])[0].Parameters as JsonObject;
  assert.ok((vtk.nodal_solution_step_data_variables as string[]).includes("TURBULENT_SPECIFIC_ENERGY_DISSIPATION_RATE"));
});

test("the free-stream relations are the standard ones", () => {
  const ke = freestreamTurbulence(5, 0.1, 0.3, "k_epsilon");
  assert.ok(Math.abs(ke.dissipation - (0.09 ** 0.75 * ke.k ** 1.5) / 0.3) < 1e-12);
  const kw = freestreamTurbulence(5, 0.1, 0.3, "k_omega");
  assert.ok(Math.abs(kw.dissipation - Math.sqrt(kw.k) / (0.09 ** 0.25 * 0.3)) < 1e-12);
  assert.ok(Math.abs(kw.nut - kw.k / kw.dissipation) < 1e-15);
});

test("a periodic pair uses the exact nodal periodic process of RANS", async () => {
  const { pp } = await generate({ considerPeriodic: true }, [{ conditionId: "periodic", smpPath: "Outlet", values: { master: "Inlet", translation: [1, 0, 0], magnitude: 6.28 } }], true, PAIRED);
  const p = pp.processes.constraints_process_list.find((q) => q.process_name === "ApplyExactNodalPeriodicConditionProcess")!;
  assert.equal(p.python_module, "cpp_process_factory");
  assert.equal(p.kratos_module, "KratosMultiphysics.RANSApplication");
  assert.deepEqual(p.Parameters, {
    master_model_part_name: "FluidModelPart.Inlet",
    slave_model_part_name: "FluidModelPart.Outlet",
    tolerance: 1e-6,
    translation_settings: { direction: [1, 0, 0], magnitude: 6.28 },
    echo_level: 0,
    reorder: false,
  });
  assert.equal(pp.solver_settings.consider_periodic_conditions, true);
  // Both parts of the pair join the computing model part, as skin or as no-skin: the formulation numbers the
  // periodic conditions it creates after that part's own, and a part outside it left the ids colliding with the mesh's.
  const listed = [...(pp.solver_settings.skin_parts as string[]), ...(pp.solver_settings.no_skin_parts as string[])];
  for (const part of ["FluidModelPart.Inlet", "FluidModelPart.Outlet"]) assert.ok(listed.includes(part), `${part} is in neither list`);
});

test("generation refuses a case the wall function cannot work with", async () => {
  await assert.rejects(generate({}, [], false), /needs a wall/);
  await assert.rejects(generate({}, [{ conditionId: "ransWall", smpPath: "Outlet", values: {} }]), /ONE part/);
  const s = state({});
  s.materials = s.materials.filter((m) => m.lawId !== "rans_wall");
  await assert.rejects(generateCase(rans, parseMdpa(MDPA), s, "case"), /smoothness/);
  await assert.rejects(generate({}, [{ conditionId: "periodic", smpPath: "Outlet", values: { master: "Inlet" } }]), /Periodic boundaries/);
  await assert.rejects(generate({ turbulenceLength: 0 }), /length scale/);
  // Each flow solver accepts only its own transient scheme (read from the formulations; a solver run rejected the other).
  await assert.rejects(generate({ flowSolver: "monolithic", scheme: "bdf2" }), /monolithic flow solver supports the steady and Bossak/);
  await assert.rejects(generate({ flowSolver: "fractional_step", scheme: "bossak" }), /fractional-step flow solver supports the steady and BDF2/);
  await assert.doesNotReject(generate({ flowSolver: "fractional_step", scheme: "bdf2" }));
  await assert.doesNotReject(generate({ flowSolver: "monolithic", scheme: "bossak" }));
});

test("the monitors and gravity of the Fluid problemtype carry over", async () => {
  const { pp } = await generate({ gravityValue: 9.81 }, [{ conditionId: "yPlus", smpPath: "Wall", values: {} }]);
  assert.ok(pp.processes.auxiliar_process_list.some((p) => p.python_module === "compute_y_plus_process"));
  assert.ok(pp.processes.gravity);
  assert.deepEqual(pp.solver_settings.skin_parts, ["FluidModelPart.Inlet", "FluidModelPart.Outlet", "FluidModelPart.Wall"]);
});
