/**
 * Built-in Two Fluids problemtype: two immiscible incompressible fluids separated
 * by a level-set interface that the flow convects (FluidDynamicsApplication,
 * `navier_stokes_two_fluids_solver` / `TwoFluidNavierStokes`) — a dam break, a
 * filling mould, a sloshing tank.
 *
 * Derived from the Fluid built-in: its inlet, outlet, slip and no-slip walls,
 * constraints, gravity, time stepping and linear solver are reused. What this adds
 * is the solver's own settings (level-set convection, re-initialization, the
 * distance modification), the nodal DISTANCE field the interface lives in, the
 * two-fluids inlet and the mass-conservation check.
 *
 * Two facts the solver fixes and the declaration follows:
 *  - the materials file has TWO properties, id 1 for the nodes with distance <= 0
 *    and id 2 for the rest (`_SetNodalProperties`), so the first two material
 *    assignments are fluid 1 and fluid 2, in that order;
 *  - the interface is the zero level of the nodal `DISTANCE` field read from the mesh
 *    (or a `.post.res` file).
 *
 * Not solver-verified in this repository: the shape follows the solver's default
 * parameters and Kratos' own TwoFluidInletTest.
 */

import { defineProblemtype, asBool, asNum, asStr } from "../api";
import type { ConditionSpec, FieldSpec, JsonObject, JsonValue, MaterialLawSpec, ProblemtypeDeclaration } from "../types";
import { fluid } from "./fluid";
import { monitoredMainScript } from "../mainKratosTemplate";
import { withoutRulesOn } from "./common";

const BASE = fluid.decl;
const BASE_SECTION = BASE.sections[0];

const DROPPED = [
  "strategy", "elementType", "timeIntegrated", "ficBeta", "soundVelocity", "nonNewtonian", "powerLawK", "powerLawN",
  "yieldStress", "regularization", "forceSteadyState", "timeOrder", "useSlipConditions", "timeScheme", "bossakAlpha",
  "oss", "predictorCorrector", "pressureTolerance", "maxPressureIterations", "velocityTolerance", "maxVelocityIterations",
  "dynamicTau", "maxIterations",
];

const DISTANCE_FILE = { field: "distanceMode", equals: "from_GiD_file" };
const SURFACE_TENSION = { field: "surfaceTension", equals: true };
const PARALLEL = { field: "distanceReinitialization", equals: "parallel" };
const SMOOTHING = { field: "distanceSmoothing", equals: true };

const twoFluidFields: FieldSpec[] = [
  { id: "maxIterations", label: "Maximum iterations", type: "int", default: 7, min: 1, group: "convergence" },
  { id: "timeOrder", label: "Time order", type: "int", default: 2, min: 1, max: 2, group: "formulation" },
  { id: "dynamicTau", label: "Dynamic tau", type: "number", default: 1.0, min: 0, group: "formulation" },
  { id: "surfaceTension", label: "Surface tension", type: "bool", default: false, group: "formulation", help: "Reads SURFACE_TENSION_COEFFICIENT from the fluid materials." },
  { id: "massSource", label: "Mass source", type: "bool", default: false, group: "formulation" },
  { id: "momentumCorrection", label: "Momentum correction", type: "bool", default: false, group: "formulation" },
  { id: "accelerationLimitation", label: "Acceleration limitation", type: "bool", default: true, group: "formulation", help: "Limits the acceleration after the first step so a spurious pressure jump cannot launch the interface." },
  {
    id: "distanceMode",
    label: "Distance field",
    type: "enum",
    default: "from_mdpa",
    group: "interface",
    options: [
      { value: "from_mdpa", label: "From the mesh (DISTANCE nodal field)" },
      { value: "from_GiD_file", label: "From a .post.res file" },
    ],
    help: "The interface is the zero of this field: negative is fluid 1, positive is fluid 2.",
  },
  { id: "distanceFile", label: "Distance file", type: "string", default: "", group: "interface", visibleWhen: DISTANCE_FILE },
  { id: "levelsetMaxCfl", label: "Interface CFL", type: "number", default: 1.0, min: 0, group: "interface", help: "Largest CFL of one level-set convection sub-step." },
  { id: "levelsetSubsteps", label: "Interface sub-steps", type: "int", default: 0, min: 0, group: "interface", help: "0 lets the solver choose from the CFL." },
  { id: "eulerianErrorCompensation", label: "Eulerian error compensation", type: "bool", default: false, group: "interface" },
  {
    id: "distanceReinitialization",
    label: "Re-initialization",
    type: "enum",
    default: "variational",
    group: "interface",
    options: [
      { value: "none", label: "None" },
      { value: "variational", label: "Variational" },
      { value: "parallel", label: "Parallel" },
    ],
    help: "Restores |DISTANCE| = distance to the interface after the convection distorts it.",
  },
  { id: "redistanceLayers", label: "Parallel re-distance layers", type: "int", default: 25, min: 1, group: "interface", visibleWhen: PARALLEL },
  { id: "distanceSmoothing", label: "Distance smoothing", type: "bool", default: false, group: "interface" },
  { id: "distanceSmoothingCoefficient", label: "Smoothing coefficient", type: "number", default: 1.0, min: 0, group: "interface", visibleWhen: SMOOTHING },
  { id: "distanceThreshold", label: "Distance threshold", type: "number", default: 1e-5, min: 0, group: "interface", help: "Nodal distances smaller than this are moved off the interface so no element is cut at a node." },
  { id: "avoidAlmostEmpty", label: "Avoid almost empty elements", type: "bool", default: false, group: "interface" },
  { id: "deactivateFullNegative", label: "Deactivate full negative elements", type: "bool", default: false, group: "interface" },
];

const phase = (n: 1 | 2, size: 2 | 3): MaterialLawSpec => ({
  id: `phase_${n}_${size}d`,
  name: `Newtonian${size}DLaw`,
  domainSize: size,
  group: n === 1 ? "Fluid 1 (distance ≤ 0)" : "Fluid 2 (distance > 0)",
  variables: [
    { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: n === 1 ? 1000 : 1.0, unit: "kg/m³" },
    { id: "DYNAMIC_VISCOSITY", label: "Dynamic viscosity [Pa·s]", type: "number", default: n === 1 ? 1e-3 : 1.8e-5, unit: "Pa·s" },
    { id: "SURFACE_TENSION_COEFFICIENT", label: "Surface tension coefficient [N/m]", type: "number", default: 0.0, unit: "N/m" },
  ],
});

const twoFluidsInlet: ConditionSpec = {
  id: "twoFluidsInlet",
  label: "Two-fluids inlet",
  list: "constraints_process_list",
  target: "surface",
  category: "constraints",
  icon: "ptConstraint",
  help: "An inlet that carries each fluid its own velocity: the nodes on each side of the interface plane get that fluid's speed, blended over a transition radius.",
  fields: [
    { id: "interfaceNormal", label: "Interface normal", type: "vector3", default: [0, 0, 1] },
    { id: "pointOnInterface", label: "Point on the interface", type: "vector3", default: [0, 0, 0] },
    { id: "transitionRadius", label: "Transition radius [m]", type: "number", default: 0.05, min: 0 },
    { id: "modulus1", label: "Fluid 1 speed", type: "string", default: "1.0", help: "A number, or an expression in the inlet's coordinates and the time t (e.g. 2.0*z)." },
    { id: "modulus2", label: "Fluid 2 speed", type: "string", default: "0.0", help: "A number, or an expression." },
    { id: "direction", label: "Direction", type: "vector3", default: [1, 0, 0] },
  ],
  processTemplate: {},
};

const massCheck: ConditionSpec = {
  id: "massConservationCheck",
  label: "Mass conservation check",
  list: "auxiliar_process_list",
  target: "volume",
  category: "other",
  icon: "ptResults",
  noProcess: false,
  help: "Reports the volume each fluid gains or loses against the inflow and, optionally, corrects the interface to keep it. Assign it to the fluid part.",
  fields: [
    { id: "perform", label: "Correct the interface", type: "bool", default: true },
    { id: "frequency", label: "Correction every [steps]", type: "int", default: 20, min: 1 },
    { id: "log", label: "Write a log file", type: "bool", default: true },
  ],
  processTemplate: {
    python_module: "apply_mass_conservation_check_process",
    kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
    process_name: "ApplyMassConservationCheckProcess",
    Parameters: {
      model_part_name: "$path",
      perform_corrections: "$field:perform",
      correction_frequency_in_time_steps: "$field:frequency",
      write_to_log_file: "$field:log",
      log_file_name: "mass_conservation.log",
    },
  },
};

const KEPT = new Set(["parts", "initialVelocity", "initialPressure", "inlet", "outlet", "slip", "noSlip", "velocityConstraints", "pressureConstraints", "periodic", "flowForces", "yPlus"]);

const decl: ProblemtypeDeclaration = {
  ...BASE,
  id: "twoFluids",
  name: "Two Fluids",
  description: "Two immiscible incompressible fluids separated by a level-set interface (FluidDynamicsApplication)",
  icon: "ptFluid",
  family: "fluid",
  domainSizes: [2, 3],
  sections: [
    {
      ...BASE_SECTION,
      groups: [...(BASE_SECTION.groups ?? []), { id: "interface", label: "Interface", icon: "ptSolver" }],
      fields: [...withoutRulesOn(BASE_SECTION.fields.filter((f) => !DROPPED.includes(f.id)), DROPPED), ...twoFluidFields],
      requiresFields: [
        {
          variable: "DISTANCE",
          components: 1,
          kind: "Nodal",
          when: { field: "distanceMode", equals: "from_mdpa" },
          message:
            "The interface is read from the mesh's nodal DISTANCE field (Distance field: From the mesh), but the open mesh has none. Compute one (Variables ▸ Distance to a SubModelPart or file, or the Signed distance operation) or switch to a .post.res file.",
        },
      ],
    },
  ],
  conditions: [...BASE.conditions.filter((c) => KEPT.has(c.id)), twoFluidsInlet, massCheck],
  materialLaws: [phase(1, 3), phase(1, 2), phase(2, 3), phase(2, 2)],
  output: { nodalDefaults: ["VELOCITY", "PRESSURE", "DISTANCE"] },
};

export const twoFluids = defineProblemtype(decl, {
  mainScript: () => monitoredMainScript("twoFluids"),
  buildProcess: (cond, a, ctx) => {
    if (cond.id === "twoFluidsInlet") {
      const v = a.values;
      const expression = (value: JsonValue | undefined, fallback: string): string | number => {
        const text = asStr(value, fallback).trim() || fallback;
        // A plain number stays a number in the JSON; anything else is an expression the process evaluates.
        return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text) ? Number(text) : text;
      };
      const direction = Array.isArray(v.direction) ? v.direction : [1, 0, 0];
      const side = (modulus: string | number): JsonObject => ({ modulus, constrained: true, direction, interval: [0.0, "End"] });
      return {
        python_module: "apply_two_fluids_inlet_process",
        kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
        Parameters: {
          model_part_name: `${ctx.modelPartName}.${a.smpPath.split("/").join(".")}`,
          interface_settings: {
            interface_normal: Array.isArray(v.interfaceNormal) ? v.interfaceNormal : [0, 0, 1],
            point_on_interface: Array.isArray(v.pointOnInterface) ? v.pointOnInterface : [0, 0, 0],
            inlet_transition_radius: asNum(v.transitionRadius, 0.05),
          },
          fluid_1_settings: side(expression(v.modulus1, "1.0")),
          fluid_2_settings: side(expression(v.modulus2, "0.0")),
        },
      };
    }
    return fluid.buildProcess(cond, a, ctx);
  },
  solverSettings: async (v, ctx) => {
    const base = (await fluid.solverSettings({ ...v, strategy: "monolithic", elementType: "qsvms", timeScheme: "bdf2", oss: false, gravityValue: 0 }, ctx)) as JsonObject;
    const mode = asStr(v.distanceMode, "from_mdpa");
    const reading: JsonObject = { import_mode: mode };
    if (mode !== "from_mdpa") reading.distance_file_name = asStr(v.distanceFile, "");
    // A mass-conservation check names the fluid part; it is a monitor, not a boundary.
    const monitored = new Set(ctx.assignments.filter((a) => a.conditionId === "massConservationCheck").map((a) => `${ctx.modelPartName}.${a.smpPath.split("/").join(".")}`));
    const settings: JsonObject = {
      model_part_name: base.model_part_name,
      domain_size: base.domain_size,
      solver_type: "TwoFluids",
      model_import_settings: base.model_import_settings,
      material_import_settings: base.material_import_settings,
      distance_reading_settings: reading,
      maximum_iterations: asNum(v.maxIterations, 7),
      echo_level: base.echo_level,
      time_order: asNum(v.timeOrder, 2),
      compute_reactions: base.compute_reactions,
      reform_dofs_at_each_step: false,
      relative_velocity_tolerance: asNum(v.relVelTol, 1e-3),
      absolute_velocity_tolerance: asNum(v.absVelTol, 1e-5),
      relative_pressure_tolerance: asNum(v.relPresTol, 1e-3),
      absolute_pressure_tolerance: asNum(v.absPresTol, 1e-5),
      volume_model_part_name: base.volume_model_part_name,
      skin_parts: (base.skin_parts as string[]).filter((n) => !monitored.has(n)),
      no_skin_parts: (base.no_skin_parts as string[]).filter((n) => !monitored.has(n)),
      assign_neighbour_elements_to_conditions: true,
      time_stepping: base.time_stepping,
      move_mesh_flag: false,
      acceleration_limitation: asBool(v.accelerationLimitation, true),
      formulation: {
        dynamic_tau: asNum(v.dynamicTau, 1.0),
        surface_tension: asBool(v.surfaceTension, false),
        mass_source: asBool(v.massSource, false),
        momentum_correction: asBool(v.momentumCorrection, false),
      },
      levelset_convection_settings: {
        max_CFL: asNum(v.levelsetMaxCfl, 1.0),
        max_substeps: asNum(v.levelsetSubsteps, 0),
        eulerian_error_compensation: asBool(v.eulerianErrorCompensation, false),
      },
      distance_reinitialization: asStr(v.distanceReinitialization, "variational"),
      distance_smoothing: asBool(v.distanceSmoothing, false),
      distance_modification_settings: {
        distance_threshold: asNum(v.distanceThreshold, 1e-5),
        avoid_almost_empty_elements: asBool(v.avoidAlmostEmpty, false),
        deactivate_full_negative_elements: asBool(v.deactivateFullNegative, false),
      },
    };
    if (settings.distance_reinitialization === "parallel") settings.parallel_redistance_max_layers = asNum(v.redistanceLayers, 25);
    if (settings.distance_smoothing === true) settings.distance_smoothing_coefficient = asNum(v.distanceSmoothingCoefficient, 1.0);
    if (base.consider_periodic_conditions !== undefined) settings.consider_periodic_conditions = base.consider_periodic_conditions;
    return settings;
  },
  postProcess: (pp, ctx) => fluid.postProcess(pp, ctx),
  validate: (ctx) => {
    const problems: string[] = [];
    const laws = ctx.materials.map((m) => m.lawId);
    // Properties ids follow the order of the assignments: 1 is fluid 1, 2 is fluid 2.
    if (laws.length < 2 || !/^phase_1_/.test(laws[0]) || !/^phase_2_/.test(laws[1])) {
      problems.push(
        "Two Fluids needs two materials, in this order: first a \"Fluid 1\" material (the nodes with DISTANCE ≤ 0), then a \"Fluid 2\" material (DISTANCE > 0), both on the fluid part. The solver reads them as properties 1 and 2."
      );
    } else if (ctx.materials[0].smpPath !== ctx.materials[1].smpPath) {
      problems.push("Both fluid materials belong to the same fluid part: the solver assigns the density per node from the distance.");
    }
    if (ctx.values.distanceMode === "from_GiD_file" && !asStr(ctx.values.distanceFile, "")) problems.push("Name the .post.res file the distance is read from.");
    return problems;
  },
});
