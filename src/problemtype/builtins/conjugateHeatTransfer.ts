/**
 * Built-in Conjugate Heat Transfer problemtype: heat exchanged across the
 * interface between a convecting fluid and a conducting solid
 * (`conjugate_heat_transfer`, ConvectionDiffusionApplication). Mirrors
 * GiDInterface's ConjugateHeatTransfer app
 * (apps/ConjugateHeatTransfer/write/writeProjectParameters.tcl): one
 * ProjectParameters whose `solver_settings` nest a `fluid_domain_solver_settings`
 * (the Buoyancy settings, thermally on `FluidThermalModelPart`) and a
 * `solid_domain_solver_settings.thermal_solver_settings`, plus
 * `coupling_settings` with the two interface lists, a modeler list importing
 * both meshes and copying the fluid connectivity into `FluidThermalModelPart`,
 * and one mesh plus one materials file per domain.
 *
 * Composed from the Buoyancy and Convection-Diffusion built-ins rather than
 * copied: the fluid side keeps Buoyancy's ids (fluid fields unprefixed, thermal
 * ones `t_`), the solid side is Convection-Diffusion with an `s_` prefix, and
 * the nested settings come from THEIR hooks.
 *
 * Each side marks its half of the interface with a "thermal interface"
 * condition; Generate refuses a case missing either. Not solver-verified in
 * this repository: the shape follows GiDInterface's writer.
 */

import { defineProblemtype, asNum } from "../api";
import { materialJson } from "../materialJson";
import type {
  ConditionSpec,
  FieldGroupSpec,
  FieldSpec,
  GenContext,
  JsonObject,
  JsonValue,
  ProblemtypeDeclaration,
} from "../types";
import { buoyancy } from "./buoyancy";
import { convectionDiffusion } from "./convectionDiffusion";
import { prefixFields, unprefixValues } from "./common";

const S = "s_";
const FLUID_MODEL_PART = "FluidModelPart";
const FLUID_THERMAL_MODEL_PART = "FluidThermalModelPart";
const SOLID_MODEL_PART = "ThermalModelPart";
const SOLID_PARTS = `${S}parts`;

const COUPLED = buoyancy.decl;
const SOLID = convectionDiffusion.decl.sections[0];
const SHARED_WITH_FLUID = ["startTime", "timeStep", "endTime", "echoLevel", "solverType"];

const solidFields: FieldSpec[] = prefixFields(
  SOLID.fields.filter((f) => !SHARED_WITH_FLUID.includes(f.id) && f.group !== "time" && f.group !== "analysis" || f.id === "analysisType"),
  S,
  S
);
const solidGroups: FieldGroupSpec[] = (SOLID.groups ?? [])
  .filter((g) => g.id !== "time")
  .map((g) => ({ ...g, id: S + g.id, label: `Solid · ${g.label}` }));

const couplingFields: FieldSpec[] = [
  { id: "chtMaxIteration", label: "Max. coupling iterations", type: "int", default: 10, min: 1, group: "coupling" },
  { id: "chtTolerance", label: "Temperature relative tolerance", type: "number", default: 1e-5, min: 0, group: "coupling" },
];

const SOLID_LISTS: Record<string, string> = {
  initial_conditions_process_list: "solid_initial_conditions_process_list",
  constraints_process_list: "solid_constraints_process_list",
  loads_process_list: "solid_constraints_process_list",
  list_other_processes: "solid_list_other_processes",
};

const solidConditions: ConditionSpec[] = convectionDiffusion.decl.conditions.map((c) => ({
  ...c,
  id: S + c.id,
  label: c.id === "parts" ? "Solid body" : c.label,
  list: SOLID_LISTS[String(c.list)] ?? String(c.list),
}));

/** `ApplyThermalFaceProcess` with GiD's hidden defaults — the interface carries the exchange, not the ambient. */
function thermalInterface(id: string, label: string, list: string, help: string): ConditionSpec {
  return {
    id,
    label,
    list,
    target: "surface",
    category: "constraints",
    icon: "ptCoupling",
    help,
    fields: [],
    processTemplate: {
      python_module: "apply_thermal_face_process",
      kratos_module: "KratosMultiphysics.ConvectionDiffusionApplication",
      process_name: "ApplyThermalFaceProcess",
      Parameters: {
        model_part_name: "$path",
        ambient_temperature: 0.0,
        add_ambient_radiation: false,
        add_ambient_convection: false,
      },
    },
  };
}
const fluidInterface = thermalInterface(
  "fluidThermalInterface",
  "Fluid thermal interface",
  "constraints_process_list",
  "The fluid boundary that exchanges heat with the solid."
);
const solidInterface = thermalInterface(
  "solidThermalInterface",
  "Solid thermal interface",
  SOLID_LISTS.constraints_process_list,
  "The solid boundary that exchanges heat with the fluid."
);

const fluidConditionIds = [...COUPLED.conditions.map((c) => c.id), fluidInterface.id];
const solidConditionIds = [...solidConditions.map((c) => c.id), solidInterface.id];

const decl: ProblemtypeDeclaration = {
  ...COUPLED,
  id: "conjugateHeatTransfer",
  name: "Conjugate Heat Transfer",
  description: "Heat exchange between a convecting fluid and a conducting solid across a shared interface (ConvectionDiffusion)",
  icon: "ptConjugateHeat",
  family: "coupled",
  analysisStage: "KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis",
  modelPartName: FLUID_MODEL_PART,
  materialsFileName: "FluidMaterials.json",
  partsCondition: "parts",
  meshNaming: undefined,
  domains: [
    {
      id: "fluid",
      label: "Fluid",
      modelPartName: FLUID_MODEL_PART,
      mdpaSuffix: "Fluid",
      materialsFileName: "FluidMaterials.json",
      partsCondition: "parts",
      conditionIds: fluidConditionIds,
      required: [{ conditionId: fluidInterface.id, message: 'mark the fluid side of the interface: assign at least one SubModelPart as "Fluid thermal interface".' }],
      meshNaming: COUPLED.meshNaming,
    },
    {
      id: "solid",
      label: "Solid",
      modelPartName: SOLID_MODEL_PART,
      mdpaSuffix: "Solid",
      materialsFileName: "SolidMaterials.json",
      partsCondition: SOLID_PARTS,
      conditionIds: solidConditionIds,
      required: [{ conditionId: solidInterface.id, message: 'mark the solid side of the interface: assign at least one SubModelPart as "Solid thermal interface".' }],
      meshNaming: convectionDiffusion.decl.meshNaming,
    },
  ],
  sections: [
    {
      id: "problem",
      label: "Fluid and coupling",
      icon: "ptCoupling",
      groups: [...(COUPLED.sections[0].groups ?? []), { id: "coupling", label: "Thermal coupling", icon: "ptCoupling" }],
      fields: [...COUPLED.sections[0].fields, ...couplingFields],
    },
    { ...COUPLED.sections[1], label: "Fluid thermal" },
    {
      id: "solid",
      label: "Solid",
      icon: "ptThermal",
      groups: solidGroups,
      fields: solidFields,
    },
  ],
  conditions: [...COUPLED.conditions, fluidInterface, ...solidConditions, solidInterface],
  materialLaws: [
    ...COUPLED.materialLaws.map((l) => ({ ...l, domain: "fluid" })),
    ...convectionDiffusion.decl.materialLaws.map((l) => ({ ...l, id: `solid_${l.id}`, domain: "solid" })),
  ],
  output: { nodalDefaults: ["VELOCITY", "PRESSURE", "TEMPERATURE"] },
};

const dotted = (root: string, smp: string): string => `${root}.${smp.split("/").join(".")}`;
const interfaceOf = (ctx: GenContext, domain: string, conditionId: string): string[] =>
  (ctx.domains?.[domain].assignments ?? []).filter((a) => a.conditionId === conditionId).map((a) => a.smpPath);

/** GiD's TransformFluidProcess: thermal processes of the fluid act on the thermal copy of its model part. */
function toFluidThermal(process: JsonObject): JsonObject {
  const params = process.Parameters as JsonObject | undefined;
  const thermal =
    process.python_module === "apply_thermal_face_process" || (params !== undefined && params.variable_name === "TEMPERATURE");
  if (!thermal || typeof params?.model_part_name !== "string") return process;
  const rest = params.model_part_name.split(".").slice(1).join(".");
  return { ...process, Parameters: { ...params, model_part_name: rest ? `${FLUID_THERMAL_MODEL_PART}.${rest}` : FLUID_THERMAL_MODEL_PART } };
}

export const conjugateHeatTransfer = defineProblemtype(decl, {
  buildProcess: (cond, a, ctx) => {
    if (cond.id === fluidInterface.id || cond.id === solidInterface.id) return undefined;
    if (cond.id.startsWith(S)) {
      const own = convectionDiffusion.decl.conditions.find((c) => c.id === cond.id.slice(S.length));
      if (own) return convectionDiffusion.buildProcess(own, a, ctx);
    }
    return buoyancy.buildProcess(cond, a, ctx);
  },
  solverSettings: async (v, ctx) => {
    const fluidCtx = ctx.domains!.fluid;
    const solidCtx = ctx.domains!.solid;
    const fluidSettings = (await buoyancy.solverSettings(v, fluidCtx)) as JsonObject;
    (fluidSettings.thermal_solver_settings as JsonObject).model_part_name = FLUID_THERMAL_MODEL_PART;
    const solidValues: Record<string, JsonValue> = {
      ...unprefixValues(v, S),
      timeStep: v.timeStep,
      startTime: v.startTime,
      endTime: v.endTime,
      echoLevel: v.echoLevel,
      solverType: "transient",
    };
    const solidSettings = (await convectionDiffusion.solverSettings(solidValues, solidCtx)) as JsonObject;
    // The modelers import both meshes, so no solver imports a file of its own.
    solidSettings.model_import_settings = { input_type: "use_input_model_part" };
    const toList = (paths: string[], root: string): string[] => paths.map((p) => dotted(root, p));
    return {
      solver_type: "conjugate_heat_transfer",
      domain_size: ctx.domainSize,
      echo_level: 0,
      fluid_domain_solver_settings: fluidSettings,
      solid_domain_solver_settings: { thermal_solver_settings: solidSettings },
      coupling_settings: {
        max_iteration: asNum(v.chtMaxIteration, 10),
        temperature_relative_tolerance: asNum(v.chtTolerance, 1e-5),
        fluid_interfaces_list: toList(interfaceOf(ctx, "fluid", fluidInterface.id), FLUID_THERMAL_MODEL_PART),
        solid_interfaces_list: toList(interfaceOf(ctx, "solid", solidInterface.id), SOLID_MODEL_PART),
      },
    };
  },
  postProcess: async (pp, ctx) => {
    const processes = pp.processes as Record<string, JsonValue[]>;
    const fluidCtx = ctx.domains!.fluid;
    // The fluid half goes through Buoyancy's own folding (Boussinesq force, initial conditions as constraints).
    const scratch: JsonObject = { processes: {} };
    const fluidLists = ["initial_conditions_process_list", "constraints_process_list", "loads_process_list", "list_other_processes"];
    for (const key of fluidLists) (scratch.processes as JsonObject)[key] = processes[key] ?? [];
    await buoyancy.postProcess(scratch, { ...fluidCtx, domains: ctx.domains });
    const folded = scratch.processes as Record<string, JsonValue[]>;
    processes.fluid_constraints_process_list = [...(folded.constraints_process_list ?? []), ...(folded.list_other_processes ?? [])].map((p) =>
      toFluidThermal(p as JsonObject)
    );
    for (const key of fluidLists) delete processes[key];
    for (const key of Object.values(SOLID_LISTS)) processes[key] ??= [];

    // One output process per domain, like GiD (the solid has temperature only).
    const outputs = pp.output_processes as JsonObject;
    const vtk = (outputs.vtk_output as JsonObject[] | undefined)?.[0];
    if (vtk) {
      const fluidOut = JSON.parse(JSON.stringify(vtk)) as JsonObject;
      (fluidOut.Parameters as JsonObject).model_part_name = FLUID_MODEL_PART;
      const solidOut = JSON.parse(JSON.stringify(vtk)) as JsonObject;
      const p = solidOut.Parameters as JsonObject;
      p.model_part_name = SOLID_MODEL_PART;
      p.nodal_solution_step_data_variables = ["TEMPERATURE"];
      outputs.vtk_output = [fluidOut, solidOut];
    }

    pp.modelers = [
      { name: "Modelers.KratosMultiphysics.ImportMDPAModeler", parameters: { input_filename: fluidCtx.mdpaStem, model_part_name: FLUID_MODEL_PART } },
      { name: "Modelers.KratosMultiphysics.ImportMDPAModeler", parameters: { input_filename: ctx.domains!.solid.mdpaStem, model_part_name: SOLID_MODEL_PART } },
      {
        name: "Modelers.KratosMultiphysics.ConnectivityPreserveModeler",
        parameters: { origin_model_part_name: FLUID_MODEL_PART, destination_model_part_name: FLUID_THERMAL_MODEL_PART },
      },
    ];
    return pp;
  },
  extraFiles: (_ctx, materials) => {
    // The thermal copy of the fluid reads the first fluid material, as in Buoyancy.
    const first = (materials.properties as JsonObject[] | undefined)?.[0];
    const doc: JsonObject = { properties: first ? [{ ...first, model_part_name: FLUID_THERMAL_MODEL_PART }] : [] };
    return [{ name: "BuoyancyMaterials.json", content: materialJson(doc, conjugateHeatTransfer) }];
  },
});
