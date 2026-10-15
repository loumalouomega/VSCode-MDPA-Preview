/**
 * Built-in Structural Optimization problemtype: OptimizationApplication's
 * algorithm-based optimizer (optimization_parameters.json with analyses,
 * responses, controls and algorithm_settings) over a Structural Mechanics
 * primal analysis. One case writes:
 *   - optimization_parameters.json: the optimizer's document (primary);
 *   - primal_parameters.json: the Structural Mechanics document the execution
 *     policy runs every iteration (`@include_json`), reading the model part
 *     the optimizer already imported (`input_type: use_input_model_part`);
 *   - StructuralMaterials.json, as the Structural problemtype writes it;
 *   - MainKratosOpt.py and kkss_optimization_stop.py (the cooperative stop).
 *
 * The primal is set up exactly as in the Structural problemtype (same sections,
 * conditions and materials, delegated to its hooks). What is new is the Setup
 * stage: the responses, the controls (material property, shell thickness,
 * vertex-morphing shape, SIMP) and the constraints are collections, and the
 * objective names a response. Keys follow OptimizationApplication's own
 * defaults at master (algorithms/, responses/, controls/, filtering/,
 * convergence_criteria/, algorithms/standardized_*.py), read 2026-10-14; they
 * are not checked against a solver run here.
 */

import { asBool, asNum, asStr, defaultCaseState, defineProblemtype } from "../api";
import { buildProcesses, buildSolverDocument } from "../generate";
import { OPTIMIZATION_STOP_MODULE, OPTIMIZATION_STOP_PY, optimizationMainKratosPy } from "../mainKratosTemplate";
import type {
  CollectionSpec,
  FieldSpec,
  GenContext,
  JsonObject,
  JsonValue,
  ProblemtypeDeclaration,
  ResolvedCollectionEntry,
  VisibleRule,
} from "../types";
import { structural } from "./structural";

export const OPTIMIZATION_DOCUMENT = "optimization_parameters.json";
export const PRIMAL_DOCUMENT = "primal_parameters.json";
export const PRIMAL_ANALYSIS_NAME = "primal";
/** Where the design fields go; `<model part>_0_<step>.vtm` groups as a timeline. */
export const DESIGN_FIELDS_FOLDER = "Optimization_Results";

/** Algorithms that take constraints (the others only minimize an objective). */
export const CONSTRAINED_ALGORITHMS = [
  "algorithm_gradient_projection",
  "algorithm_relaxed_gradient_projection",
  "algorithm_momentum_relaxed_gradient_projection",
];
const RGP_ALGORITHMS = ["algorithm_relaxed_gradient_projection", "algorithm_momentum_relaxed_gradient_projection"];

const ALGO = (values: string[]): VisibleRule => ({ field: "algorithmType", oneOf: values });
const BB_STEP: VisibleRule = { field: "lsType", oneOf: ["BB_step", "QNBB_step"] };
const CONV = (value: string): VisibleRule => ({ field: "convCriterion", equals: value });
const EXPLICIT: VisibleRule = { field: "filterType", equals: "explicit_filter" };
const REF_VALUE: VisibleRule = { field: "refMode", equals: "value" };

const algorithmFields: FieldSpec[] = [
  { id: "objectiveResponse", label: "Objective", type: "ref", refCollection: "responses", default: "strain_energy", group: "objective" },
  {
    id: "objectiveType",
    label: "Goal",
    type: "enum",
    default: "minimization",
    group: "objective",
    options: [
      { value: "minimization", label: "Minimize" },
      { value: "maximization", label: "Maximize" },
    ],
  },
  { id: "objectiveScaling", label: "Scaling", type: "number", default: 1.0, group: "objective" },
  {
    id: "algorithmType",
    label: "Algorithm",
    type: "enum",
    default: "algorithm_steepest_descent",
    group: "algorithm",
    options: [
      { value: "algorithm_steepest_descent", label: "Steepest descent" },
      // Upstream's own module name carries the typo; it is the key Kratos imports.
      { value: "algorithm_nesterov_accelarated_gradient", label: "Nesterov accelerated gradient" },
      { value: "algorithm_adam", label: "Adam" },
      { value: "algorithm_gradient_projection", label: "Gradient projection (constraints)" },
      { value: "algorithm_relaxed_gradient_projection", label: "Relaxed gradient projection (constraints)" },
      { value: "algorithm_momentum_relaxed_gradient_projection", label: "Momentum relaxed gradient projection (constraints)" },
    ],
    help: "Steepest descent, Nesterov and Adam take no constraints; the projection methods do.",
  },
  { id: "maxIter", label: "Max iterations", type: "int", default: 10, min: 1, group: "algorithm" },
  { id: "eta", label: "Momentum η", type: "number", default: 0.9, min: 0, max: 1, group: "algorithm", visibleWhen: ALGO(["algorithm_nesterov_accelarated_gradient", "algorithm_momentum_relaxed_gradient_projection"]) },
  { id: "adamBeta1", label: "β₁", type: "number", default: 0.9, min: 0, max: 1, group: "algorithm", visibleWhen: ALGO(["algorithm_adam"]) },
  { id: "adamBeta2", label: "β₂", type: "number", default: 0.999, min: 0, max: 1, group: "algorithm", visibleWhen: ALGO(["algorithm_adam"]) },
  { id: "adamEpsilon", label: "ε", type: "number", default: 1e-8, min: 0, group: "algorithm", visibleWhen: ALGO(["algorithm_adam"]) },
  { id: "correctionSize", label: "Correction size", type: "number", default: 0.0, min: 0, group: "algorithm", visibleWhen: ALGO(["algorithm_gradient_projection"]), help: "Step taken back towards the feasible region when a constraint is violated." },
  { id: "historySize", label: "History size", type: "int", default: 20, min: 1, group: "algorithm", visibleWhen: ALGO(RGP_ALGORITHMS) },
  { id: "maxInnerIter", label: "Max inner iterations", type: "int", default: 20, min: 1, group: "algorithm", visibleWhen: ALGO(RGP_ALGORITHMS) },
  { id: "bufferUpdateFactor", label: "Buffer update factor", type: "number", default: 0.1, min: 0, group: "algorithm", visibleWhen: ALGO(RGP_ALGORITHMS) },
  {
    id: "lsType",
    label: "Step",
    type: "enum",
    default: "const_step",
    group: "lineSearch",
    options: [
      { value: "const_step", label: "Constant" },
      { value: "BB_step", label: "Barzilai–Borwein" },
      { value: "QNBB_step", label: "Quasi-Newton Barzilai–Borwein" },
    ],
  },
  { id: "initStep", label: "Initial step", type: "number", default: 0.01, min: 0, group: "lineSearch", help: "In the units of the control: a Young modulus control needs a step comparable to the modulus." },
  { id: "maxStep", label: "Max step", type: "number", default: 0.1, min: 0, group: "lineSearch", visibleWhen: BB_STEP },
  {
    id: "gradientScaling",
    label: "Gradient scaling",
    type: "enum",
    default: "inf_norm",
    group: "lineSearch",
    options: [
      { value: "inf_norm", label: "Infinity norm" },
      { value: "l2_norm", label: "L2 norm" },
      { value: "none", label: "None" },
    ],
  },
  {
    id: "convCriterion",
    label: "Also stop on",
    type: "enum",
    default: "none",
    group: "convergence",
    options: [
      { value: "none", label: "Max iterations only" },
      { value: "l2_conv_criterion", label: "Search direction L2 norm" },
      { value: "avg_abs_improvement_conv_criterion", label: "Average objective improvement" },
      { value: "target_value_conv_criterion", label: "Objective target value" },
      { value: "magnitude_reduction_conv_criterion", label: "Objective magnitude reduction" },
      { value: "patience_conv_criterion", label: "No improvement (patience)" },
    ],
    help: "A criterion is combined with the iteration limit: whichever is met first stops the run.",
  },
  { id: "convTolerance", label: "Tolerance", type: "number", default: 1e-6, min: 0, group: "convergence", visibleWhen: { field: "convCriterion", oneOf: ["l2_conv_criterion", "avg_abs_improvement_conv_criterion", "patience_conv_criterion"] } },
  { id: "convTrackedIter", label: "Tracked iterations", type: "int", default: 5, min: 1, group: "convergence", visibleWhen: CONV("avg_abs_improvement_conv_criterion") },
  { id: "convTargetValue", label: "Target objective", type: "number", default: 0, group: "convergence", visibleWhen: CONV("target_value_conv_criterion") },
  { id: "convScalingFactor", label: "Target reduction factor", type: "number", default: 1e-3, min: 0, group: "convergence", visibleWhen: CONV("magnitude_reduction_conv_criterion") },
  { id: "convMinimumIter", label: "Minimum iterations", type: "int", default: 100, min: 1, group: "convergence", visibleWhen: CONV("patience_conv_criterion") },
  { id: "convPatienceIter", label: "Patience iterations", type: "int", default: 50, min: 1, group: "convergence", visibleWhen: CONV("patience_conv_criterion") },
  { id: "summaryFile", label: "Summary file", type: "string", default: "summary.csv", group: "output" },
  { id: "writeDesignFields", label: "Write design fields (VTU)", type: "bool", default: true, group: "output", help: `Controls, updates and gradients per iteration, under ${DESIGN_FIELDS_FOLDER}/.` },
  {
    id: "designFieldsFormat",
    label: "VTU format",
    type: "enum",
    default: "binary",
    group: "output",
    visibleWhen: { field: "writeDesignFields", equals: true },
    options: [{ value: "binary" }, { value: "ascii" }, { value: "raw" }, { value: "compressed_raw" }],
  },
  { id: "optimizationEchoLevel", label: "Echo level", type: "int", default: 0, min: 0, max: 3, advanced: true },
];

const filterFields: FieldSpec[] = [
  {
    id: "filterType",
    label: "Filter",
    type: "enum",
    default: "implicit_filter",
    options: [
      { value: "implicit_filter", label: "Implicit (Helmholtz)" },
      { value: "explicit_filter", label: "Explicit (vertex morphing)" },
    ],
  },
  { id: "filterRadius", label: "Filter radius", type: "number", default: 0.2, min: 0, help: "In mesh length units: larger radii give smoother designs." },
  {
    id: "filterFunction",
    label: "Filter function",
    type: "enum",
    default: "linear",
    visibleWhen: EXPLICIT,
    options: ["linear", "gaussian", "constant", "cosine", "quartic", "sigmoidal"].map((value) => ({ value })),
  },
  { id: "dampedParts", label: "Damped parts", type: "smpList", help: "SubModelParts where the update is held back (supports, interfaces)." },
  { id: "dampX", label: "Damp X", type: "bool", default: true },
  { id: "dampY", label: "Damp Y", type: "bool", default: true },
  { id: "dampZ", label: "Damp Z", type: "bool", default: true },
  {
    id: "dampingFunction",
    label: "Damping function",
    type: "enum",
    default: "cosine",
    visibleWhen: EXPLICIT,
    options: ["cosine", "linear", "gaussian", "quartic", "sigmoidal", "constant"].map((value) => ({ value })),
  },
];

const projectionFields = (prefix: string, label: string, penalty: number): FieldSpec[] => {
  const adaptive: VisibleRule = { field: `${prefix}Projection`, equals: "adaptive_sigmoidal_projection" };
  return [
    {
      id: `${prefix}Projection`,
      label: `${label} projection`,
      type: "enum",
      default: "adaptive_sigmoidal_projection",
      options: [
        { value: "adaptive_sigmoidal_projection", label: "Adaptive sigmoidal" },
        { value: "sigmoidal_projection", label: "Sigmoidal" },
      ],
    },
    { id: `${prefix}Beta`, label: `${label} β (initial)`, type: "number", default: 5, min: 0 },
    { id: `${prefix}BetaMax`, label: `${label} β max`, type: "number", default: 30, min: 0, visibleWhen: adaptive },
    { id: `${prefix}IncreaseFactor`, label: `${label} β increase factor`, type: "number", default: 1.05, min: 1, visibleWhen: adaptive },
    { id: `${prefix}UpdatePeriod`, label: `${label} β update period`, type: "int", default: 50, min: 1, visibleWhen: adaptive },
    { id: `${prefix}Penalty`, label: `${label} penalty factor`, type: "int", default: penalty, min: 1 },
  ];
};

const EVALUATED = { label: "Evaluated on", target: "any" as const, min: 0 };

export const OPTIMIZATION_COLLECTIONS: CollectionSpec[] = [
  {
    id: "responses",
    label: "Responses",
    icon: "ptResponse",
    help: "Quantities the optimizer evaluates. With no SubModelPart a response is evaluated on the whole structure.",
    entryTypes: [
      { id: "mass", label: "Mass", icon: "ptResponse", parts: EVALUATED, fields: [{ id: "perturbationSize", label: "Perturbation size", type: "number", default: 1e-6, min: 0 }] },
      {
        id: "strainEnergy",
        label: "Linear strain energy",
        icon: "ptResponse",
        parts: EVALUATED,
        help: "Compliance of the primal analysis; minimizing it maximizes stiffness.",
        fields: [{ id: "perturbationSize", label: "Perturbation size", type: "number", default: 1e-8, min: 0 }],
      },
      { id: "centroidDeviation", label: "Geometric centroid deviation", icon: "ptResponse", parts: EVALUATED, fields: [] },
      {
        id: "discreteValueResidual",
        label: "Discrete value residual",
        icon: "ptResponse",
        parts: EVALUATED,
        help: "Pushes a variable towards a set of discrete values (e.g. only two thicknesses).",
        fields: [
          {
            id: "containerType",
            label: "Container",
            type: "enum",
            default: "element_properties",
            options: ["node_historical", "node_non_historical", "condition", "condition_properties", "element", "element_properties"].map((value) => ({ value })),
          },
          { id: "variableName", label: "Variable", type: "string", default: "THICKNESS" },
          { id: "residualType", label: "Residual", type: "enum", default: "exact", options: [{ value: "exact" }, { value: "logarithm" }] },
          { id: "discreteValues", label: "Discrete values", type: "numberList", default: [0.0] },
        ],
      },
    ],
    defaults: [
      { name: "mass", type: "mass" },
      { name: "strain_energy", type: "strainEnergy" },
    ],
  },
  {
    id: "controls",
    label: "Controls",
    icon: "ptControl",
    min: 1,
    help: "What the optimizer may change, and where.",
    entryTypes: [
      {
        id: "material",
        label: "Material property",
        icon: "ptControl",
        parts: { label: "Design region", target: "any", min: 1 },
        fields: [
          {
            id: "variable",
            label: "Property",
            type: "enum",
            default: "YOUNG_MODULUS",
            options: ["YOUNG_MODULUS", "DENSITY", "POISSON_RATIO", "THICKNESS"].map((value) => ({ value })),
          },
          { id: "recursiveUpdate", label: "Recursive property update", type: "bool", default: false },
        ],
      },
      {
        id: "thickness",
        label: "Shell thickness",
        icon: "ptControl",
        parts: { label: "Shell parts", target: "surface", min: 1 },
        help: "For shell elements; the thickness moves between the two physical values.",
        fields: [
          { id: "physicalThicknesses", label: "Physical thicknesses", type: "numberList", default: [0.1, 0.2] },
          ...filterFields,
          ...projectionFields("thickness", "Thickness", 1),
          { id: "outputAllFields", label: "Output all fields", type: "bool", default: false },
        ],
      },
      {
        id: "shape",
        label: "Shape (vertex morphing)",
        icon: "ptControl",
        parts: { label: "Design surface", target: "surface", min: 1 },
        help: "Moves the nodes of the design surface; damp supports and interfaces.",
        fields: [
          ...filterFields.map((f) => (f.id === "filterType" ? { ...f, default: "explicit_filter" } : f)),
          {
            id: "meshMotion",
            label: "Mesh motion",
            type: "enum",
            default: "none",
            options: [
              { value: "none", label: "Design surface only" },
              { value: "filter_based", label: "Filter based (implicit filter)" },
            ],
            help: "Filter-based motion moves interior nodes with the implicit filter. Mesh-moving analysis is not offered.",
          },
          { id: "outputAllFields", label: "Output all fields", type: "bool", default: true },
        ],
      },
      {
        id: "simp",
        label: "Topology (SIMP)",
        icon: "ptControl",
        parts: { label: "Design region", target: "volume", min: 1 },
        help: "Density-based topology: each element interpolates between the listed materials.",
        fields: [
          { id: "densities", label: "Densities", type: "numberList", default: [0.0, 7850.0] },
          { id: "youngModuli", label: "Young moduli", type: "numberList", default: [2.1e6, 2.1e11] },
          ...filterFields.filter((f) => !f.id.startsWith("damp") && f.id !== "dampedParts"),
          ...projectionFields("density", "Density", 1),
          ...projectionFields("young", "Young modulus", 3),
          { id: "outputAllFields", label: "Output all fields", type: "bool", default: true },
        ],
      },
    ],
  },
  {
    id: "constraints",
    label: "Constraints",
    icon: "ptConstraint",
    help: "Limits on responses. Only the projection algorithms take constraints.",
    entryTypes: [
      {
        id: "limit",
        label: "Response limit",
        icon: "ptConstraint",
        fields: [
          { id: "response", label: "Response", type: "ref", refCollection: "responses" },
          { id: "relation", label: "Relation", type: "enum", default: "<=", options: ["<=", "<", "=", ">=", ">"].map((value) => ({ value })) },
          {
            id: "refMode",
            label: "Reference",
            type: "enum",
            default: "initial",
            options: [
              { value: "initial", label: "Initial value" },
              { value: "value", label: "Fixed value" },
            ],
          },
          { id: "refValue", label: "Reference value (scaled)", type: "number", default: 0, visibleWhen: REF_VALUE },
          { id: "scaling", label: "Scaling", type: "number", default: 1.0, visibleWhen: ALGO(["algorithm_gradient_projection"]) },
          { id: "violationScaling", label: "Violation scaling", type: "number", default: 1.0, visibleWhen: ALGO(["algorithm_gradient_projection"]) },
          { id: "bufferFactor", label: "Buffer factor", type: "number", default: 2.0, visibleWhen: ALGO(RGP_ALGORITHMS) },
          { id: "maxWc", label: "Max constraint weight", type: "number", default: 10.0, visibleWhen: ALGO(RGP_ALGORITHMS) },
          { id: "tolerance", label: "Tolerance", type: "number", default: 1e-3, visibleWhen: ALGO(RGP_ALGORITHMS) },
        ],
      },
    ],
  },
];

const RESPONSE_TYPES: Record<string, string> = {
  mass: "mass_response_function",
  strainEnergy: "linear_strain_energy_response_function",
  centroidDeviation: "geometric_centroid_deviation_response_function",
  discreteValueResidual: "discrete_value_residual_response_function",
};

const numList = (v: JsonValue | undefined): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : []);
const strList = (v: JsonValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
const dotted = (root: string, smp: string): string => `${root}.${smp.split("/").join(".")}`;

function responseDocument(e: ResolvedCollectionEntry, root: string): JsonObject {
  const v = e.values;
  const evaluated = e.modelParts.length > 0 ? e.modelParts : [root];
  const settings: JsonObject = { evaluated_model_part_names: evaluated };
  if (e.type === "mass") settings.perturbation_size = asNum(v.perturbationSize, 1e-6);
  if (e.type === "strainEnergy") {
    settings.primal_analysis_name = PRIMAL_ANALYSIS_NAME;
    settings.perturbation_size = asNum(v.perturbationSize, 1e-8);
  }
  if (e.type === "discreteValueResidual") {
    settings.container_type = asStr(v.containerType, "element_properties");
    settings.variable_name = asStr(v.variableName, "THICKNESS");
    settings.residual_type = asStr(v.residualType, "exact");
    settings.list_of_discrete_values = numList(v.discreteValues);
  }
  return { name: e.name, type: RESPONSE_TYPES[e.type], settings };
}

/** The filter block shared by the thickness, shape and SIMP controls. */
export function filterSettings(v: Record<string, JsonValue>, root: string): JsonObject {
  const damping = [asBool(v.dampX, true), asBool(v.dampY, true), asBool(v.dampZ, true)];
  const damped: JsonObject = {};
  for (const p of strList(v.dampedParts)) damped[dotted(root, p)] = damping;
  const radius = asNum(v.filterRadius, 0.2);
  if (asStr(v.filterType, "implicit_filter") === "explicit_filter") {
    return {
      filter_type: "explicit_filter",
      filter_function_type: asStr(v.filterFunction, "linear"),
      filter_radius_settings: { filter_radius_type: "constant", filter_radius: radius },
      filtering_boundary_conditions: {
        damping_type: "nearest_entity",
        damping_function_type: asStr(v.dampingFunction, "cosine"),
        damped_model_part_settings: damped,
      },
    };
  }
  return { filter_type: "implicit_filter", filter_radius: radius, filtering_boundary_conditions: damped };
}

function projectionSettings(v: Record<string, JsonValue>, prefix: string, penalty: number): JsonObject {
  const type = asStr(v[`${prefix}Projection`], "adaptive_sigmoidal_projection");
  if (type === "sigmoidal_projection") {
    return { type, beta_value: asNum(v[`${prefix}Beta`], 5), penalty_factor: asNum(v[`${prefix}Penalty`], penalty) };
  }
  return {
    type: "adaptive_sigmoidal_projection",
    initial_value: asNum(v[`${prefix}Beta`], 5),
    max_value: asNum(v[`${prefix}BetaMax`], 30),
    increase_fac: asNum(v[`${prefix}IncreaseFactor`], 1.05),
    update_period: asNum(v[`${prefix}UpdatePeriod`], 50),
    penalty_factor: asNum(v[`${prefix}Penalty`], penalty),
  };
}

function controlDocument(e: ResolvedCollectionEntry, root: string): JsonObject {
  const v = e.values;
  if (e.type === "material") {
    return {
      name: e.name,
      type: "material.material_properties_control",
      settings: {
        model_part_names: e.modelParts,
        control_variable_name: asStr(v.variable, "YOUNG_MODULUS"),
        consider_recursive_property_update: asBool(v.recursiveUpdate, false),
      },
    };
  }
  if (e.type === "thickness") {
    return {
      name: e.name,
      type: "thickness.shell_thickness_control",
      settings: {
        controlled_model_part_names: e.modelParts,
        filter_settings: filterSettings(v, root),
        output_all_fields: asBool(v.outputAllFields, false),
        physical_thicknesses: numList(v.physicalThicknesses),
        thickness_projection_settings: projectionSettings(v, "thickness", 1),
      },
    };
  }
  if (e.type === "shape") {
    return {
      name: e.name,
      type: "shape.vertex_morphing_shape_control",
      settings: {
        controlled_model_part_names: e.modelParts,
        filter_settings: filterSettings(v, root),
        mesh_motion_solver_type: asStr(v.meshMotion, "none"),
        output_all_fields: asBool(v.outputAllFields, true),
      },
    };
  }
  const densities = numList(v.densities);
  const moduli = numList(v.youngModuli);
  return {
    name: e.name,
    type: "material.simp_control",
    settings: {
      controlled_model_part_names: e.modelParts,
      output_all_fields: asBool(v.outputAllFields, true),
      echo_level: 0,
      consider_recursive_property_update: false,
      density_projection_settings: projectionSettings(v, "density", 1),
      young_modulus_projection_settings: projectionSettings(v, "young", 3),
      filter_settings: filterSettings(v, root),
      list_of_materials: densities.map((density, i) => ({ density, young_modulus: moduli[i] ?? 0 })),
    },
  };
}

function constraintDocument(e: ResolvedCollectionEntry, algorithm: string): JsonObject {
  const v = e.values;
  const ref: JsonValue = asStr(v.refMode, "initial") === "value" ? asNum(v.refValue, 0) : "initial_value";
  const base: JsonObject = { response_expression: asStr(v.response, ""), type: asStr(v.relation, "<="), scaled_ref_value: ref };
  if (RGP_ALGORITHMS.includes(algorithm)) {
    return { ...base, buffer_factor: asNum(v.bufferFactor, 2.0), max_w_c: asNum(v.maxWc, 10.0), tolerance: asNum(v.tolerance, 1e-3) };
  }
  return { ...base, scaling: asNum(v.scaling, 1.0), violation_scaling: asNum(v.violationScaling, 1.0) };
}

function convergenceSettings(v: Record<string, JsonValue>): JsonObject {
  const conv: JsonObject = { max_iter: asNum(v.maxIter, 10) };
  const type = asStr(v.convCriterion, "none");
  const common = { component_name: "algorithm" };
  const settings: Record<string, JsonObject> = {
    l2_conv_criterion: { ...common, field_name: "search_direction:historical", tolerance: asNum(v.convTolerance, 1e-6) },
    avg_abs_improvement_conv_criterion: { ...common, value_name: "std_obj_value", tracked_iter: asNum(v.convTrackedIter, 5), tolerance: asNum(v.convTolerance, 1e-6) },
    target_value_conv_criterion: { ...common, value_name: "std_obj_value", target_value: asNum(v.convTargetValue, 0) },
    magnitude_reduction_conv_criterion: { ...common, value_name: "std_obj_value", target_scaling_factor: asNum(v.convScalingFactor, 1e-3) },
    patience_conv_criterion: {
      ...common,
      value_name: "std_obj_value",
      minimum_itr: asNum(v.convMinimumIter, 100),
      patience_itr: asNum(v.convPatienceIter, 50),
      tolerance: asNum(v.convTolerance, 1e-6),
    },
  };
  if (type !== "none" && settings[type]) {
    conv.type = type;
    conv.settings = settings[type];
  }
  return conv;
}

/** `algorithm_settings`: the algorithm, its line search and convergence, the objective, constraints and controls. */
export function algorithmDocument(v: Record<string, JsonValue>, collections: Record<string, ResolvedCollectionEntry[]>): JsonObject {
  const type = asStr(v.algorithmType, "algorithm_steepest_descent");
  const lsType = asStr(v.lsType, "const_step");
  const lineSearch: JsonObject = { type: lsType, init_step: asNum(v.initStep, 0.01), gradient_scaling: asStr(v.gradientScaling, "inf_norm") };
  if (lsType !== "const_step") lineSearch.max_step = asNum(v.maxStep, 0.1);
  const settings: JsonObject = { echo_level: asNum(v.optimizationEchoLevel, 0), line_search: lineSearch, conv_settings: convergenceSettings(v) };
  if (type === "algorithm_nesterov_accelarated_gradient") settings.eta = asNum(v.eta, 0.9);
  if (type === "algorithm_adam") {
    settings.beta_1 = asNum(v.adamBeta1, 0.9);
    settings.beta_2 = asNum(v.adamBeta2, 0.999);
    settings.epsilon = asNum(v.adamEpsilon, 1e-8);
  }
  if (type === "algorithm_gradient_projection") {
    settings.correction_size = asNum(v.correctionSize, 0);
    settings.linear_solver_settings = { solver_type: "LinearSolversApplication.dense_col_piv_householder_qr" };
  }
  if (RGP_ALGORITHMS.includes(type)) {
    settings.linear_solver_settings = { solver_type: "LinearSolversApplication.dense_col_piv_householder_qr" };
    settings.history_size = asNum(v.historySize, 20);
    settings.max_inner_iter = asNum(v.maxInnerIter, 20);
    settings.buffer_coeff_update_factor = asNum(v.bufferUpdateFactor, 0.1);
    if (type === "algorithm_momentum_relaxed_gradient_projection") settings.eta = asNum(v.eta, 0.9);
  }
  const doc: JsonObject = {
    type,
    settings,
    controls: (collections.controls ?? []).map((c) => c.name),
    objective: {
      response_expression: asStr(v.objectiveResponse, ""),
      type: asStr(v.objectiveType, "minimization"),
      scaling: asNum(v.objectiveScaling, 1.0),
    },
  };
  if (CONSTRAINED_ALGORITHMS.includes(type)) {
    doc.constraints = (collections.constraints ?? []).map((c) => constraintDocument(c, type));
  }
  return doc;
}

/** The whole optimization_parameters.json for one case. */
export function optimizationDocument(ctx: GenContext): JsonObject {
  const v = ctx.values;
  const root = ctx.modelPartName;
  const collections = ctx.collections ?? {};
  const outputs: JsonValue[] = [
    {
      type: "optimization_problem_ascii_output_process",
      module: "KratosMultiphysics.OptimizationApplication.processes",
      settings: {
        output_file_name: asStr(v.summaryFile, "summary.csv"),
        write_kratos_version: true,
        write_time_stamp: true,
      },
    },
  ];
  if (asBool(v.writeDesignFields, true)) {
    outputs.push({
      type: "optimization_problem_vtu_output_process",
      module: "KratosMultiphysics.OptimizationApplication.processes",
      settings: {
        // VtuOutput writes `<prefix>_<step>.vtm`; the "_0" makes that
        // `<model part>_0_<step>.vtm`, the rank_step grammar the timeline groups.
        file_name: "<model_part_full_name>_0",
        file_format: asStr(v.designFieldsFormat, "binary"),
        output_path: DESIGN_FIELDS_FOLDER,
        save_output_files_in_folder: true,
        write_deformed_configuration: false,
        list_of_output_components: ["all"],
        output_interval: 1,
      },
    });
  }
  const nodal = ctx.output?.nodalVariables?.length ? ctx.output.nodalVariables : structural.decl.output.nodalDefaults;
  return {
    problem_data: { parallel_type: "OpenMP", echo_level: asNum(v.optimizationEchoLevel, 0) },
    model_parts: [
      { settings: { model_part_name: root, domain_size: ctx.domainSize, input_filename: ctx.mdpaStem } },
    ],
    analyses: [
      {
        name: PRIMAL_ANALYSIS_NAME,
        type: "kratos_analysis_execution_policy",
        settings: {
          model_part_names: [root],
          analysis_module: "KratosMultiphysics.StructuralMechanicsApplication",
          analysis_type: "StructuralMechanicsAnalysis",
          analysis_settings: { "@include_json": PRIMAL_DOCUMENT },
          analysis_output_settings: { nodal_solution_step_data_variables: [...nodal] },
        },
      },
    ],
    responses: (collections.responses ?? []).map((e) => responseDocument(e, root)),
    controls: (collections.controls ?? []).map((e) => controlDocument(e, root)),
    algorithm_settings: algorithmDocument(v, collections),
    processes: {
      kratos_processes: {
        auxiliary_processes: [
          {
            python_module: OPTIMIZATION_STOP_MODULE,
            process_name: "OptimizationStopProcess",
            Parameters: {},
          },
        ],
      },
      optimization_data_processes: { output_processes: outputs },
    },
  };
}

/** Problems that make the optimization ungeneratable, each naming what to fix. */
export function optimizationProblems(ctx: GenContext): string[] {
  const v = ctx.values;
  const out: string[] = [];
  const collections = ctx.collections ?? {};
  const algorithm = asStr(v.algorithmType, "algorithm_steepest_descent");
  const constraints = collections.constraints ?? [];
  if (!CONSTRAINED_ALGORITHMS.includes(algorithm) && constraints.length > 0) {
    out.push(`The chosen algorithm takes no constraints (${constraints.length} defined): pick a projection algorithm or remove them.`);
  }
  const objective = asStr(v.objectiveResponse, "");
  if (constraints.some((c) => c.values.response === objective)) {
    out.push(`Response "${objective}" is both the objective and a constraint.`);
  }
  if (asStr(v.solverType, "static") !== "static") {
    out.push("The primal analysis must be static: the optimizer evaluates one static solve per iteration.");
  }
  const responses = collections.responses ?? [];
  const usesEnergy = responses.some((r) => r.type === "strainEnergy");
  if (usesEnergy && asStr(v.analysisType, "linear") !== "linear") {
    out.push("Linear strain energy needs a linear primal analysis: set Linearity to Linear.");
  }
  const hasLoad = ctx.assignments.some((a) => {
    const cond = structural.decl.conditions.find((c) => c.id === a.conditionId);
    return cond?.category === "loads" || cond?.list === "loads_process_list";
  });
  if (usesEnergy && !hasLoad) out.push("A strain-energy response needs a loaded primal: assign at least one load.");
  for (const c of collections.controls ?? []) {
    if (c.type === "thickness" && numList(c.values.physicalThicknesses).length !== 2) {
      out.push(`Control "${c.name}": give exactly two physical thicknesses.`);
    }
    if (c.type === "shape" && asStr(c.values.meshMotion, "none") === "filter_based" && asStr(c.values.filterType, "explicit_filter") !== "implicit_filter") {
      out.push(`Control "${c.name}": filter-based mesh motion needs the implicit filter.`);
    }
    if (c.type === "simp") {
      const d = numList(c.values.densities);
      const e = numList(c.values.youngModuli);
      if (d.length < 2 || d.length !== e.length) {
        out.push(`Control "${c.name}": give at least two materials, with as many Young moduli as densities.`);
      } else {
        const pairs = d.map((x, i) => [x, e[i]]).sort((a, b) => a[0] - b[0]);
        if (pairs.some((p, i) => i > 0 && p[1] < pairs[i - 1][1])) {
          out.push(`Control "${c.name}": Young moduli must increase with density (Kratos refuses otherwise).`);
        }
      }
    }
  }
  const controlled = new Map<string, string>();
  for (const c of collections.controls ?? []) {
    for (const p of c.parts) {
      const key = `${c.type === "shape" ? "shape" : c.type === "thickness" ? "thickness" : c.values.variable ?? c.type}:${p}`;
      if (controlled.has(key)) out.push(`Controls "${controlled.get(key)}" and "${c.name}" both change the same quantity on "${p}".`);
      else controlled.set(key, c.name);
    }
  }
  return out;
}

const decl: ProblemtypeDeclaration = {
  ...structural.decl,
  id: "optimization",
  name: "Structural Optimization",
  description: "Gradient-based structural optimization: material, thickness, shape and SIMP topology controls (OptimizationApplication)",
  icon: "ptOptimization",
  family: "optimization",
  primaryDocumentName: OPTIMIZATION_DOCUMENT,
  driverScriptName: "MainKratosOpt.py",
  applications: ["OptimizationApplication"],
  sections: [
    ...structural.decl.sections.map((s) => (s.id === "problem" ? { ...s, label: "Primal analysis" } : s)),
    {
      id: "algorithm",
      label: "Optimization",
      icon: "ptOptimization",
      groups: [
        { id: "objective", label: "Objective", icon: "ptResponse" },
        { id: "algorithm", label: "Algorithm", icon: "ptOptimization" },
        { id: "lineSearch", label: "Line search", icon: "ptSolver" },
        { id: "convergence", label: "Convergence", icon: "ptSolver" },
        { id: "output", label: "Output", icon: "results", collapsed: true },
      ],
      fields: algorithmFields,
    },
  ],
  collections: OPTIMIZATION_COLLECTIONS,
};

export const optimization = defineProblemtype(decl, {
  buildProcess: (cond, a, ctx) => structural.buildProcess(cond, a, ctx),
  // The primary document is replaced whole by postProcess; the primal's own
  // solver settings are built in extraFiles from the Structural hooks.
  solverSettings: () => ({}),
  postProcess: (_pp, ctx) => optimizationDocument(ctx),
  validate: (ctx) => optimizationProblems(ctx),
  mainScript: () => optimizationMainKratosPy(OPTIMIZATION_DOCUMENT),
  extraFiles: async (ctx) => {
    const state = { ...defaultCaseState(structural.decl), assignments: ctx.assignments, output: ctx.output ?? defaultCaseState(structural.decl).output };
    const processes = await buildProcesses(structural, ctx, state, []);
    const primal = await buildSolverDocument(structural, ctx, state, processes);
    const settings = primal.solver_settings as JsonObject;
    // The optimizer imports the mesh (model_parts) and the primal works on it.
    settings.model_import_settings = { input_type: "use_input_model_part" };
    // The optimizer's own VTU output replaces the per-solve vtk output, which
    // every iteration would otherwise overwrite.
    primal.output_processes = {};
    return [
      { name: PRIMAL_DOCUMENT, content: JSON.stringify(primal, null, 4) + "\n" },
      { name: `${OPTIMIZATION_STOP_MODULE}.py`, content: OPTIMIZATION_STOP_PY },
    ];
  },
});
