/**
 * Built-in Fluid-Structure Interaction problemtype: a partitioned Dirichlet-
 * Neumann coupling of the incompressible fluid solver and structural mechanics
 * over an ALE mesh (FSIApplication). Mirrors GiDInterface's FSI app
 * (apps/FSI/write/writeProjectParameters.tcl): `fsi_analysis` with nested
 * `fluid_solver_settings`, `structure_solver_settings` and `mesh_solver_settings`,
 * `coupling_settings` (relaxation or multi-vector quasi-Newton acceleration,
 * mapper settings and the two interface lists), per-physics process lists, and
 * one mesh plus one materials file per physics.
 *
 * Composed from the Fluid and Structural Mechanics built-ins, not copied: the
 * fluid fields and conditions are those problemtype's with a `f_` prefix, the
 * structural ones with `s_`, and the nested solver settings come from THEIR
 * hooks, so a fix there reaches this one. The structure takes the fluid's time
 * stepping, as GiD does.
 *
 * One source mesh is sliced into `<stem>_Fluid.mdpa` and `<stem>_Structural.mdpa`
 * by the SubModelParts assigned in each domain. The interface is marked by one
 * fluid and one structure SubModelPart (paired in the order assigned); Generate
 * refuses a case missing either, or with unequal counts.
 *
 * Not solver-verified in this repository: the shape follows GiDInterface's writer.
 */

import { defineProblemtype, asNum, asStr } from "../api";
import type {
  Assignment,
  ConditionSpec,
  FieldGroupSpec,
  FieldSpec,
  GenContext,
  JsonObject,
  JsonValue,
  ProblemtypeDeclaration,
} from "../types";
import { fluid } from "./fluid";
import { structural } from "./structural";
import { prefixFields, unprefixValues, vectorConstraint } from "./common";

const F = "f_";
const S = "s_";
const FLUID_PARTS = `${F}parts`;
const STRUCT_PARTS = `${S}parts`;

/** The Fluid problemtype's field the structure also reads: shared start/end time live at top level. */
const FLUID_SECTION = fluid.decl.sections[0];
const STRUCT_SECTION = structural.decl.sections[0];
const FLUID_OMIT = ["startTime", "endTime"];
const STRUCT_OMIT = ["startTime", "timeStep", "endTime"];

const fluidFields = prefixFields(FLUID_SECTION.fields.filter((f) => !FLUID_OMIT.includes(f.id)), F);
const structFields = prefixFields(STRUCT_SECTION.fields.filter((f) => !STRUCT_OMIT.includes(f.id) && f.group !== "time"), S);
const regroup = (groups: FieldGroupSpec[] | undefined, prefix: string, owner: string, omit: string[]): FieldGroupSpec[] =>
  (groups ?? []).filter((g) => !omit.includes(g.id)).map((g) => ({ ...g, id: prefix + g.id, label: `${owner} · ${g.label}` }));

const COUPLING_METHOD = { field: "couplingStrategy" };
const couplingFields: FieldSpec[] = [
  { id: "startTime", label: "Start time", type: "number", default: 0, group: "time", unit: "s" },
  { id: "endTime", label: "End time", type: "number", default: 1.0, group: "time", unit: "s" },
  {
    id: "couplingScheme",
    label: "Coupling scheme",
    type: "enum",
    default: "DirichletNeumann",
    group: "coupling",
    options: [{ value: "DirichletNeumann", label: "Dirichlet-Neumann" }],
  },
  { id: "nlTol", label: "Coupling tolerance", type: "number", default: 1e-7, min: 0, group: "coupling" },
  { id: "nlMaxIt", label: "Max. coupling iterations", type: "int", default: 25, min: 1, group: "coupling" },
  { id: "solveMeshAtEachIteration", label: "Solve the mesh at each iteration", type: "bool", default: true, group: "coupling" },
  {
    id: "couplingStrategy",
    label: "Convergence acceleration",
    type: "enum",
    default: "Relaxation",
    group: "acceleration",
    options: [
      { value: "Relaxation", label: "Relaxation" },
      { value: "MVQN", label: "Multi-vector quasi-Newton" },
      { value: "MVQN_recursive", label: "Recursive multi-vector quasi-Newton" },
    ],
  },
  {
    id: "accelerationType",
    label: "Relaxation type",
    type: "enum",
    default: "Aitken",
    group: "acceleration",
    visibleWhen: { ...COUPLING_METHOD, equals: "Relaxation" },
    options: [{ value: "Aitken" }, { value: "constant" }],
  },
  { id: "w0", label: "Initial relaxation w₀", type: "number", default: 0.825, min: 0, max: 1, group: "acceleration" },
  {
    id: "bufferSize",
    label: "Buffer size",
    type: "int",
    default: 7,
    min: 1,
    group: "acceleration",
    visibleWhen: { ...COUPLING_METHOD, equals: "MVQN_recursive" },
  },
  {
    id: "meshSolver",
    label: "ALE mesh solver",
    type: "enum",
    default: "structural_similarity",
    group: "ale",
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

const aleBC: ConditionSpec = vectorConstraint("MESH_DISPLACEMENT", {
  id: "aleMeshBC",
  label: "ALE mesh displacement",
  list: "fluid_boundary_conditions_process_list",
  unit: "m",
  icon: "ptConstraint",
  help: "Fixes the mesh motion on a fluid boundary that does not move with the structure.",
});
const fluidInterface: ConditionSpec = {
  id: "fluidInterface",
  label: "FSI fluid interface",
  list: "list_other_processes",
  target: "surface",
  category: "constraints",
  icon: "ptCoupling",
  noProcess: true,
  help: "The fluid boundary that exchanges forces and displacements with the structure (a no-slip wall).",
  fields: [
    {
      id: "mapperFace",
      label: "Mapper face",
      type: "enum",
      default: "unique",
      options: [{ value: "unique", label: "Unique" }, { value: "positive", label: "Positive" }, { value: "negative", label: "Negative" }],
    },
  ],
  processTemplate: {},
};
const structureInterface: ConditionSpec = {
  id: "structureInterface",
  label: "FSI structure interface",
  list: "list_other_processes",
  target: "surface",
  category: "constraints",
  icon: "ptCoupling",
  noProcess: true,
  help: "The structure boundary that exchanges forces and displacements with the fluid.",
  fields: [],
  processTemplate: {},
};

const decl: ProblemtypeDeclaration = {
  ...fluid.decl,
  id: "fsi",
  name: "Fluid-Structure Interaction",
  description: "Partitioned Dirichlet-Neumann coupling of the fluid and structural solvers over an ALE mesh (FSIApplication)",
  icon: "ptFsi",
  family: "coupled",
  analysisStage: "KratosMultiphysics.FSIApplication.fsi_analysis",
  modelPartName: "FluidModelPart",
  materialsFileName: "FluidMaterials.json",
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
      required: [{ conditionId: "fluidInterface", message: 'mark the fluid side of the interface: assign at least one SubModelPart as "FSI fluid interface".' }],
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
      required: [{ conditionId: "structureInterface", message: 'mark the structure side of the interface: assign at least one SubModelPart as "FSI structure interface".' }],
      meshNaming: { elements: "$field:s_elementBase", conditions: { 2: "LineLoadCondition", 3: "SurfaceLoadCondition" } },
    },
  ],
  sections: [
    {
      id: "problem",
      label: "Coupling",
      icon: "ptCoupling",
      groups: [
        { id: "time", label: "Time", icon: "ptTime" },
        { id: "coupling", label: "Partitioned coupling", icon: "ptCoupling" },
        { id: "acceleration", label: "Convergence acceleration", icon: "ptSolver" },
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
  conditions: [...fluidConditions, aleBC, { ...fluidInterface }, ...structConditions, structureInterface],
  materialLaws: [
    ...fluid.decl.materialLaws.map((l) => ({ ...l, domain: "fluid" })),
    ...structural.decl.materialLaws.map((l) => ({ ...l, domain: "structure" })),
  ],
  output: { nodalDefaults: ["VELOCITY", "PRESSURE", "MESH_DISPLACEMENT"] },
};

const own = (cond: ConditionSpec, prefix: string, base: ConditionSpec[]): ConditionSpec =>
  base.find((c) => c.id === cond.id.slice(prefix.length)) ?? cond;
const stripPrefix = (a: Assignment, prefix: string): Assignment => ({ ...a, conditionId: a.conditionId.slice(prefix.length) });

/** Conditions whose SubModelPart is not a boundary skin of the fluid solver (GiD's SkinConditions = False). */
const FLUID_NO_SKIN = new Set(["velocityConstraints", "pressureConstraints", "aleMeshBC"]);

function interfaces(ctx: GenContext): { fluid: string[]; structure: string[] } {
  const fluidSide = (ctx.domains?.fluid.assignments ?? []).filter((a) => a.conditionId === "fluidInterface");
  const structureSide = (ctx.domains?.structure.assignments ?? []).filter((a) => a.conditionId === "structureInterface");
  return { fluid: fluidSide.map((a) => a.smpPath), structure: structureSide.map((a) => a.smpPath) };
}

export const fsi = defineProblemtype(decl, {
  validate: (ctx) => {
    const { fluid: fl, structure: st } = interfaces(ctx);
    if (fl.length > 0 && st.length > 0 && fl.length !== st.length) {
      return [
        `The interface needs one structure SubModelPart per fluid SubModelPart (they are paired in the order assigned): ` +
          `${fl.length} fluid vs ${st.length} structure.`,
      ];
    }
    return [];
  },
  buildProcess: (cond, a, ctx) =>
    cond.id.startsWith(F)
      ? fluid.buildProcess(own(cond, F, fluid.decl.conditions), a, ctx)
      : cond.id.startsWith(S)
        ? structural.buildProcess(own(cond, S, structural.decl.conditions), a, ctx)
        : // ALE mesh BC: a plain AssignVectorVariableProcess with the Fixed broadcast.
          structural.buildProcess(cond, a, ctx),
  solverSettings: async (v, ctx) => {
    const fluidCtx = ctx.domains!.fluid;
    const structCtx = ctx.domains!.structure;
    const time = { startTime: v.startTime, endTime: v.endTime };
    const fluidValues = { ...unprefixValues(v, F), ...time };
    const fluidSettings = (await fluid.solverSettings(fluidValues, {
      ...fluidCtx,
      assignments: fluidCtx.assignments.map((a) => stripPrefix(a, a.conditionId.startsWith(F) ? F : "")),
    })) as JsonObject;
    // The fluid hook splits skin / no-skin by condition id; the interface is a skin, the mesh BC is not.
    const skin: string[] = [];
    const noSkin: string[] = [];
    for (const a of fluidCtx.assignments) {
      const id = a.conditionId.startsWith(F) ? a.conditionId.slice(F.length) : a.conditionId;
      if (id === "parts" || id.startsWith("initial")) continue;
      (FLUID_NO_SKIN.has(id) ? noSkin : skin).push(`${fluidCtx.modelPartName}.${a.smpPath.split("/").join(".")}`);
    }
    fluidSettings.skin_parts = skin;
    fluidSettings.no_skin_parts = noSkin;
    const structValues = { ...unprefixValues(v, S), ...time, timeStep: asNum(v.f_timeStep, 0.01) };
    const structSettings = (await structural.solverSettings(structValues, structCtx)) as JsonObject;
    // Both solvers read their mesh from the model parts the importer creates; the case's mdpa files
    // are named in each nested solver's own import settings.
    structSettings.time_stepping = fluidSettings.time_stepping; // the structure takes the fluid's step
    const dim = ctx.domainSize;
    const { fluid: fl, structure: st } = interfaces(ctx);
    const mapperFace = (smp: string): JsonValue =>
      (fluidCtx.assignments.find((a) => a.smpPath === smp && a.conditionId === "fluidInterface")?.values.mapperFace as JsonValue) ?? "unique";
    const method = asStr(v.couplingStrategy, "Relaxation");
    const strategy: JsonObject = { solver_type: method, w_0: asNum(v.w0, 0.825) };
    if (method === "Relaxation") strategy.acceleration_type = asStr(v.accelerationType, "Aitken");
    if (method === "MVQN_recursive") strategy.buffer_size = asNum(v.bufferSize, 7);
    return {
      solver_type: "Partitioned",
      coupling_scheme: asStr(v.couplingScheme, "DirichletNeumann"),
      echo_level: 1,
      structure_solver_settings: structSettings,
      fluid_solver_settings: fluidSettings,
      mesh_solver_settings: {
        echo_level: 0,
        domain_size: dim,
        model_part_name: fluidCtx.modelPartName,
        solver_type: asStr(v.meshSolver, "structural_similarity"),
      },
      coupling_settings: {
        nl_tol: asNum(v.nlTol, 1e-7),
        nl_max_it: asNum(v.nlMaxIt, 25),
        solve_mesh_at_each_iteration: v.solveMeshAtEachIteration !== false,
        mapper_settings: fl.map((smp, i) => ({
          mapper_face: mapperFace(smp),
          fluid_interface_submodelpart_name: `${fluidCtx.modelPartName}.${smp.split("/").join(".")}`,
          structure_interface_submodelpart_name: `${structCtx.modelPartName}.${(st[i] ?? st[0]).split("/").join(".")}`,
        })),
        coupling_strategy_settings: strategy,
        structure_interfaces_list: st.map((smp) => `${structCtx.modelPartName}.${smp.split("/").join(".")}`),
        fluid_interfaces_list: fl.map((smp) => `${fluidCtx.modelPartName}.${smp.split("/").join(".")}`),
      },
    };
  },
  postProcess: async (pp, ctx) => {
    const processes = pp.processes as JsonObject;
    // The fluid gravity process lives in its own list in the coupled analysis.
    const scratch: JsonObject = { processes: {} };
    await fluid.postProcess(scratch, { ...ctx.domains!.fluid, values: unprefixValues(ctx.values, F) });
    // Output: one vtk process per physics (the structure's variables are fixed, the user's list goes to the fluid).
    const outputs = pp.output_processes as JsonObject;
    const vtk = (outputs.vtk_output as JsonObject[] | undefined)?.[0];
    if (vtk && outputs.vtk_output) {
      const fluidOut = JSON.parse(JSON.stringify(vtk)) as JsonObject;
      (fluidOut.Parameters as JsonObject).model_part_name = ctx.domains!.fluid.modelPartName;
      const structOut = JSON.parse(JSON.stringify(vtk)) as JsonObject;
      const p = structOut.Parameters as JsonObject;
      p.model_part_name = ctx.domains!.structure.modelPartName;
      p.nodal_solution_step_data_variables = ["DISPLACEMENT", "REACTION"];
      p.gauss_point_variables_extrapolated_to_nodes = ["VON_MISES_STRESS"];
      outputs.vtk_output = [fluidOut, structOut];
    }
    const grav = (scratch.processes as JsonObject).gravity;
    if (grav) processes.fluid_gravity = grav;
    // Keep the lists the analysis reads, even when empty.
    for (const key of ["fluid_initial_conditions_process_list", "fluid_boundary_conditions_process_list", "structure_constraints_process_list", "structure_loads_process_list"]) {
      processes[key] ??= [];
    }
    delete processes.constraints_process_list;
    delete processes.loads_process_list;
    delete processes.list_other_processes;
    return pp;
  },
});
