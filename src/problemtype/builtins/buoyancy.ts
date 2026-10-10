/**
 * Built-in Buoyancy problemtype: natural convection — the incompressible fluid
 * solver coupled with heat transfer through the Boussinesq approximation
 * (`ThermallyCoupled`, FluidDynamicsApplication + ConvectionDiffusionApplication).
 * Mirrors GiDInterface's Buoyancy app (apps/Buoyancy/write/writeProjectParameters.tcl):
 * ONE mesh and ONE ProjectParameters whose `solver_settings` nest a
 * `fluid_solver_settings` and a `thermal_solver_settings`, a Boussinesq force
 * process, and TWO materials files — the fluid one and a `BuoyancyMaterials.json`
 * that repeats the first material for the whole thermal model part.
 *
 * Composed from the Fluid and Convection-Diffusion built-ins rather than copied:
 * the fluid fields and conditions keep their ids, the thermal ones are prefixed
 * `t_`, and the nested solver settings come from those problemtypes' own hooks,
 * so a fix there reaches this one.
 *
 * Not solver-verified in this repository: the shape follows GiDInterface's writer.
 */

import { defineProblemtype, asNum } from "../api";
import { materialJson } from "../materialJson";
import type { ConditionSpec, FieldGroupSpec, FieldSpec, JsonObject, JsonValue, ProblemtypeDeclaration } from "../types";
import { convectionDiffusion } from "./convectionDiffusion";
import { fluid } from "./fluid";
import { prefixFields, unprefixValues } from "./common";
import { monitoredMainScript } from "../mainKratosTemplate";

const MODEL_PART = "ThermalModelPart";
const T = "t_";

const FLUID = fluid.decl.sections[0];
const THERMAL = convectionDiffusion.decl.sections[0];
// The thermal solver shares the fluid's time stepping and echo level, so its own copies are dropped.
const SHARED_WITH_FLUID = ["startTime", "timeStep", "endTime", "echoLevel", "solverType"];
const thermalFields = prefixFields(
  THERMAL.fields.filter((f) => !SHARED_WITH_FLUID.includes(f.id) && f.group !== "time" && f.group !== "analysis" || f.id === "analysisType"),
  T,
  T
);
const thermalGroups: FieldGroupSpec[] = (THERMAL.groups ?? [])
  .filter((g) => g.id !== "time")
  .map((g) => ({ ...g, id: T + g.id, label: `Thermal · ${g.label}` }));

const fluidGroups = (FLUID.groups ?? []).filter((g) => g.id !== "gravity");
const fluidFields = FLUID.fields.filter((f) => f.group !== "gravity" && f.id !== "refVelocity");

const thermalConditions: ConditionSpec[] = convectionDiffusion.decl.conditions
  .filter((c) => c.id !== "parts")
  .map((c) => ({ ...c, id: T + c.id, label: `Thermal · ${c.label}` }));

const boussinesqFields: FieldSpec[] = [
  { id: "gravityVector", label: "Gravity", type: "vector3", default: [0, -9.81, 0], group: "boussinesq", unit: "m/s²" },
  { id: "ambientTemperature", label: "Ambient temperature", type: "number", default: 293.15, group: "boussinesq", unit: "K" },
];

const BASE = fluid.decl;
const decl: ProblemtypeDeclaration = {
  ...BASE,
  id: "buoyancy",
  name: "Buoyancy (natural convection)",
  description: "Fluid flow coupled with heat transfer through the Boussinesq approximation (FluidDynamics + ConvectionDiffusion)",
  icon: "ptBuoyancy",
  family: "coupled",
  analysisStage: "KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis",
  modelPartName: MODEL_PART,
  materialsFileName: "FluidMaterials.json",
  sections: [
    {
      id: "problem",
      label: "Fluid and coupling",
      groups: [...fluidGroups, { id: "boussinesq", label: "Boussinesq", icon: "ptBuoyancy" }],
      fields: [...fluidFields, ...boussinesqFields],
    },
    {
      id: "thermal",
      label: "Thermal",
      icon: "ptThermal",
      groups: thermalGroups,
      fields: [...thermalFields, { id: "t_bodyHeat", label: "Volume heat source [W/m³]", type: "number", default: 0, group: `${T}analysis` }],
    },
  ],
  conditions: [...BASE.conditions, ...thermalConditions],
  // The fluid laws already carry CONDUCTIVITY / SPECIFIC_HEAT for this app.
  materialLaws: BASE.materialLaws.map((l) => ({
    ...l,
    variables: [
      ...l.variables,
      { id: "CONDUCTIVITY", label: "Thermal conductivity [W/(m·K)]", type: "number", default: 0.024, unit: "W/(m·K)" },
      { id: "SPECIFIC_HEAT", label: "Specific heat [J/(kg·K)]", type: "number", default: 1012.0, unit: "J/(kg·K)" },
    ],
  })),
  output: { nodalDefaults: ["VELOCITY", "PRESSURE", "TEMPERATURE"] },
};

export const buoyancy = defineProblemtype(decl, {
  mainScript: () => monitoredMainScript("buoyancy"),
  buildProcess: (cond, a, ctx) => {
    if (cond.id.startsWith(T)) {
      // Delegate to the thermal problemtype with its own (unprefixed) condition.
      const own = convectionDiffusion.decl.conditions.find((c) => c.id === cond.id.slice(T.length));
      return own ? convectionDiffusion.buildProcess(own, a, ctx) : fluid.buildProcess(cond, a, ctx);
    }
    return fluid.buildProcess(cond, a, ctx);
  },
  solverSettings: async (v, ctx) => {
    const fluidSettings = (await fluid.solverSettings({ ...v, gravityValue: 0 }, ctx)) as JsonObject;
    const thermalValues: Record<string, JsonValue> = {
      ...unprefixValues(v, T),
      timeStep: v.timeStep,
      startTime: v.startTime,
      endTime: v.endTime,
      echoLevel: v.echoLevel,
      solverType: "transient",
    };
    const thermalSettings = (await convectionDiffusion.solverSettings(thermalValues, ctx)) as JsonObject;
    // Both solvers share the model part the modelers / importer create.
    fluidSettings.model_import_settings = { input_type: "use_input_model_part" };
    thermalSettings.model_import_settings = { input_type: "use_input_model_part" };
    thermalSettings.material_import_settings = { materials_filename: "BuoyancyMaterials.json" };
    thermalSettings.problem_domain_sub_model_part_list = [fluidSettings.volume_model_part_name as JsonValue];
    delete thermalSettings.processes_sub_model_part_list;
    delete thermalSettings.element_replace_settings;
    return { solver_type: "ThermallyCoupled", domain_size: ctx.domainSize, echo_level: 0, fluid_solver_settings: fluidSettings, thermal_solver_settings: thermalSettings };
  },
  postProcess: (pp, ctx) => {
    const processes = pp.processes as JsonObject;
    const volume = ctx.partsModelParts[0] ?? ctx.modelPartName;
    // GiD lists every process — fluid and thermal initial conditions, boundary
    // conditions and the Boussinesq force — as constraints.
    const constraints = (processes.constraints_process_list as JsonValue[]) ?? [];
    for (const key of ["initial_conditions_process_list", "loads_process_list"]) {
      const moved = processes[key] as JsonValue[] | undefined;
      if (moved) {
        constraints.push(...moved);
        delete processes[key];
      }
    }
    constraints.push({
      python_module: "apply_boussinesq_force_process",
      kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
      process_name: "ApplyBoussinesqForceProcess",
      Parameters: {
        model_part_name: volume,
        gravity: Array.isArray(ctx.values.gravityVector) ? ctx.values.gravityVector : [0, -9.81, 0],
        ambient_temperature: asNum(ctx.values.ambientTemperature, 293.15),
      },
    });
    processes.constraints_process_list = constraints;
    // Heat source: GiD applies it as a HEAT_FLUX on the fluid part.
    const heat = asNum(ctx.values.t_bodyHeat, 0);
    if (heat !== 0) {
      (processes.list_other_processes as JsonValue[]).push({
        python_module: "assign_scalar_variable_process",
        kratos_module: "KratosMultiphysics",
        process_name: "AssignScalarVariableProcess",
        Parameters: { model_part_name: volume, variable_name: "HEAT_FLUX", value: heat, constrained: false },
      });
    }
    return pp;
  },
  extraFiles: (ctx, materials) => {
    // BuoyancyMaterials.json: the first fluid material, applied to the whole thermal model part.
    const first = (materials.properties as JsonObject[] | undefined)?.[0];
    const doc: JsonObject = { properties: first ? [{ ...first, model_part_name: ctx.modelPartName }] : [] };
    return [{ name: "BuoyancyMaterials.json", content: materialJson(doc, buoyancy) }];
  },
});

