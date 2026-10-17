/**
 * Built-in Turbulent Flow (RANS) problemtype: the RANSApplication's coupled
 * solver (`CoupledRANS`) over the incompressible Navier-Stokes flow solver
 * (monolithic VMS/QSVMS or fractional step) and a two-equation turbulence
 * model — k-epsilon, k-omega or k-omega SST — with the logarithmic wall
 * function.
 *
 * Derived from the Fluid built-in, not copied: its inlet, outlet, slip,
 * constraint and monitor conditions, its gravity and time-stepping fields and
 * its hooks are reused, so a fix to Fluid reaches this one. What this adds is
 * the RANS solver document (the `formulation_settings` tree each formulation
 * validates), the turbulence initial and inlet values derived from a free-stream
 * intensity and length scale, the wall-function wall (RANS applies its wall
 * function to ONE wall part) and its roughness property, and the exact nodal
 * periodic process RANS uses instead of the core one.
 *
 * Shapes follow Kratos master's own RANSApplication tests
 * (tests/ChannelFlowTest, tests/BackwardFacingStepTest) and its formulation
 * classes; not solver-verified in this repository.
 */

import { defineProblemtype, asBool, asNum, asStr, dottedModelPart } from "../api";
import type { ConditionSpec, FieldSpec, JsonObject, JsonValue, MaterialLawSpec, ProblemtypeDeclaration } from "../types";
import { fluid } from "./fluid";
import { monitoredMainScript } from "../mainKratosTemplate";
import { withoutRulesOn } from "./common";

const BASE = fluid.decl;
const BASE_SECTION = BASE.sections[0];

/** Fields of the Fluid section that name a formulation RANS does not offer (it owns the choice). */
const DROPPED = [
  "strategy", "elementType", "timeIntegrated", "ficBeta", "soundVelocity", "nonNewtonian", "powerLawK", "powerLawN",
  "yieldStress", "regularization", "forceSteadyState", "timeOrder", "useSlipConditions", "timeScheme", "bossakAlpha",
  "oss", "predictorCorrector", "pressureTolerance", "maxPressureIterations", "velocityTolerance", "maxVelocityIterations",
  "relVelTol", "absVelTol", "relPresTol", "absPresTol", "maxIterations", "dynamicTau",
];

const MONOLITHIC = { field: "flowSolver", equals: "monolithic" };
const FRACTIONAL = { field: "flowSolver", equals: "fractional_step" };

/** The turbulence model's name in Kratos and the keys its formulation validates. */
const MODELS: Record<string, { key: string; dissipation: string; dissipationVariable: string; dissipationSettings: string }> = {
  k_epsilon: {
    key: "k_epsilon",
    dissipation: "epsilon",
    dissipationVariable: "TURBULENT_ENERGY_DISSIPATION_RATE",
    dissipationSettings: "turbulent_energy_dissipation_rate_solver_settings",
  },
  k_omega: {
    key: "k_omega",
    dissipation: "omega",
    dissipationVariable: "TURBULENT_SPECIFIC_ENERGY_DISSIPATION_RATE",
    dissipationSettings: "turbulent_specific_energy_dissipation_rate_solver_settings",
  },
  k_omega_sst: {
    key: "k_omega_sst",
    dissipation: "omega",
    dissipationVariable: "TURBULENT_SPECIFIC_ENERGY_DISSIPATION_RATE",
    dissipationSettings: "turbulent_specific_energy_dissipation_rate_solver_settings",
  },
};

/** The standard-model constant the inlet and initial values are derived with. */
const C_MU = 0.09;

const RANS_WALL_LAW_ID = "rans_wall";

const ransFields: FieldSpec[] = [
  {
    id: "flowSolver",
    label: "Flow solver",
    type: "enum",
    default: "monolithic",
    group: "formulation",
    options: [
      { value: "monolithic", label: "Monolithic" },
      { value: "fractional_step", label: "Fractional step" },
    ],
  },
  {
    id: "turbulenceModel",
    label: "Turbulence model",
    type: "enum",
    default: "k_epsilon",
    group: "turbulence",
    options: [
      { value: "k_epsilon", label: "k-epsilon" },
      { value: "k_omega", label: "k-omega" },
      { value: "k_omega_sst", label: "k-omega SST" },
    ],
    help: "k-epsilon is the standard wall-function model; k-omega SST also needs the wall distance, which Kratos computes from the wall part.",
  },
  {
    id: "elementType",
    label: "Flow element",
    type: "enum",
    default: "vms",
    group: "formulation",
    visibleWhen: MONOLITHIC,
    options: [
      { value: "vms", label: "VMS (nodal properties)" },
      { value: "qsvms", label: "Quasi-static VMS" },
    ],
  },
  { id: "oss", label: "Orthogonal subscales", type: "bool", default: false, group: "formulation", visibleWhen: MONOLITHIC },
  { id: "dynamicTau", label: "Dynamic tau", type: "number", default: 0.01, min: 0, group: "formulation" },
  {
    id: "scheme",
    label: "Time scheme",
    type: "enum",
    default: "steady",
    group: "time",
    options: [
      { value: "steady", label: "Steady" },
      { value: "bdf2", label: "BDF2" },
      { value: "bossak", label: "Bossak" },
    ],
    help: "A steady run iterates the pseudo-time steps to convergence; Kratos stops the loop when the solver reports convergence.",
  },
  { id: "bossakAlpha", label: "Bossak alpha", type: "number", default: -0.3, min: -0.5, max: 0, group: "time", visibleWhen: { field: "scheme", equals: "bossak" } },
  {
    id: "stabilization",
    label: "Turbulence stabilization",
    type: "enum",
    default: "algebraic_flux_corrected",
    group: "turbulence",
    options: [
      { value: "algebraic_flux_corrected", label: "Algebraic flux corrected" },
      { value: "residual_based_flux_corrected", label: "Residual-based flux corrected" },
      { value: "non_linear_cross_wind_dissipation", label: "Non-linear cross-wind dissipation" },
    ],
  },
  {
    id: "wallFrictionMethod",
    label: "Wall friction velocity",
    type: "enum",
    default: "velocity_based",
    group: "turbulence",
    options: [
      { value: "velocity_based", label: "From the velocity" },
      { value: "turbulent_kinetic_energy_based", label: "From the turbulent kinetic energy" },
    ],
  },
  { id: "freestreamSpeed", label: "Free-stream speed [m/s]", type: "number", default: 1.0, min: 0, group: "turbulence", help: "With the intensity and length scale below it sets the turbulence at the inlet and the initial values." },
  { id: "turbulenceIntensity", label: "Turbulence intensity", type: "number", default: 0.01, min: 0, max: 1, group: "turbulence", help: "A fraction: 0.01 is 1%. k = 1.5 (I U)²." },
  { id: "turbulenceLength", label: "Turbulence length scale [m]", type: "number", default: 0.01, min: 0, group: "turbulence", help: "The mixing length at the inlet; epsilon = Cmu^0.75 k^1.5 / l, omega = sqrt(k) / (Cmu^0.25 l)." },
  { id: "maxIterations", label: "Maximum flow iterations", type: "int", default: 20, min: 1, group: "convergence", visibleWhen: MONOLITHIC },
  { id: "velocityTolerance", label: "Velocity tolerance", type: "number", default: 1e-3, min: 0, group: "convergence" },
  { id: "pressureTolerance", label: "Pressure tolerance", type: "number", default: 1e-3, min: 0, group: "convergence" },
  { id: "maxVelocityIterations", label: "Maximum velocity iterations", type: "int", default: 20, min: 1, group: "convergence", visibleWhen: FRACTIONAL },
  { id: "maxPressureIterations", label: "Maximum pressure iterations", type: "int", default: 1, min: 1, group: "convergence", visibleWhen: FRACTIONAL },
  { id: "turbulenceTolerance", label: "Turbulence tolerance", type: "number", default: 1e-3, min: 0, group: "convergence" },
  { id: "turbulenceIterations", label: "Turbulence iterations per step", type: "int", default: 3, min: 1, group: "convergence" },
  { id: "couplingIterations", label: "Coupling iterations", type: "int", default: 1, min: 1, group: "convergence", help: "Flow ↔ turbulence iterations per step." },
];

const ransWall: ConditionSpec = {
  id: "ransWall",
  label: "Wall (wall function)",
  list: "constraints_process_list",
  target: "surface",
  category: "constraints",
  icon: "ptConstraint",
  help: "The no-slip wall with the logarithmic wall function. RANS applies it to ONE part, so group every wall into one SubModelPart and give it the Wall roughness material.",
  fields: [],
  processTemplate: {
    python_module: "apply_wall_function_process",
    kratos_module: "KratosMultiphysics.RANSApplication",
    Parameters: { model_part_name: "$path" },
  },
};

const wallLaw: MaterialLawSpec = {
  id: RANS_WALL_LAW_ID,
  name: "",
  variables: [{ id: "WALL_SMOOTHNESS_BETA", label: "Wall smoothness constant B", type: "number", default: 5.2, help: "5.2 is a smooth wall; the log-law intercept shifts down for a rough one." }],
  group: "Wall function",
};

const fluidLaws = (size: 2 | 3): MaterialLawSpec => ({
  id: size === 3 ? "rans_newtonian_3d" : "rans_newtonian_2d",
  name: size === 3 ? "RansNewtonian3DLaw" : "RansNewtonian2DLaw",
  domainSize: size,
  variables: [
    { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 1.204, unit: "kg/m³" },
    { id: "DYNAMIC_VISCOSITY", label: "Dynamic viscosity [Pa·s]", type: "number", default: 1.825e-5, unit: "Pa·s" },
  ],
});

/** Conditions Fluid declares that RANS keeps; the wall-law and no-slip walls give way to the wall-function wall. */
const KEPT = new Set(["parts", "initialVelocity", "initialPressure", "inlet", "outlet", "slip", "velocityConstraints", "pressureConstraints", "periodic", "flowForces", "aerodynamicCoefficients", "pressureCoefficient", "yPlus"]);

const conditions: ConditionSpec[] = [
  ...BASE.conditions
    .filter((c) => KEPT.has(c.id))
    .map((c) =>
      c.id === "periodic"
        ? {
            ...c,
            help: "Ties this boundary (the slave) to the master boundary a translation away, exactly node for node, for the flow and the turbulence variables. Assign it to the slave only and turn on Periodic boundaries.",
            fields: c.fields.map((f) => (f.id === "translation" ? { ...f, help: "From the master to the slave." } : f)),
          }
        : c
    ),
  ransWall,
];

const decl: ProblemtypeDeclaration = {
  ...BASE,
  id: "rans",
  name: "Turbulent Flow (RANS)",
  description: "Incompressible Navier-Stokes with a two-equation turbulence model (k-epsilon, k-omega, k-omega SST) and a wall function (RANSApplication)",
  icon: "ptFluid",
  family: "fluid",
  analysisStage: "KratosMultiphysics.RANSApplication.rans_analysis",
  domainSizes: [2, 3],
  sections: [
    {
      ...BASE_SECTION,
      groups: [
        ...(BASE_SECTION.groups ?? []).filter((g) => g.id !== "time" && g.id !== "convergence" && g.id !== "formulation"),
        { id: "formulation", label: "Flow solver", icon: "ptSolver" },
        { id: "turbulence", label: "Turbulence", icon: "ptSolver" },
        { id: "time", label: "Time", icon: "ptTime" },
        { id: "convergence", label: "Convergence", icon: "ptSolver" },
      ],
      fields: [...withoutRulesOn(BASE_SECTION.fields.filter((f) => !DROPPED.includes(f.id)), DROPPED), ...ransFields],
    },
  ],
  conditions,
  materialLaws: [fluidLaws(3), fluidLaws(2), wallLaw],
  output: { nodalDefaults: ["VELOCITY", "PRESSURE", "TURBULENT_KINETIC_ENERGY", "TURBULENT_VISCOSITY", "RANS_Y_PLUS"] },
};

/** k, the dissipation variable and the eddy viscosity of a free stream with intensity I and length scale l. */
export function freestreamTurbulence(speed: number, intensity: number, length: number, model: string): { k: number; dissipation: number; nut: number } {
  const k = 1.5 * (intensity * speed) ** 2;
  const l = Math.max(length, 1e-12);
  if (model === "k_epsilon") {
    const epsilon = (C_MU ** 0.75 * k ** 1.5) / l;
    return { k, dissipation: epsilon, nut: epsilon > 0 ? (C_MU * k * k) / epsilon : 0 };
  }
  const omega = Math.sqrt(k) / (C_MU ** 0.25 * l);
  return { k, dissipation: omega, nut: omega > 0 ? k / omega : 0 };
}

const scalarInitial = (modelPart: string, variable: string, value: number): JsonObject => ({
  python_module: "process_factory",
  kratos_module: "KratosMultiphysics",
  process_name: "ApplyConstantScalarValueProcess",
  Parameters: { model_part_name: modelPart, variable_name: variable, value },
});

/** The fluid properties of the material on the first Parts part, with the law's defaults. */
function fluidProperties(ctx: { materials: { smpPath: string; lawId: string; values: Record<string, JsonValue> }[]; partsModelParts: string[] }): { density: number; viscosity: number } {
  const law = decl.materialLaws.find((l) => l.id === "rans_newtonian_3d")!;
  const dens = law.variables.find((v) => v.id === "DENSITY")!.default as number;
  const visc = law.variables.find((v) => v.id === "DYNAMIC_VISCOSITY")!.default as number;
  const m = ctx.materials.find((x) => x.lawId.startsWith("rans_newtonian"));
  return { density: asNum(m?.values.DENSITY, dens), viscosity: asNum(m?.values.DYNAMIC_VISCOSITY, visc) };
}

const linear = (tolerance?: number): JsonObject => ({ solver_type: "amgcl", ...(tolerance !== undefined ? { tolerance } : {}) });

export const rans = defineProblemtype(decl, {
  // No convergence adapter: CoupledRANS is not the Navier-Stokes solver the fluid adapter wraps.
  mainScript: () => monitoredMainScript("rans"),
  buildProcess: (cond, a, ctx) => {
    if (cond.id === "periodic") {
      const direction = Array.isArray(a.values.translation) ? a.values.translation : [1, 0, 0];
      return {
        python_module: "cpp_process_factory",
        kratos_module: "KratosMultiphysics.RANSApplication",
        process_name: "ApplyExactNodalPeriodicConditionProcess",
        Parameters: {
          master_model_part_name: dottedModelPart(ctx.modelPartName, asStr(a.values.master, "")),
          slave_model_part_name: dottedModelPart(ctx.modelPartName, a.smpPath),
          tolerance: 1e-6,
          translation_settings: { direction, magnitude: asNum(a.values.magnitude, 1) },
          echo_level: 0,
          reorder: false,
        },
      };
    }
    return fluid.buildProcess(cond, a, ctx);
  },
  solverSettings: async (v, ctx) => {
    // Fluid's hook owns the part lists, the time stepping and the model/material blocks.
    const base = (await fluid.solverSettings({ ...v, strategy: "monolithic", elementType: "qsvms", timeScheme: "bdf2", oss: false, gravityValue: 0 }, ctx)) as JsonObject;
    const model = MODELS[asStr(v.turbulenceModel, "k_epsilon")] ?? MODELS.k_epsilon;
    const fractional = asStr(v.flowSolver, "monolithic") === "fractional_step";
    const turbulenceTolerance = asNum(v.turbulenceTolerance, 1e-3);
    const sub = {
      relative_tolerance: turbulenceTolerance,
      absolute_tolerance: 1e-5,
      max_iterations: asNum(v.turbulenceIterations, 3),
      echo_level: 0,
      relaxation_factor: 0.9,
      linear_solver_settings: linear(),
    };
    const turbulence: JsonObject = {
      stabilization_method: asStr(v.stabilization, "algebraic_flux_corrected"),
      turbulent_kinetic_energy_solver_settings: { ...sub },
      [model.dissipationSettings]: { ...sub },
      echo_level: 0,
      coupling_settings: { relative_tolerance: turbulenceTolerance, absolute_tolerance: 1e-5, max_iterations: asNum(v.couplingIterations, 1) },
      auxiliar_process_list: [],
    };
    const velocityTolerance = asNum(v.velocityTolerance, 1e-3);
    const pressureTolerance = asNum(v.pressureTolerance, 1e-3);
    const formulation: JsonObject = {
      formulation_name: `${fractional ? "fractional_step" : "monolithic"}_${model.key}`,
      incompressible_potential_flow_initialization_settings: {},
    };
    if (fractional) {
      formulation.fractional_step_flow_solver_settings = {
        predictor_corrector: false,
        maximum_velocity_iterations: asNum(v.maxVelocityIterations, 20),
        maximum_pressure_iterations: asNum(v.maxPressureIterations, 1),
        velocity_tolerance: velocityTolerance,
        pressure_tolerance: pressureTolerance,
        dynamic_tau: asNum(v.dynamicTau, 0.01),
        oss_switch: 0,
        echo_level: 0,
        time_order: 2,
        compute_reactions: asBool(v.computeReactions, false),
        reform_dofs_at_each_step: false,
        pressure_linear_solver_settings: linear(1e-6),
        velocity_linear_solver_settings: linear(1e-6),
      };
    } else {
      formulation.monolithic_flow_solver_settings = {
        maximum_iterations: asNum(v.maxIterations, 20),
        echo_level: 0,
        compute_reactions: asBool(v.computeReactions, false),
        reform_dofs_at_each_step: false,
        relative_velocity_tolerance: velocityTolerance,
        absolute_velocity_tolerance: 1e-5,
        relative_pressure_tolerance: pressureTolerance,
        absolute_pressure_tolerance: 1e-5,
        velocity_relaxation: 0.9,
        pressure_relaxation: 0.9,
        linear_solver_settings: linear(),
        move_mesh_strategy: 0,
        move_mesh_flag: false,
        flow_solver_formulation: {
          element_type: asStr(v.elementType, "vms"),
          use_orthogonal_subscales: asBool(v.oss, false),
          dynamic_tau: asNum(v.dynamicTau, 0.01),
        },
      };
    }
    formulation[`${model.key}_solver_settings`] = turbulence;

    const scheme = asStr(v.scheme, "steady");
    const settings: JsonObject = {
      model_part_name: base.model_part_name,
      domain_size: base.domain_size,
      solver_type: "CoupledRANS",
      model_import_settings: base.model_import_settings,
      material_import_settings: base.material_import_settings,
      volume_model_part_name: base.volume_model_part_name,
      skin_parts: base.skin_parts,
      no_skin_parts: base.no_skin_parts,
      time_stepping: base.time_stepping,
      echo_level: asNum(v.echoLevel, 0),
      assign_neighbour_elements_to_conditions: true,
      move_mesh: false,
      time_scheme_settings: scheme === "bossak" ? { scheme_type: "bossak", alpha_bossak: asNum(v.bossakAlpha, -0.3) } : { scheme_type: scheme },
      wall_function_settings: {
        wall_function_region_type: "logarithmic_region_only",
        wall_friction_velocity_calculation_method: asStr(v.wallFrictionMethod, "velocity_based"),
      },
      formulation_settings: formulation,
    };
    if (base.consider_periodic_conditions !== undefined) settings.consider_periodic_conditions = base.consider_periodic_conditions;
    return settings;
  },
  postProcess: async (input, ctx) => {
    // Fluid's own post step: gravity and the monitors' output variables.
    const pp = await fluid.postProcess(input, ctx);
    const v = ctx.values;
    const model = MODELS[asStr(v.turbulenceModel, "k_epsilon")] ?? MODELS.k_epsilon;
    const processes = pp.processes as JsonObject;
    const whole = ctx.modelPartName;
    const t = freestreamTurbulence(asNum(v.freestreamSpeed, 1), asNum(v.turbulenceIntensity, 0.01), asNum(v.turbulenceLength, 0.01), model.key);
    const { density, viscosity } = fluidProperties(ctx);
    const initial = (processes.initial_conditions_process_list as JsonObject[] | undefined) ?? [];
    processes.initial_conditions_process_list = [
      ...initial,
      scalarInitial(whole, "TURBULENT_KINETIC_ENERGY", t.k),
      scalarInitial(whole, model.dissipationVariable, t.dissipation),
      scalarInitial(whole, "VISCOSITY", viscosity / density),
      scalarInitial(whole, "TURBULENT_VISCOSITY", t.nut),
      scalarInitial(whole, "DENSITY", density),
    ];
    // Every inlet carries the free-stream turbulence.
    const boundary = (processes.constraints_process_list as JsonObject[] | undefined) ?? [];
    for (const a of ctx.assignments) {
      if (a.conditionId !== "inlet") continue;
      const part = dottedModelPart(ctx.modelPartName, a.smpPath);
      boundary.push(
        {
          python_module: "cpp_process_factory",
          kratos_module: "KratosMultiphysics.RANSApplication",
          process_name: "KTurbulentIntensityInletProcess",
          Parameters: { model_part_name: part, turbulent_intensity: asNum(v.turbulenceIntensity, 0.01) },
        },
        {
          python_module: "cpp_process_factory",
          kratos_module: "KratosMultiphysics.RANSApplication",
          process_name: model.dissipation === "epsilon" ? "EpsilonTurbulentMixingLengthInletProcess" : "OmegaTurbulentMixingLengthInletProcess",
          Parameters: { model_part_name: part, turbulent_mixing_length: asNum(v.turbulenceLength, 0.01) },
        }
      );
    }
    processes.constraints_process_list = boundary;
    // The turbulence results the output should carry, besides the flow's.
    const vtk = (((pp.output_processes as JsonObject | undefined)?.vtk_output as JsonObject[] | undefined) ?? [])[0];
    if (vtk) {
      const parameters = vtk.Parameters as JsonObject;
      const listed = Array.isArray(parameters.nodal_solution_step_data_variables) ? [...(parameters.nodal_solution_step_data_variables as string[])] : [];
      for (const n of ["TURBULENT_KINETIC_ENERGY", model.dissipationVariable, "TURBULENT_VISCOSITY"]) if (!listed.includes(n)) listed.push(n);
      parameters.nodal_solution_step_data_variables = listed;
    }
    return pp;
  },
  validate: (ctx) => {
    const problems: string[] = [];
    const v = ctx.values;
    const walls = ctx.assignments.filter((a) => a.conditionId === "ransWall");
    if (walls.length === 0) {
      problems.push("A RANS case needs a wall: assign \"Wall (wall function)\" to the SubModelPart holding every wall. The turbulence model reads the wall from it.");
    } else if (walls.length > 1) {
      problems.push(`RANS applies the wall function to ONE part, but ${walls.length} are assigned (${walls.map((w) => w.smpPath).join(", ")}). Group the walls into one SubModelPart.`);
    } else if (!ctx.materials.some((m) => m.lawId === RANS_WALL_LAW_ID && m.smpPath === walls[0].smpPath)) {
      problems.push(`The wall "${walls[0].smpPath}" needs the "Wall function / ${RANS_WALL_LAW_ID}" material: it carries the wall smoothness constant the wall function reads.`);
    }
    const periodic = ctx.assignments.filter((a) => a.conditionId === "periodic");
    if (periodic.length > 0 && !asBool(v.considerPeriodic, false)) {
      problems.push('A Periodic boundary is assigned but "Periodic boundaries" is off in Problem data: the solver would ignore the pairing.');
    }
    for (const a of periodic) {
      if (!asStr(a.values.master, "")) problems.push(`The periodic boundary "${a.smpPath}" has no master boundary.`);
      if (a.values.master === a.smpPath) problems.push(`The periodic boundary "${a.smpPath}" is its own master.`);
    }
    if (!(asNum(v.turbulenceLength, 0.01) > 0)) problems.push("The turbulence length scale must be above zero.");
    return problems;
  },
});
