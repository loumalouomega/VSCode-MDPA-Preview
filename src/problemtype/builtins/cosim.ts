/**
 * Built-in generic CoSimulation problemtype (roadmap item 16, second increment): a
 * partitioned weak coupling of the fluid and structural solvers across one
 * interface pair, driven by CoSimulationApplication's gauss_seidel_weak coupled
 * solver. One case writes three kinds of file:
 *   - ProjectParametersCoSim.json: the coupling settings (the coupling sequence,
 *     one solver wrapper per participant with its input file and interface data,
 *     one kratos_mapping operator and one average-value predictor);
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
 * Scope of this increment: weak (single-pass) coupling, one interface pair, no ALE
 * mesh motion and no strong-coupling iterations. The data names the coupled solver
 * exchanges (REACTION, POINT_LOAD, DISPLACEMENT), the mapper and the predictor are
 * the defaults for a fluid-structure pairing. They follow the keys CoSimulation-
 * Application reads at master, and are not checked against a solver run here.
 * The structure's displacement is sent back to the fluid interface, which only a
 * fluid that moves its own mesh can take; for a fixed fluid mesh, remove that
 * exchange from ProjectParametersCoSim.json by hand.
 */

import { asNum, defaultCaseState, defineProblemtype } from "../api";
import { buildProcesses, buildSolverDocument } from "../generate";
import { cosimMainKratosPy } from "../mainKratosTemplate";
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
import { structural } from "./structural";
import { prefixFields, unprefixValues } from "./common";

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
const PREDICTOR = "average_value_based";
const FLUID_LOAD_VARIABLE = "REACTION";
const FLUID_DISPLACEMENT_VARIABLE = "DISPLACEMENT";
const STRUCTURE_LOAD_VARIABLE = "POINT_LOAD";
const STRUCTURE_DISPLACEMENT_VARIABLE = "DISPLACEMENT";

/** The Fluid problemtype's field the structure also reads: shared start/end time live at top level. */
const FLUID_SECTION = fluid.decl.sections[0];
const STRUCT_SECTION = structural.decl.sections[0];
const FLUID_OMIT = ["startTime", "endTime"];
const STRUCT_OMIT = ["startTime", "timeStep", "endTime"];

const fluidFields = prefixFields(FLUID_SECTION.fields.filter((f) => !FLUID_OMIT.includes(f.id)), F);
const structFields = prefixFields(STRUCT_SECTION.fields.filter((f) => !STRUCT_OMIT.includes(f.id) && f.group !== "time"), S);
const regroup = (groups: FieldGroupSpec[] | undefined, prefix: string, owner: string, omit: string[]): FieldGroupSpec[] =>
  (groups ?? []).filter((g) => !omit.includes(g.id)).map((g) => ({ ...g, id: prefix + g.id, label: `${owner} · ${g.label}` }));

const couplingFields: FieldSpec[] = [
  { id: "startTime", label: "Start time", type: "number", default: 0, group: "time", unit: "s" },
  { id: "endTime", label: "End time", type: "number", default: 1.0, group: "time", unit: "s" },
  {
    id: "predictorBeta",
    label: "Predictor weight β",
    type: "number",
    default: 0.5,
    min: 0,
    max: 1,
    group: "coupling",
    help: "Weight of the predicted interface value when a step ends (the average-value predictor).",
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

const decl: ProblemtypeDeclaration = {
  ...fluid.decl,
  id: "cosim",
  name: "Generic Coupling (CoSimulation)",
  description: "Partitioned weak coupling of the fluid and structural solvers through CoSimulationApplication (gauss_seidel_weak)",
  icon: "ptCoupling",
  family: "coupled",
  analysisStage: "KratosMultiphysics.CoSimulationApplication.co_simulation_analysis",
  modelPartName: "FluidModelPart",
  materialsFileName: "FluidMaterials.json",
  primaryDocumentName: PRIMARY_DOCUMENT,
  driverScriptName: "MainKratosCoSim.py",
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
      conditionIds: [...fluidConditions.map((c) => c.id), "fluidInterface"],
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
      meshNaming: { elements: "$field:s_elementBase", conditions: { 2: "LineLoadCondition", 3: "SurfaceLoadCondition" } },
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
  conditions: [...fluidConditions, fluidInterface, ...structConditions, structureInterface],
  materialLaws: [
    ...fluid.decl.materialLaws.map((l) => ({ ...l, domain: "fluid" })),
    ...structural.decl.materialLaws.map((l) => ({ ...l, domain: "structure" })),
  ],
  output: fluid.decl.output,
};

const own = (cond: ConditionSpec, prefix: string, base: ConditionSpec[]): ConditionSpec =>
  base.find((c) => c.id === cond.id.slice(prefix.length)) ?? cond;
const stripPrefix = (a: Assignment, prefix: string): Assignment => ({ ...a, conditionId: a.conditionId.slice(prefix.length) });
const dotted = (smp: string): string => smp.split("/").join(".");

/** The SubModelPaths assigned as each side of the interface (validated to one pair before any document is built). */
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

/** The coupled solver's settings: the sequence, the wrappers, the interface data, one mapper and one predictor. */
function couplingSettings(ctx: GenContext, v: Record<string, JsonValue>): JsonObject {
  const { fluid: fl, structure: st } = interfaces(ctx);
  const fluidNode = `${ctx.domains!.fluid.modelPartName}.${dotted(fl[0])}`;
  const structureNode = `${ctx.domains!.structure.modelPartName}.${dotted(st[0])}`;
  const dim = ctx.domainSize;
  return {
    type: "coupled_solvers.gauss_seidel_weak",
    coupling_sequence: [
      {
        name: "fluid",
        input_data_list: [
          { data: "fluid_interface_displacement", from_solver: "structure", from_solver_data: "structure_interface_displacement", data_transfer_operator: MAPPER },
        ],
        output_data_list: [
          { data: "fluid_interface_load", to_solver: "structure", to_solver_data: "structure_interface_load", data_transfer_operator: MAPPER },
        ],
      },
      {
        name: "structure",
        input_data_list: [
          { data: "structure_interface_load", from_solver: "fluid", from_solver_data: "fluid_interface_load", data_transfer_operator: MAPPER },
        ],
        output_data_list: [
          { data: "structure_interface_displacement", to_solver: "fluid", to_solver_data: "fluid_interface_displacement", data_transfer_operator: MAPPER },
        ],
      },
    ],
    solvers: {
      fluid: {
        type: "solver_wrappers.kratos.fluid_dynamics_wrapper",
        solver_wrapper_settings: { input_file: CFD_DOCUMENT },
        data: {
          fluid_interface_load: { model_part_name: fluidNode, variable_name: FLUID_LOAD_VARIABLE, dimension: dim },
          fluid_interface_displacement: { model_part_name: fluidNode, variable_name: FLUID_DISPLACEMENT_VARIABLE, dimension: dim },
        },
      },
      structure: {
        type: "solver_wrappers.kratos.structural_mechanics_wrapper",
        solver_wrapper_settings: { input_file: CSM_DOCUMENT },
        data: {
          structure_interface_load: { model_part_name: structureNode, variable_name: STRUCTURE_LOAD_VARIABLE, dimension: dim },
          structure_interface_displacement: { model_part_name: structureNode, variable_name: STRUCTURE_DISPLACEMENT_VARIABLE, dimension: dim },
        },
      },
    },
    predictors: [{ type: PREDICTOR, beta: asNum(v.predictorBeta, 0.5) }],
    data_transfer_operators: { [MAPPER]: { type: MAPPER, mapper_settings: { mapper_type: "nearest_element" } } },
  };
}

export const cosim = defineProblemtype(decl, {
  validate: (ctx) => {
    const problems: string[] = [];
    const { fluid: fl, structure: st } = interfaces(ctx);
    if (fl.length > 1 || st.length > 1) {
      problems.push(
        `This problemtype couples one interface pair: assign exactly one SubModelPart as the fluid interface and one as the structure interface (${fl.length} fluid, ${st.length} structure).`
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
  mainScript: () => cosimMainKratosPy(PRIMARY_DOCUMENT),
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
      ctx.output?.nodalVariables ?? fluid.decl.output.nodalDefaults
    );
    const fluidSettings = fluidDocument.solver_settings as JsonObject;
    // The interface is a skin of the fluid solver, although it is not one of its processes.
    fluidSettings.skin_parts = [
      ...((fluidSettings.skin_parts as JsonValue[] | undefined) ?? []),
      `${domains.fluid.modelPartName}.${dotted(fl[0])}`,
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
    return [
      { name: CFD_DOCUMENT, content: JSON.stringify(fluidDocument, null, 4) + "\n" },
      { name: CSM_DOCUMENT, content: JSON.stringify(structureDocument, null, 4) + "\n" },
    ];
  },
});
