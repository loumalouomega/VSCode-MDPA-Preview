/**
 * Built-in generic CoSimulation problemtype (roadmap item 16): a partitioned
 * coupling of the fluid and structural solvers through CoSimulationApplication,
 * weak (gauss_seidel_weak, one pass per step) or strong (gauss_seidel_strong,
 * iterated to a convergence criterion with an optional accelerator), across one
 * or more interface pairs. One case writes three kinds of file:
 *   - ProjectParametersCoSim.json: the coupling settings (the coupling sequence,
 *     one solver wrapper per participant with its input file and interface data,
 *     one kratos_mapping operator, and per pair a predictor and, for strong
 *     coupling, a convergence criterion and an accelerator);
 *   - ProjectParametersCFD.json and ProjectParametersCSM.json: each participant's
 *     ordinary solver document, built by its physics problemtype from its own mesh
 *     slice and materials file;
 *   - MainKratosCoSim.py: the driver, with the cooperative stop.
 *
 * Composed from the Fluid and Structural Mechanics built-ins the way FSI is: prefixed
 * fields and conditions, and the participants' own hooks, so a fix there reaches
 * this one. The difference from FSI is the shape. FSI nests both solvers inside one
 * FSIApplication analysis; here each participant is a separate document and solver,
 * which is what a CoSimulation case needs.
 *
 * The shape follows CoSimulationApplication's Mok FSI benchmark at master
 * (tests/fsi_mok): the structure pulls the fluid REACTION as its POINT_LOAD with
 * `swap_sign` (a reaction is the force ON the fluid) and pushes its DISPLACEMENT
 * back; the fluid's own exchange lists stay empty, so a strong coupling's
 * accelerated displacement is not overwritten by a second transfer. With ALE
 * mesh motion on, the fluid participant becomes an `ale_fluid` solver whose
 * interface moves with MESH_DISPLACEMENT and whose other boundaries are fixed by
 * `processes.ale_boundary_conditions`. Pair i (counting from 1) exchanges data
 * named `fluid_interface_load`, `fluid_interface_load_2`, … so the first pair
 * keeps the names of a one-pair case. None of this is checked against a solver
 * run here (roadmap item 16's acceptance run).
 */

import { asNum, asStr, defaultCaseState, defineProblemtype } from "../api";
import { buildProcesses, buildSolverDocument } from "../generate";
import { validateFluidTimeStepping } from "../timeStepEstimate";
import type {
  Assignment,
  CaseState,
  ConditionSpec,
  DomainContext,
  FieldGroupSpec,
  FieldSpec,
  GenContext,
  JsonObject,
  JsonValue,
  ProblemtypeDeclaration,
  ProblemtypeRuntime,
} from "../types";
import { fluid } from "./fluid";
import { structural, STRUCTURAL_ELEMENT_NAMES } from "./structural";
import { prefixFields, prefixLawRules, unprefixValues, vectorConstraint } from "./common";

const F = "f_";
const S = "s_";
const FLUID_PARTS = `${F}parts`;
const STRUCT_PARTS = `${S}parts`;

/** The documents the coupled solver names as each participant's input file. */
const PRIMARY_DOCUMENT = "ProjectParametersCoSim.json";
const CFD_DOCUMENT = "ProjectParametersCFD.json";
const CSM_DOCUMENT = "ProjectParametersCSM.json";

/** The interface variables: the fluid reaction goes to the structure, the structure's displacement comes back. */
const MAPPER = "kratos_mapping";
const FLUID_LOAD_VARIABLE = "REACTION";
const STRUCTURE_LOAD_VARIABLE = "POINT_LOAD";
const STRUCTURE_DISPLACEMENT_VARIABLE = "DISPLACEMENT";
/** A fluid that moves its mesh takes the displacement as MESH_DISPLACEMENT; one that does not has nowhere to put it. */
const fluidDisplacementVariable = (ale: boolean): string => (ale ? "MESH_DISPLACEMENT" : "DISPLACEMENT");

/** The Fluid problemtype's field the structure also reads: shared start/end time live at top level. */
const FLUID_SECTION = fluid.decl.sections[0];
const STRUCT_SECTION = structural.decl.sections[0];
const FLUID_OMIT = ["startTime", "endTime"];
const STRUCT_OMIT = ["startTime", "timeStep", "endTime"];

const fluidFields = prefixFields(FLUID_SECTION.fields.filter((f) => !FLUID_OMIT.includes(f.id)), F);
const structFields = prefixFields(STRUCT_SECTION.fields.filter((f) => !STRUCT_OMIT.includes(f.id) && f.group !== "time"), S);
const regroup = (groups: FieldGroupSpec[] | undefined, prefix: string, owner: string, omit: string[]): FieldGroupSpec[] =>
  (groups ?? []).filter((g) => !omit.includes(g.id)).map((g) => ({ ...g, id: prefix + g.id, label: `${owner} · ${g.label}` }));

const STRONG = { field: "couplingType", equals: "strong" };
const AITKEN = [STRONG, { field: "accelerator", equals: "aitken" }];
const ALE_ON = { field: "aleMesh", equals: true };

const couplingFields: FieldSpec[] = [
  { id: "startTime", label: "Start time", type: "number", default: 0, group: "time", unit: "s" },
  { id: "endTime", label: "End time", type: "number", default: 1.0, group: "time", unit: "s" },
  {
    id: "couplingType",
    label: "Coupling",
    type: "enum",
    default: "weak",
    group: "coupling",
    options: [
      { value: "weak", label: "Weak (one pass per step)" },
      { value: "strong", label: "Strong (iterate to convergence)" },
    ],
    help: "Weak coupling exchanges data once per step; strong coupling repeats the exchange until the interface displacement converges. Strong coupling needs ALE mesh motion.",
  },
  {
    id: "numCouplingIterations",
    label: "Max coupling iterations",
    type: "int",
    default: 10,
    min: 1,
    group: "coupling",
    visibleWhen: STRONG,
  },
  {
    id: "absTolerance",
    label: "Absolute tolerance",
    type: "number",
    default: 1e-5,
    min: 0,
    group: "coupling",
    visibleWhen: STRONG,
    help: "Of the relative_norm_previous_residual criterion on the fluid interface displacement.",
  },
  { id: "relTolerance", label: "Relative tolerance", type: "number", default: 1e-5, min: 0, group: "coupling", visibleWhen: STRONG },
  {
    id: "accelerator",
    label: "Convergence accelerator",
    type: "enum",
    default: "mvqn",
    group: "acceleration",
    visibleWhen: STRONG,
    options: [
      { value: "none", label: "None" },
      { value: "aitken", label: "Aitken relaxation" },
      { value: "mvqn", label: "MVQN (multi-vector quasi-Newton)" },
      { value: "iqnils", label: "IQN-ILS" },
    ],
  },
  { id: "aitkenInitAlpha", label: "Initial relaxation α₀", type: "number", default: 0.1, group: "acceleration", visibleWhen: AITKEN, advanced: true },
  { id: "aitkenInitAlphaMax", label: "Initial relaxation cap", type: "number", default: 0.45, group: "acceleration", visibleWhen: AITKEN, advanced: true },
  { id: "aitkenAlphaMax", label: "Largest relaxation", type: "number", default: 2.0, group: "acceleration", visibleWhen: AITKEN, advanced: true },
  { id: "aitkenAlphaMin", label: "Smallest relaxation", type: "number", default: -2.0, group: "acceleration", visibleWhen: AITKEN, advanced: true },
  {
    id: "acceleratorAlpha",
    label: "Quasi-Newton relaxation α",
    type: "number",
    default: 0.125,
    group: "acceleration",
    visibleWhen: [STRONG, { field: "accelerator", oneOf: ["mvqn", "iqnils"] }],
    advanced: true,
    help: "The relaxation of the first iteration, before the quasi-Newton update has data.",
  },
  {
    id: "predictor",
    label: "Predictor",
    type: "enum",
    default: "average_value_based",
    group: "acceleration",
    options: [
      { value: "average_value_based", label: "Average value" },
      { value: "linear_derivative_based", label: "Linear (from the interface velocity)" },
      { value: "none", label: "None" },
    ],
    help: "How the interface displacement of a new step is predicted before the fluid solves.",
  },
  {
    id: "predictorBeta",
    label: "Predictor weight β",
    type: "number",
    default: 0.5,
    min: 0,
    max: 1,
    group: "acceleration",
    visibleWhen: { field: "predictor", equals: "average_value_based" },
    help: "Weight of the predicted interface value when a step ends (the average-value predictor).",
  },
  {
    id: "mapperType",
    label: "Mapper",
    type: "enum",
    default: "nearest_element",
    group: "mapping",
    options: [
      { value: "nearest_element", label: "Nearest element" },
      { value: "nearest_neighbor", label: "Nearest neighbor" },
      { value: "barycentric", label: "Barycentric" },
    ],
    help: "The MappingApplication mapper between the two sides of every interface pair.",
  },
  {
    id: "aleMesh",
    label: "Move the fluid mesh (ALE)",
    type: "bool",
    default: false,
    group: "ale",
    help: "The fluid becomes an ale_fluid solver whose interface follows the structure; other fluid boundaries hold their mesh with \"ALE mesh displacement\".",
  },
  {
    id: "meshSolver",
    label: "Mesh motion solver",
    type: "enum",
    default: "structural_similarity",
    group: "ale",
    visibleWhen: ALE_ON,
    options: [
      { value: "structural_similarity", label: "Structural similarity" },
      { value: "laplacian", label: "Laplacian" },
    ],
  },
];

const fluidList = (cond: ConditionSpec): string =>
  cond.category === "initial" ? "fluid_initial_conditions_process_list" : "fluid_boundary_conditions_process_list";
const structList = (cond: ConditionSpec): string =>
  cond.list === "loads_process_list" ? "structure_loads_process_list" : "structure_constraints_process_list";

const fluidConditions: ConditionSpec[] = fluid.decl.conditions.map((c) => ({
  ...c,
  id: F + c.id,
  label: c.id === "parts" ? "Fluid body" : c.label,
  list: c.id === "parts" ? "list_other_processes" : fluidList(c),
}));
const structConditions: ConditionSpec[] = structural.decl.conditions.map((c) => ({
  ...c,
  id: S + c.id,
  label: c.id === "parts" ? "Structure body" : c.label,
  list: c.id === "parts" ? "list_other_processes" : structList(c),
}));

const fluidInterface: ConditionSpec = {
  id: "fluidInterface",
  label: "Coupling interface (fluid side)",
  list: "list_other_processes",
  target: "surface",
  category: "constraints",
  icon: "ptCoupling",
  noProcess: true,
  help: "The fluid boundary that sends its load to the structure. It marks the interface for the settings; it is not a process.",
  fields: [],
  processTemplate: {},
};
const structureInterface: ConditionSpec = {
  id: "structureInterface",
  label: "Coupling interface (structure side)",
  list: "list_other_processes",
  target: "surface",
  category: "constraints",
  icon: "ptCoupling",
  noProcess: true,
  help: "The structure boundary that receives the fluid load and returns its displacement.",
  fields: [],
  processTemplate: {},
};

const aleBC: ConditionSpec = {
  ...vectorConstraint("MESH_DISPLACEMENT", {
    id: "aleMeshBC",
    label: "ALE mesh displacement",
    list: "list_other_processes",
    unit: "m",
    icon: "ptConstraint",
    help: "Holds the fluid mesh on a boundary that does not move with the structure (ALE mesh motion only).",
  }),
  noProcess: true,
};

const decl: ProblemtypeDeclaration = {
  ...fluid.decl,
  id: "cosim",
  name: "Generic Coupling (CoSimulation)",
  description: "Partitioned weak or strong coupling of the fluid and structural solvers through CoSimulationApplication",
  icon: "ptCoupling",
  family: "coupled",
  analysisStage: "KratosMultiphysics.CoSimulationApplication.co_simulation_analysis",
  // The two Kratos wrappers, the kratos_mapping data transfer operator, and the
  // mesh motion an ale_fluid participant imports.
  applications: [
    "FluidDynamicsApplication",
    "StructuralMechanicsApplication",
    "MappingApplication",
    { application: "MeshMovingApplication", when: ALE_ON },
  ],
  couplingInterfaces: [{ label: "Coupling interface", sides: ["fluidInterface", "structureInterface"] }],
  modelPartName: "FluidModelPart",
  materialsFileName: "FluidMaterials.json",
  primaryDocumentName: PRIMARY_DOCUMENT,
  driverScriptName: "MainKratosCoSim.py",
  // CoSimulationAnalysis reading PRIMARY_DOCUMENT, recording the coupling iterations.
  driverTemplate: "cosim",
  partsCondition: FLUID_PARTS,
  domainSizes: [2, 3],
  meshNaming: undefined,
  domains: [
    {
      id: "fluid",
      label: "Fluid",
      modelPartName: "FluidModelPart",
      mdpaSuffix: "Fluid",
      materialsFileName: "FluidMaterials.json",
      partsCondition: FLUID_PARTS,
      conditionIds: [...fluidConditions.map((c) => c.id), "aleMeshBC", "fluidInterface"],
      required: [{ conditionId: "fluidInterface", message: 'mark the fluid side of the interface: assign at least one SubModelPart as "Coupling interface (fluid side)".' }],
      meshNaming: { elements: "Element", conditions: "WallCondition" },
    },
    {
      id: "structure",
      label: "Structure",
      modelPartName: "Structure",
      mdpaSuffix: "Structural",
      materialsFileName: "StructuralMaterials.json",
      partsCondition: STRUCT_PARTS,
      conditionIds: [...structConditions.map((c) => c.id), "structureInterface"],
      required: [{ conditionId: "structureInterface", message: 'mark the structure side of the interface: assign at least one SubModelPart as "Coupling interface (structure side)".' }],
      meshNaming: { elements: { field: "s_elementBase", names: STRUCTURAL_ELEMENT_NAMES }, conditions: { 2: "LineLoadCondition", 3: "SurfaceLoadCondition" } },
      // The interface face reads PRESSURE / SURFACE_LOAD, so the mapped
      // POINT_LOAD needs one-node point conditions of its own. They go into a
      // sibling part (the interface part must stay a pure surface for the
      // mapper's displacement transfer); see interfacePointLoad.ts.
      pointLoadInterface: { conditionId: "structureInterface" },
    },
  ],
  sections: [
    {
      id: "coupling",
      label: "Coupling",
      icon: "ptCoupling",
      groups: [
        { id: "time", label: "Time", icon: "ptTime" },
        { id: "coupling", label: "Partitioned coupling", icon: "ptCoupling" },
        { id: "acceleration", label: "Prediction and acceleration", icon: "ptSolver" },
        { id: "mapping", label: "Interface mapping", icon: "ptCoupling" },
        { id: "ale", label: "ALE mesh motion", icon: "ptSolver" },
      ],
      fields: couplingFields,
    },
    {
      id: "fluid",
      label: "Fluid",
      icon: "ptFluid",
      groups: regroup(FLUID_SECTION.groups, F, "Fluid", []),
      fields: fluidFields,
    },
    {
      id: "structure",
      label: "Structure",
      icon: "ptStructural",
      groups: regroup(STRUCT_SECTION.groups, S, "Structure", ["time"]),
      fields: structFields,
    },
  ],
  conditions: [...fluidConditions, aleBC, fluidInterface, ...structConditions, structureInterface],
  materialLaws: [
    ...fluid.decl.materialLaws.map((l) => ({ ...l, domain: "fluid" })),
    // The structure's laws carry `when` rules over its prefixed fields.
    ...prefixLawRules(structural.decl.materialLaws, S).map((l) => ({ ...l, domain: "structure" })),
  ],
  output: fluid.decl.output,
};

const own = (cond: ConditionSpec, prefix: string, base: ConditionSpec[]): ConditionSpec =>
  base.find((c) => c.id === cond.id.slice(prefix.length)) ?? cond;
const stripPrefix = (a: Assignment, prefix: string): Assignment => ({ ...a, conditionId: a.conditionId.slice(prefix.length) });
const dotted = (smp: string): string => smp.split("/").join(".");

/** The SubModelPart paths assigned as each side of the interface, in assignment order (pair i is the i-th of each). */
function interfaces(ctx: GenContext): { fluid: string[]; structure: string[] } {
  const fluidSide = (ctx.domains?.fluid.assignments ?? []).filter((a) => a.conditionId === "fluidInterface");
  const structureSide = (ctx.domains?.structure.assignments ?? []).filter((a) => a.conditionId === "structureInterface");
  return { fluid: fluidSide.map((a) => a.smpPath), structure: structureSide.map((a) => a.smpPath) };
}

/**
 * One participant's own solver document, built by its physics problemtype from
 * that participant's domain of this case. The interface marks are not processes
 * of the participant, so only its own conditions go in.
 */
async function participantDocument(
  runtime: ProblemtypeRuntime,
  prefix: string,
  ctx: GenContext,
  domain: DomainContext,
  extra: Record<string, JsonValue>,
  nodalVariables: string[]
): Promise<JsonObject> {
  const assignments = domain.assignments.filter((a) => a.conditionId.startsWith(prefix)).map((a) => stripPrefix(a, prefix));
  const ownCtx: GenContext = { ...domain, values: { ...unprefixValues(ctx.values, prefix), ...extra }, assignments };
  const state: CaseState = {
    ...defaultCaseState(runtime.decl),
    assignments,
    output: { ...(ctx.output ?? defaultCaseState(runtime.decl).output), nodalVariables },
  };
  const processes = await buildProcesses(runtime, ownCtx, state, []);
  return buildSolverDocument(runtime, ownCtx, state, processes);
}

/** The data-name suffix of pair i (0-based): the first pair keeps the plain names. */
const pairSuffix = (i: number): string => (i === 0 ? "" : `_${i + 1}`);

/** The kratos_mapping mapper settings; a barycentric mapper must be told what it interpolates on. */
function mapperSettings(v: Record<string, JsonValue>, dim: 2 | 3): JsonObject {
  const type = asStr(v.mapperType, "nearest_element");
  return type === "barycentric" ? { mapper_type: type, interpolation_type: dim === 2 ? "line" : "triangle" } : { mapper_type: type };
}

/** The predictor of one pair, on the fluid displacement it predicts. */
function predictorOf(v: Record<string, JsonValue>, suffix: string): JsonObject | undefined {
  const type = asStr(v.predictor, "average_value_based");
  const base = { type, solver: "fluid", data_name: `fluid_interface_displacement${suffix}` };
  if (type === "average_value_based") return { ...base, beta: asNum(v.predictorBeta, 0.5) };
  if (type === "linear_derivative_based") return { ...base, derivative_data_name: `fluid_interface_velocity${suffix}` };
  return undefined;
}

/** The accelerator of one pair (strong coupling), with the settings its type reads. */
function acceleratorOf(v: Record<string, JsonValue>, suffix: string): JsonObject | undefined {
  const type = asStr(v.accelerator, "mvqn");
  const base = { type, solver: "fluid", data_name: `fluid_interface_displacement${suffix}` };
  if (type === "aitken") {
    return {
      ...base,
      init_alpha: asNum(v.aitkenInitAlpha, 0.1),
      init_alpha_max: asNum(v.aitkenInitAlphaMax, 0.45),
      alpha_max: asNum(v.aitkenAlphaMax, 2.0),
      alpha_min: asNum(v.aitkenAlphaMin, -2.0),
    };
  }
  if (type === "mvqn" || type === "iqnils") return { ...base, alpha: asNum(v.acceleratorAlpha, 0.125) };
  return undefined;
}

/**
 * The coupled solver's settings: the sequence, the wrappers with every pair's
 * interface data, one mapper, and per pair a predictor and (strong coupling) a
 * criterion and an accelerator, all on the fluid interface displacement.
 */
function couplingSettings(ctx: GenContext, v: Record<string, JsonValue>): JsonObject {
  const { fluid: fl, structure: st } = interfaces(ctx);
  const dim = ctx.domainSize;
  const strong = asStr(v.couplingType, "weak") === "strong";
  const ale = v.aleMesh === true;
  const withVelocity = asStr(v.predictor, "average_value_based") === "linear_derivative_based";
  const pairs = fl.slice(0, Math.min(fl.length, st.length)).map((f, i) => ({ f, s: st[i], suffix: pairSuffix(i) }));

  const fluidData: JsonObject = {};
  const structureData: JsonObject = {};
  const structureInputs: JsonObject[] = [];
  const structureOutputs: JsonObject[] = [];
  const predictors: JsonObject[] = [];
  const accelerators: JsonObject[] = [];
  const criteria: JsonObject[] = [];
  for (const { f, s, suffix } of pairs) {
    const fluidNode = `${ctx.domains!.fluid.modelPartName}.${dotted(f)}`;
    const structureNode = `${ctx.domains!.structure.modelPartName}.${dotted(s)}`;
    fluidData[`fluid_interface_load${suffix}`] = { model_part_name: fluidNode, variable_name: FLUID_LOAD_VARIABLE, dimension: dim };
    fluidData[`fluid_interface_displacement${suffix}`] = { model_part_name: fluidNode, variable_name: fluidDisplacementVariable(ale), dimension: dim };
    if (withVelocity) fluidData[`fluid_interface_velocity${suffix}`] = { model_part_name: fluidNode, variable_name: "VELOCITY", dimension: dim };
    structureData[`structure_interface_load${suffix}`] = { model_part_name: structureNode, variable_name: STRUCTURE_LOAD_VARIABLE, dimension: dim };
    structureData[`structure_interface_displacement${suffix}`] = { model_part_name: structureNode, variable_name: STRUCTURE_DISPLACEMENT_VARIABLE, dimension: dim };
    structureInputs.push({
      data: `structure_interface_load${suffix}`,
      from_solver: "fluid",
      from_solver_data: `fluid_interface_load${suffix}`,
      data_transfer_operator: MAPPER,
      data_transfer_operator_options: ["swap_sign"],
    });
    structureOutputs.push({
      data: `structure_interface_displacement${suffix}`,
      to_solver: "fluid",
      to_solver_data: `fluid_interface_displacement${suffix}`,
      data_transfer_operator: MAPPER,
    });
    const predictor = predictorOf(v, suffix);
    if (predictor) predictors.push(predictor);
    if (strong) {
      const accelerator = acceleratorOf(v, suffix);
      if (accelerator) accelerators.push(accelerator);
      criteria.push({
        type: "relative_norm_previous_residual",
        solver: "fluid",
        data_name: `fluid_interface_displacement${suffix}`,
        abs_tolerance: asNum(v.absTolerance, 1e-5),
        rel_tolerance: asNum(v.relTolerance, 1e-5),
      });
    }
  }

  const settings: JsonObject = {
    type: strong ? "coupled_solvers.gauss_seidel_strong" : "coupled_solvers.gauss_seidel_weak",
    echo_level: 1,
  };
  if (strong) {
    settings.num_coupling_iterations = asNum(v.numCouplingIterations, 10);
    settings.convergence_accelerators = accelerators;
    settings.convergence_criteria = criteria;
  }
  return {
    ...settings,
    predictors,
    data_transfer_operators: { [MAPPER]: { type: MAPPER, mapper_settings: mapperSettings(v, dim) } },
    // The fluid's own lists stay empty: the structure pulls the load and pushes the
    // displacement, so an accelerated displacement is never overwritten.
    coupling_sequence: [
      { name: "fluid", input_data_list: [], output_data_list: [] },
      { name: "structure", input_data_list: structureInputs, output_data_list: structureOutputs },
    ],
    solvers: {
      fluid: {
        type: "solver_wrappers.kratos.fluid_dynamics_wrapper",
        solver_wrapper_settings: { input_file: CFD_DOCUMENT },
        data: fluidData,
      },
      structure: {
        type: "solver_wrappers.kratos.structural_mechanics_wrapper",
        solver_wrapper_settings: { input_file: CSM_DOCUMENT },
        data: structureData,
      },
    },
  };
}

/** One `fix_vector_variable_process` holding MESH_DISPLACEMENT on a fluid boundary (the Mok benchmark's shape). */
const fixMeshDisplacement = (modelPart: string): JsonObject => ({
  python_module: "fix_vector_variable_process",
  kratos_module: "KratosMultiphysics",
  process_name: "AssignVectorVariableProcess",
  Parameters: { model_part_name: modelPart, variable_name: "MESH_DISPLACEMENT", constrained: [true, true, true] },
});

/** The fluid's output variables, with MESH_DISPLACEMENT when its mesh moves. */
const withMeshDisplacement = (vars: string[], ale: boolean): string[] =>
  ale && !vars.includes("MESH_DISPLACEMENT") ? [...vars, "MESH_DISPLACEMENT"] : vars;

/** A coupling interface is a no-slip wall. Constraining its velocity is what
 * makes the fluid's REACTION carry the wall load: the ALE solver copies the
 * mesh velocity onto the interface before each solve, but only a constrained
 * (fixed) velocity turns that copy into an exported reaction. */
const noSlipInterface = (modelPart: string): JsonObject => ({
  python_module: "apply_noslip_process",
  kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
  process_name: "ApplyNoSlipProcess",
  Parameters: { model_part_name: modelPart },
});

export const cosim = defineProblemtype(decl, {
  // Interface pairing, dimension and overlap are checked by the generator from
  // `couplingInterfaces`.
  validate: (ctx) => {
    const problems: string[] = [];
    const ale = ctx.values.aleMesh === true;
    if (asStr(ctx.values.couplingType, "weak") === "strong" && !ale) {
      problems.push(
        "Strong coupling needs the fluid mesh to move: turn on \"Move the fluid mesh (ALE)\". Without it the fluid never sees the structure's displacement, so the iterations have nothing to converge."
      );
    }
    const held = (ctx.domains?.fluid.assignments ?? []).filter((a) => a.conditionId === "aleMeshBC");
    if (!ale && held.length) {
      problems.push(
        `"ALE mesh displacement" is assigned to ${held.map((a) => `"${a.smpPath}"`).join(", ")} but the fluid mesh does not move: turn on "Move the fluid mesh (ALE)" or remove the assignment.`
      );
    }
    for (const issue of validateFluidTimeStepping(unprefixValues(ctx.values, F))) {
      if (issue.severity === "error") problems.push(issue.message);
    }
    return problems;
  },
  buildProcess: (cond, a, ctx) =>
    cond.id.startsWith(F)
      ? fluid.buildProcess(own(cond, F, fluid.decl.conditions), a, ctx)
      : cond.id.startsWith(S)
        ? structural.buildProcess(own(cond, S, structural.decl.conditions), a, ctx)
        : undefined,
  solverSettings: (v, ctx) => couplingSettings(ctx, v),
  postProcess: (pp, ctx) => ({
    problem_data: {
      problem_name: ctx.mdpaStem,
      parallel_type: "OpenMP",
      echo_level: 1,
      start_time: asNum(ctx.values.startTime, 0),
      end_time: asNum(ctx.values.endTime, 1),
    },
    solver_settings: pp.solver_settings,
  }),
  extraFiles: async (ctx) => {
    const domains = ctx.domains!;
    const { fluid: fl } = interfaces(ctx);
    const time = { startTime: ctx.values.startTime ?? 0, endTime: ctx.values.endTime ?? 1 };
    const fluidDocument = await participantDocument(
      fluid,
      F,
      ctx,
      domains.fluid,
      time,
      withMeshDisplacement(ctx.output?.nodalVariables ?? fluid.decl.output.nodalDefaults, ctx.values.aleMesh === true)
    );
    const fluidSettings = fluidDocument.solver_settings as JsonObject;
    // The interfaces are skins of the fluid solver, although they are not its processes.
    fluidSettings.skin_parts = [
      ...((fluidSettings.skin_parts as JsonValue[] | undefined) ?? []),
      ...fl.map((smp) => `${domains.fluid.modelPartName}.${dotted(smp)}`),
    ];
    // A skin wall that nothing constrains carries no reaction out of the fluid
    // solve, so the structure would receive an empty load: constrain the
    // interface velocity (the AleFluidSolver then sets it from the mesh).
    const fluidProcesses = fluidDocument.processes as JsonObject;
    fluidProcesses.constraints_process_list = [
      ...((fluidProcesses.constraints_process_list as JsonValue[] | undefined) ?? []),
      ...fl.map((smp) => noSlipInterface(`${domains.fluid.modelPartName}.${dotted(smp)}`)),
    ];
    const structureDocument = await participantDocument(
      structural,
      S,
      ctx,
      domains.structure,
      { ...time, timeStep: asNum(ctx.values.f_timeStep, 0.01) },
      structural.decl.output.nodalDefaults
    );
    // Both participants advance with the same time step, as GiD's coupled cases do.
    (structureDocument.solver_settings as JsonObject).time_stepping = fluidSettings.time_stepping;
    if (ctx.values.aleMesh === true) {
      // The fluid participant moves its mesh: wrap its settings in an ale_fluid solver
      // whose interfaces follow the structure, and hold the other boundaries the user named.
      fluidDocument.solver_settings = {
        solver_type: "ale_fluid",
        ale_boundary_parts: fl.map(dotted),
        mesh_motion_solver_settings: { solver_type: asStr(ctx.values.meshSolver, "structural_similarity") },
        fluid_solver_settings: fluidSettings,
      };
      const held: JsonObject[] = [];
      for (const a of domains.fluid.assignments.filter((x) => x.conditionId === "aleMeshBC")) {
        const p = await structural.buildProcess(aleBC, a, domains.fluid);
        if (p) held.push(p);
      }
      (fluidDocument.processes as JsonObject).ale_boundary_conditions = [
        ...fl.map((smp) => fixMeshDisplacement(`${domains.fluid.modelPartName}.${dotted(smp)}`)),
        ...held,
      ];
    }
    return [
      { name: CFD_DOCUMENT, content: JSON.stringify(fluidDocument, null, 4) + "\n" },
      { name: CSM_DOCUMENT, content: JSON.stringify(structureDocument, null, 4) + "\n" },
    ];
  },
});
