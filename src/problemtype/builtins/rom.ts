/**
 * Reduced-order model problemtypes (RomApplication's RomManager), one per
 * physics: Structural, Convection-diffusion, Fluid and Potential flow. Each is
 * the physics problemtype unchanged — its forms, conditions, materials and
 * hooks produce the full-order ProjectParameters.json — plus:
 *   - a ROM section: the stages to train and test, the projection, the SVD
 *     truncation, the snapshots and the HROM element selection;
 *   - a Sampling section and a Parameters collection: which values of the case
 *     vary (any numeric section field, condition value or material variable,
 *     picked from the case itself) and over what range;
 *   - RomManagerParameters.json (the manager's general parameters, every key
 *     written explicitly), RomSamples.json (the training and test points, and
 *     where each parameter lands in the documents), and MainKratosROM.py.
 *
 * Where a parameter lands is found by perturbation (rom/parameterPaths.ts), so
 * the driver writes exactly the leaves the generator would have written.
 * Defaults follow rom_manager.py's _SetUpRomManagerParameters at master, read
 * 2026-10-14; the ANN-enhanced decoder (TensorFlow) is not offered, and no
 * case was trained against a solver here.
 */

import { asBool, asNum, asStr, defineProblemtype, dottedModelPart } from "../api";
import { buildMaterials, buildProcesses, buildSolverDocument } from "../generate";
import {
  ROM_MANAGER_PARAMETERS,
  ROM_SAMPLES,
  romMainKratosPy,
} from "../mainKratosTemplate";
import { caseValueFieldType, readContextValue, withContextValue } from "../caseAddress";
import { classifyChanges, diffLeaves, PROBE_A, PROBE_B, type ParameterPath } from "../rom/parameterPaths";
import { sampleParameters, type SamplingMethod } from "../rom/sampling";
import { defaultCaseState } from "../api";
import type {
  CaseState,
  CollectionSpec,
  FieldSpec,
  GenContext,
  JsonObject,
  JsonValue,
  ProblemtypeDeclaration,
  ProblemtypeRuntime,
  ResolvedCollectionEntry,
  VisibleRule,
} from "../types";
import { structural } from "./structural";
import { convectionDiffusion } from "./convectionDiffusion";
import { fluid } from "./fluid";
import { potentialFlow } from "./potentialFlow";

const LSPG: VisibleRule = { field: "romProjection", oneOf: ["lspg", "petrov_galerkin"] };
const HROM_TRAINED: VisibleRule = { field: "romTrainStages", equals: "ROM_HROM" };

const romFields: FieldSpec[] = [
  {
    id: "romTrainStages",
    label: "Train",
    type: "enum",
    default: "ROM_HROM",
    group: "stages",
    options: [
      { value: "ROM", label: "ROM" },
      { value: "ROM_HROM", label: "ROM and HROM" },
    ],
  },
  {
    id: "romTestStages",
    label: "Test",
    type: "enum",
    default: "none",
    group: "stages",
    options: [
      { value: "none", label: "No test run" },
      { value: "ROM", label: "ROM" },
      { value: "ROM_HROM", label: "ROM and HROM" },
    ],
    help: "Test runs compare the reduced models with full-order solves at the test samples.",
  },
  {
    id: "romProjection",
    label: "Projection",
    type: "enum",
    default: "galerkin",
    group: "projection",
    options: [
      { value: "galerkin", label: "Galerkin" },
      { value: "lspg", label: "Least-squares Petrov–Galerkin (LSPG)" },
      { value: "petrov_galerkin", label: "Petrov–Galerkin" },
    ],
  },
  {
    id: "romAssembling",
    label: "Assembling",
    type: "enum",
    default: "global",
    group: "projection",
    options: [
      { value: "global", label: "Global" },
      { value: "elemental", label: "Elemental" },
    ],
  },
  { id: "romSvdTolerance", label: "SVD truncation tolerance", type: "number", default: 1e-5, min: 0, group: "basis", help: "Smaller keeps more modes." },
  {
    id: "romNodalUnknowns",
    label: "Nodal unknowns",
    type: "stringList",
    default: [],
    group: "basis",
    help: "The variables the snapshots are taken from. Empty: the physics' primary unknowns for the domain size.",
  },
  {
    id: "romSnapshotsControl",
    label: "Snapshots every",
    type: "enum",
    default: "step",
    group: "basis",
    options: [
      { value: "step", label: "Step" },
      { value: "time", label: "Time" },
    ],
  },
  { id: "romSnapshotsInterval", label: "Snapshot interval", type: "number", default: 1, min: 0, group: "basis" },
  { id: "romPrintSingularValues", label: "Write singular values", type: "bool", default: true, group: "basis" },
  { id: "romMonotonicity", label: "Monotonicity preserving", type: "bool", default: false, group: "basis", advanced: true },
  { id: "lspgTrainPetrovGalerkin", label: "Train Petrov–Galerkin basis", type: "bool", default: false, group: "lspg", visibleWhen: LSPG },
  {
    id: "lspgBasisStrategy",
    label: "Basis strategy",
    type: "enum",
    default: "residuals",
    group: "lspg",
    visibleWhen: LSPG,
    options: [{ value: "residuals" }, { value: "jacobian" }, { value: "reactions" }],
  },
  { id: "lspgIncludePhi", label: "Include Φ", type: "bool", default: false, group: "lspg", visibleWhen: LSPG },
  { id: "lspgSvdTolerance", label: "SVD truncation tolerance", type: "number", default: 1e-12, min: 0, group: "lspg", visibleWhen: LSPG },
  {
    id: "lspgSolvingTechnique",
    label: "Solving technique",
    type: "enum",
    default: "normal_equations",
    group: "lspg",
    visibleWhen: LSPG,
    options: [{ value: "normal_equations" }, { value: "qr_decomposition" }],
  },
  { id: "hromSelectionTolerance", label: "Element selection tolerance", type: "number", default: 1e-6, min: 0, group: "hrom", visibleWhen: HROM_TRAINED },
  { id: "hromConstraintSumWeights", label: "Constrain sum of weights", type: "bool", default: true, group: "hrom", visibleWhen: HROM_TRAINED },
  { id: "hromVisualization", label: "Write HROM visualization model part", type: "bool", default: true, group: "hrom", visibleWhen: HROM_TRAINED },
  { id: "hromIncludeElements", label: "Always include elements of", type: "smpList", group: "hrom", visibleWhen: HROM_TRAINED },
  { id: "hromIncludeConditions", label: "Always include conditions of", type: "smpList", group: "hrom", visibleWhen: HROM_TRAINED },
  { id: "hromMinimumCondition", label: "Keep one condition per part", type: "bool", default: false, group: "hrom", visibleWhen: HROM_TRAINED },
  { id: "hromConditionParents", label: "Include condition parents", type: "bool", default: false, group: "hrom", visibleWhen: HROM_TRAINED },
  { id: "romSaveVtk", label: "Write VTK output per run", type: "bool", default: true, group: "output", help: "Under Results/vtk_output_<stage><sample>; needs the case's VTK output." },
];

const samplingFields: FieldSpec[] = [
  {
    id: "sampleMethod",
    label: "Method",
    type: "enum",
    default: "lhs",
    options: [
      { value: "lhs", label: "Latin hypercube" },
      { value: "halton", label: "Halton sequence" },
      { value: "random", label: "Uniform random" },
      { value: "grid", label: "Full grid" },
    ],
  },
  { id: "sampleTrain", label: "Training samples", type: "int", default: 6, min: 1, visibleWhen: { field: "sampleMethod", oneOf: ["lhs", "halton", "random"] } },
  { id: "sampleTest", label: "Test samples", type: "int", default: 3, min: 0 },
  { id: "sampleSeed", label: "Seed", type: "int", default: 1, help: "The same seed always gives the same points." },
];

export const ROM_PARAMETERS: CollectionSpec = {
  id: "parameters",
  label: "Parameters",
  icon: "ptRom",
  min: 1,
  help: "Values of the case the reduced model is trained over. Pick any numeric condition value, material variable or setting.",
  entryTypes: [
    {
      id: "range",
      label: "Range",
      icon: "ptRom",
      fields: [
        { id: "target", label: "Varies", type: "caseValue" },
        { id: "min", label: "Minimum", type: "number", default: 0 },
        { id: "max", label: "Maximum", type: "number", default: 1 },
        { id: "gridPoints", label: "Grid points", type: "int", default: 3, min: 1, visibleWhen: { field: "sampleMethod", equals: "grid" } },
      ],
    },
  ],
};

export interface RomOptions {
  id: string;
  name: string;
  /** The physics' primary unknowns — what the snapshots hold by default. */
  unknowns: (domainSize: 2 | 3) => string[];
}

interface LocatedParameter {
  entry: ResolvedCollectionEntry;
  paths: ParameterPath[];
  integer: boolean;
  current: number;
}

/** The full-order documents for a context, built by the physics' own hooks. */
async function documentsFor(base: ProblemtypeRuntime, ctx: GenContext): Promise<{ parameters: JsonObject; materials: JsonObject }> {
  const state: CaseState = {
    ...defaultCaseState(base.decl),
    assignments: ctx.assignments,
    materials: ctx.materials,
    output: ctx.output ?? defaultCaseState(base.decl).output,
  };
  const processes = await buildProcesses(base, ctx, state, []);
  const parameters = await buildSolverDocument(base, ctx, state, processes);
  const materials = buildMaterials(ctx, state, base, []);
  return { parameters, materials };
}

/** Locates every parameter by perturbation; problems name the parameter and what is wrong. */
export async function locateParameters(
  base: ProblemtypeRuntime,
  decl: ProblemtypeDeclaration,
  ctx: GenContext
): Promise<{ located: LocatedParameter[]; problems: string[] }> {
  const located: LocatedParameter[] = [];
  const problems: string[] = [];
  for (const entry of ctx.collections?.parameters ?? []) {
    const address = typeof entry.values.target === "string" ? entry.values.target : "";
    const current = readContextValue(decl, ctx, address);
    if (current === undefined) {
      problems.push(`Parameter "${entry.name}": choose a numeric value of the case for it to vary${address ? ` ("${address}" is not in this case)` : ""}.`);
      continue;
    }
    const lo = asNum(entry.values.min, 0);
    const hi = asNum(entry.values.max, 1);
    if (!(lo < hi)) {
      problems.push(`Parameter "${entry.name}": the minimum must be below the maximum.`);
      continue;
    }
    const a = withContextValue(decl, ctx, address, PROBE_A);
    const b = withContextValue(decl, ctx, address, PROBE_B);
    if (!a || !b) {
      problems.push(`Parameter "${entry.name}": "${address}" cannot be varied.`);
      continue;
    }
    let docsA: { parameters: JsonObject; materials: JsonObject };
    let docsB: { parameters: JsonObject; materials: JsonObject };
    try {
      docsA = await documentsFor(base, a);
      docsB = await documentsFor(base, b);
    } catch (err) {
      problems.push(`Parameter "${entry.name}": the case cannot be generated at the probe values (${err instanceof Error ? err.message.split("\n")[0] : String(err)}).`);
      continue;
    }
    const fromParameters = classifyChanges("parameters", diffLeaves(docsA.parameters, docsB.parameters));
    const fromMaterials = classifyChanges("materials", diffLeaves(docsA.materials, docsB.materials));
    const paths = [...fromParameters.paths, ...fromMaterials.paths];
    const reasons = [...fromParameters.problems, ...fromMaterials.problems];
    if (reasons.length > 0) {
      problems.push(`Parameter "${entry.name}": ${reasons[0]}`);
      continue;
    }
    if (paths.length === 0) {
      problems.push(`Parameter "${entry.name}": changing this value changes nothing the solver reads, so it cannot be a ROM parameter.`);
      continue;
    }
    located.push({ entry, paths, integer: caseValueFieldType(decl, address) === "int", current });
  }
  const seen = new Map<string, string>();
  for (const p of located) {
    const address = String(p.entry.values.target);
    if (seen.has(address)) problems.push(`Parameters "${seen.get(address)}" and "${p.entry.name}" vary the same value.`);
    else seen.set(address, p.entry.name);
  }
  return { located, problems };
}

const stages = (v: JsonValue | undefined, dflt: string): string[] => {
  const s = asStr(v, dflt);
  return s === "ROM_HROM" ? ["ROM", "HROM"] : s === "ROM" ? ["ROM"] : [];
};
const smpList = (v: JsonValue | undefined, root: string): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).map((p) => dottedModelPart(root, p)) : [];

/** RomManagerParameters.json: every key the manager validates, written explicitly from the form. */
export function romManagerParameters(v: Record<string, JsonValue>, ctx: GenContext, opts: RomOptions): JsonObject {
  const typed = Array.isArray(v.romNodalUnknowns) ? v.romNodalUnknowns.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  const unknowns = typed.length > 0 ? typed : opts.unknowns(ctx.domainSize);
  const monotonicity = asBool(v.romMonotonicity, false);
  const root = ctx.modelPartName;
  return {
    rom_stages_to_train: stages(v.romTrainStages, "ROM_HROM"),
    rom_stages_to_test: stages(v.romTestStages, "none"),
    paralellism: null,
    projection_strategy: asStr(v.romProjection, "galerkin"),
    type_of_decoder: "linear",
    assembling_strategy: asStr(v.romAssembling, "global"),
    // The generated document's gid_output list is empty, and the manager
    // indexes its first entry when GiD output is on.
    save_gid_output: false,
    save_vtk_output: asBool(v.romSaveVtk, true),
    output_name: "id",
    store_nonconverged_fom_solutions: false,
    coupled_solvers: [],
    ROM: {
      svd_truncation_tolerance: asNum(v.romSvdTolerance, 1e-5),
      model_part_name: root,
      nodal_unknowns: unknowns,
      rom_basis_output_format: "numpy",
      rom_basis_output_name: "RomParameters",
      rom_basis_output_folder: "rom_data",
      snapshots_control_type: asStr(v.romSnapshotsControl, "step"),
      snapshots_interval: asNum(v.romSnapshotsInterval, 1),
      print_singular_values: asBool(v.romPrintSingularValues, true),
      use_non_converged_sols: false,
      galerkin_rom_bns_settings: { monotonicity_preserving: monotonicity },
      lspg_rom_bns_settings: {
        train_petrov_galerkin: asBool(v.lspgTrainPetrovGalerkin, false),
        basis_strategy: asStr(v.lspgBasisStrategy, "residuals"),
        include_phi: asBool(v.lspgIncludePhi, false),
        svd_truncation_tolerance: asNum(v.lspgSvdTolerance, 1e-12),
        solving_technique: asStr(v.lspgSolvingTechnique, "normal_equations"),
        monotonicity_preserving: monotonicity,
      },
      petrov_galerkin_rom_bns_settings: { monotonicity_preserving: monotonicity },
    },
    HROM: {
      hrom_format: "numpy",
      element_selection_type: "empirical_cubature",
      element_selection_svd_truncation_tolerance: asNum(v.hromSelectionTolerance, 1e-6),
      constraint_sum_weights: asBool(v.hromConstraintSumWeights, true),
      svd_type: "numpy_rsvd",
      create_hrom_visualization_model_part: asBool(v.hromVisualization, true),
      include_elements_model_parts_list: smpList(v.hromIncludeElements, root),
      include_conditions_model_parts_list: smpList(v.hromIncludeConditions, root),
      initial_candidate_elements_model_part_list: [],
      initial_candidate_conditions_model_part_list: [],
      include_nodal_neighbouring_elements_model_parts_list: [],
      include_minimum_condition: asBool(v.hromMinimumCondition, false),
      include_condition_parents: asBool(v.hromConditionParents, false),
      echo_level: 0,
    },
  };
}

/** RomSamples.json: the parameters (with where they land) and the training and test points. */
export function romSamples(v: Record<string, JsonValue>, located: LocatedParameter[]): JsonObject {
  const ranges = located.map((p) => ({ min: asNum(p.entry.values.min, 0), max: asNum(p.entry.values.max, 1), gridPoints: asNum(p.entry.values.gridPoints, 3) }));
  const sets = sampleParameters(
    ranges,
    asStr(v.sampleMethod, "lhs") as SamplingMethod,
    asNum(v.sampleTrain, 6),
    asNum(v.sampleTest, 3),
    asNum(v.sampleSeed, 1)
  );
  const round = (rows: number[][]): number[][] => rows.map((row) => row.map((x, d) => (located[d].integer ? Math.round(x) : x)));
  return {
    version: 1,
    method: asStr(v.sampleMethod, "lhs"),
    seed: asNum(v.sampleSeed, 1),
    mu_names: located.map((p) => p.entry.name),
    parameters: located.map((p, d) => ({
      name: p.entry.name,
      address: String(p.entry.values.target),
      min: ranges[d].min,
      max: ranges[d].max,
      current: p.current,
      ...(p.integer ? { integer: true } : {}),
      paths: p.paths.map((path) => ({ ...path }) as unknown as JsonValue),
    })),
    mu_train: round(sets.train),
    mu_test: round(sets.test),
  };
}

/** Builds a ROM problemtype around a physics problemtype. */
export function romProblemtype(base: ProblemtypeRuntime, opts: RomOptions): ProblemtypeRuntime {
  const decl: ProblemtypeDeclaration = {
    ...base.decl,
    id: opts.id,
    name: opts.name,
    description: `Reduced-order model (POD-Galerkin ROM and HROM) of ${base.decl.name}, trained over sampled case values (RomApplication)`,
    icon: "ptRom",
    family: "reduced",
    driverScriptName: "MainKratosROM.py",
    sections: [
      ...base.decl.sections,
      {
        id: "rom",
        label: "Reduced-order model",
        icon: "ptRom",
        groups: [
          { id: "stages", label: "Stages", icon: "ptRom" },
          { id: "projection", label: "Projection", icon: "ptSolver" },
          { id: "basis", label: "Basis (POD)", icon: "ptSolver" },
          { id: "lspg", label: "Petrov–Galerkin basis", icon: "ptSolver", collapsed: true },
          { id: "hrom", label: "Hyper-reduction (HROM)", icon: "ptSolver" },
          { id: "output", label: "Output", icon: "results", collapsed: true },
        ],
        fields: romFields,
      },
      { id: "sampling", label: "Sampling", icon: "ptRom", fields: samplingFields },
    ],
    collections: [...(base.decl.collections ?? []), ROM_PARAMETERS],
  };
  return defineProblemtype(decl, {
    buildProcess: (cond, a, ctx) => base.buildProcess(cond, a, ctx),
    solverSettings: (v, ctx) => base.solverSettings(v, ctx),
    postProcess: (pp, ctx) => base.postProcess(pp, ctx),
    mainScript: () => romMainKratosPy(),
    validate: async (ctx) => {
      const problems = [...(await base.validate(ctx))];
      problems.push(...(await locateParameters(base, decl, ctx)).problems);
      const v = ctx.values;
      if (asStr(v.sampleMethod, "lhs") !== "grid" && asNum(v.sampleTrain, 6) < 1) problems.push("Sampling: at least one training sample is needed.");
      if (asStr(v.romTestStages, "none") !== "none" && asNum(v.sampleTest, 3) < 1) problems.push("Sampling: a test stage is selected but there are no test samples.");
      if (asStr(v.romTestStages, "none") === "ROM_HROM" && asStr(v.romTrainStages, "ROM_HROM") === "ROM") {
        problems.push("ROM: testing the HROM needs it trained; train ROM and HROM.");
      }
      return problems;
    },
    extraFiles: async (ctx, materials) => {
      const { located, problems } = await locateParameters(base, decl, ctx);
      if (problems.length > 0) throw new Error(problems.join("\n"));
      return [
        ...(await base.extraFiles(ctx, materials)),
        { name: ROM_MANAGER_PARAMETERS, content: JSON.stringify(romManagerParameters(ctx.values, ctx, opts), null, 4) + "\n" },
        { name: ROM_SAMPLES, content: JSON.stringify(romSamples(ctx.values, located), null, 2) + "\n" },
      ];
    },
  });
}

const xyz = (variable: string, dim: 2 | 3): string[] => (dim === 3 ? ["X", "Y", "Z"] : ["X", "Y"]).map((c) => `${variable}_${c}`);

export const romStructural = romProblemtype(structural, {
  id: "romStructural",
  name: "ROM · Structural Mechanics",
  unknowns: (dim) => xyz("DISPLACEMENT", dim),
});
export const romThermal = romProblemtype(convectionDiffusion, {
  id: "romThermal",
  name: "ROM · Convection-diffusion",
  unknowns: () => ["TEMPERATURE"],
});
export const romFluid = romProblemtype(fluid, {
  id: "romFluid",
  name: "ROM · Fluid Dynamics",
  unknowns: (dim) => [...xyz("VELOCITY", dim), "PRESSURE"],
});
export const romPotentialFlow = romProblemtype(potentialFlow, {
  id: "romPotentialFlow",
  name: "ROM · Potential Flow",
  unknowns: () => ["VELOCITY_POTENTIAL", "AUXILIARY_VELOCITY_POTENTIAL"],
});

export const ROM_PROBLEMTYPES = [romStructural, romThermal, romFluid, romPotentialFlow];
