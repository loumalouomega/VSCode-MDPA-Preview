/**
 * Built-in Compressible Fluid problemtype (explicit compressible Navier-Stokes,
 * FluidDynamicsApplication). Mirrors GiDInterface's CompressibleFluid app
 * (apps/CompressibleFluid/xml/{Strategies,Elements,Conditions,NodalConditions}.xml
 * and write/writeProjectParameters.tcl): 2D only, the explicit `CompressibleExplicit`
 * solver with its Runge-Kutta / forward-Euler schemes and shock-capturing,
 * conservative initial conditions (density, momentum, total energy) and a
 * Newtonian law with conductivity, specific heat and heat-capacity ratio.
 *
 * Not solver-verified in this repository: the shape follows GiDInterface's writer.
 */

import { defineProblemtype, asBool, asNum, asStr, dottedModelPart } from "../api";
import { JsonObject } from "../types";
import { broadcastConstrained, INITIAL, scalarConstraint, vectorConstraint } from "./common";

const ADAPTIVE = { field: "timeStepMode", equals: "adaptive" };
const NO_SKIN = new Set(["densityBC", "energyBC", "momentumConstraints"]);

const AIR = {
  DENSITY: 1.225,
  DYNAMIC_VISCOSITY: 2e-5,
  CONDUCTIVITY: 0.024,
  SPECIFIC_HEAT: 722.14,
  HEAT_CAPACITY_RATIO: 1.4,
};

export const compressibleFluid = defineProblemtype(
  {
    id: "compressibleFluid",
    name: "Compressible Fluid",
    description: "Explicit compressible Navier-Stokes with shock capturing, 2D (FluidDynamicsApplication)",
    icon: "ptCompressible",
    family: "fluid",
    analysisStage: "KratosMultiphysics.FluidDynamicsApplication.fluid_dynamics_analysis",
    modelPartName: "FluidModelPart",
    materialsFileName: "FluidMaterials.json",
    domainSizes: [2],
    sections: [
      {
        id: "problem",
        label: "Problem data",
        groups: [
          { id: "scheme", label: "Scheme", icon: "ptSolver" },
          { id: "time", label: "Time", icon: "ptTime" },
          { id: "shock", label: "Shock capturing", icon: "ptCompressible" },
        ],
        fields: [
          {
            id: "timeScheme",
            label: "Time scheme",
            type: "enum",
            default: "RK4",
            group: "scheme",
            options: [
              { value: "RK4", label: "Runge-Kutta 4" },
              { value: "RK3-TVD", label: "Runge-Kutta 3 TVD" },
              { value: "bfecc", label: "BFECC" },
              { value: "forward_euler", label: "Forward Euler" },
            ],
          },
          { id: "startTime", label: "Start time", type: "number", default: 0, group: "time", unit: "s" },
          { id: "endTime", label: "End time", type: "number", default: 1.0, group: "time", unit: "s" },
          {
            id: "timeStepMode",
            label: "Time stepping",
            type: "enum",
            default: "adaptive",
            group: "time",
            options: [
              { value: "fixed", label: "Fixed step" },
              { value: "adaptive", label: "Adaptive (CFL)" },
            ],
          },
          { id: "timeStep", label: "Time step", type: "number", default: 1e-4, group: "time", min: 0, unit: "s" },
          { id: "courantTarget", label: "Target Courant number", type: "number", default: 0.5, group: "time", visibleWhen: ADAPTIVE },
          { id: "minDeltaTime", label: "Min. time step", type: "number", default: 1e-8, group: "time", visibleWhen: ADAPTIVE },
          { id: "maxDeltaTime", label: "Max. time step", type: "number", default: 1e-3, group: "time", visibleWhen: ADAPTIVE },
          {
            id: "shockCapturing",
            label: "Shock capturing",
            type: "enum",
            default: "physics_based",
            group: "shock",
            options: [
              { value: "none", label: "None" },
              { value: "physics_based", label: "Physics based" },
              { value: "entropy_based", label: "Entropy based" },
            ],
          },
          { id: "useOss", label: "Orthogonal subscales", type: "bool", default: false, group: "shock" },
          { id: "echoLevel", label: "Echo level", type: "int", default: 0, min: 0, max: 3, advanced: true },
          { id: "computeReactions", label: "Compute reactions", type: "bool", default: false, advanced: true },
        ],
      },
    ],
    partsCondition: "parts",
    // GiD's CompressibleNavierStokes2D reads plain Element2D3N blocks.
    meshNaming: { elements: "Element", conditions: "WallCondition" },
    conditions: [
      {
        id: "parts",
        label: "Fluid body",
        list: "list_other_processes",
        target: "volume",
        fields: [],
        processTemplate: {},
        help: "Marks a SubModelPart as the compressible fluid domain; assign a material to it.",
      },
      vectorConstraint("MOMENTUM", { id: "initialMomentum", label: "Initial momentum", unit: "kg/(m²·s)", category: "initial", list: "initial_conditions_process_list", icon: "ptInitial", interval: INITIAL, fixed: false }),
      scalarConstraint("DENSITY", { id: "initialDensity", label: "Initial density", unit: "kg/m³", dflt: 1.225, category: "initial", list: "initial_conditions_process_list", icon: "ptInitial", interval: INITIAL, fixed: false }),
      scalarConstraint("TOTAL_ENERGY", { id: "initialEnergy", label: "Initial total energy", unit: "J/m³", category: "initial", list: "initial_conditions_process_list", icon: "ptInitial", interval: INITIAL, fixed: false }),
      {
        id: "slip",
        label: "Slip wall",
        list: "constraints_process_list",
        target: "surface",
        category: "constraints",
        icon: "ptConstraint",
        fields: [],
        processTemplate: {
          python_module: "apply_slip_process",
          kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
          process_name: "ApplySlipProcess",
          Parameters: { model_part_name: "$path" },
        },
      },
      {
        id: "noSlip",
        label: "No-slip wall",
        list: "constraints_process_list",
        target: "surface",
        category: "constraints",
        icon: "ptConstraint",
        fields: [],
        processTemplate: {
          python_module: "apply_noslip_process",
          kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
          Parameters: { model_part_name: "$path" },
        },
      },
      scalarConstraint("DENSITY", { id: "densityBC", label: "Prescribed density", unit: "kg/m³", dflt: 1.225, icon: "ptConstraint" }),
      scalarConstraint("TOTAL_ENERGY", { id: "energyBC", label: "Prescribed energy", unit: "J/m³", icon: "ptConstraint" }),
      vectorConstraint("MOMENTUM", { id: "momentumConstraints", label: "Prescribed momentum", unit: "kg/(m²·s)", icon: "ptConstraint" }),
    ],
    materialLaws: [
      {
        id: "newtonian_2d",
        name: "Newtonian2DLaw",
        domainSize: 2,
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: AIR.DENSITY, unit: "kg/m³" },
          { id: "DYNAMIC_VISCOSITY", label: "Dynamic viscosity [Pa·s]", type: "number", default: AIR.DYNAMIC_VISCOSITY, unit: "Pa·s" },
          { id: "CONDUCTIVITY", label: "Conductivity [W/(m·K)]", type: "number", default: AIR.CONDUCTIVITY, unit: "W/(m·K)" },
          { id: "SPECIFIC_HEAT", label: "Specific heat [J/(kg·K)]", type: "number", default: AIR.SPECIFIC_HEAT, unit: "J/(kg·K)" },
          { id: "HEAT_CAPACITY_RATIO", label: "Heat capacity ratio", type: "number", default: AIR.HEAT_CAPACITY_RATIO },
        ],
      },
    ],
    output: { nodalDefaults: ["DENSITY", "MOMENTUM", "TOTAL_ENERGY", "PRESSURE", "VELOCITY"] },
  },
  {
    buildProcess: (cond, a, ctx) => broadcastConstrained(cond, a, ctx),
    solverSettings: (v, ctx) => {
      const skin: string[] = [];
      const noSkin: string[] = [];
      for (const a of ctx.assignments) {
        if (a.conditionId === "parts" || a.conditionId.startsWith("initial")) continue;
        (NO_SKIN.has(a.conditionId) ? noSkin : skin).push(dottedModelPart(ctx.modelPartName, a.smpPath));
      }
      const settings: JsonObject = {
        model_part_name: ctx.modelPartName,
        domain_size: 2,
        solver_type: "CompressibleExplicit",
        model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
        material_import_settings: { materials_filename: ctx.materialsFileName },
        echo_level: asNum(v.echoLevel, 0),
        compute_reactions: asBool(v.computeReactions, false),
        time_scheme: asStr(v.timeScheme, "RK4"),
        volume_model_part_name: ctx.partsModelParts[0] ?? ctx.modelPartName,
        skin_parts: skin,
        no_skin_parts: noSkin,
        shock_capturing_settings: { type: asStr(v.shockCapturing, "physics_based") },
        use_oss: asBool(v.useOss, false),
        time_stepping:
          v.timeStepMode === "adaptive"
            ? {
                automatic_time_step: true,
                CFL_number: asNum(v.courantTarget, 0.5),
                minimum_delta_time: asNum(v.minDeltaTime, 1e-8),
                maximum_delta_time: asNum(v.maxDeltaTime, 1e-3),
                time_step: asNum(v.timeStep, 1e-4),
              }
            : { automatic_time_step: false, time_step: asNum(v.timeStep, 1e-4) },
        reform_dofs_at_each_step: false,
      };
      return settings as JsonObject;
    },
  }
);

