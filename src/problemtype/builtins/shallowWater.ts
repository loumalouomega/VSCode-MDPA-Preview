/**
 * Built-in Shallow Water problemtype (ShallowWaterApplication). Mirrors
 * GiDInterface's ShallowWater app: a standalone 2D solver
 * (stabilized_shallow_water_solver), MANNING-only materials
 * (TopographyMaterials.json), and the app's own process lists —
 * topography_process_list / initial_conditions_process_list /
 * boundary_conditions_process_list.
 */

import { defineProblemtype, asNum } from "../api";
import { JsonObject } from "../types";

export const shallowWater = defineProblemtype(
  {
    id: "shallowWater",
    name: "Shallow Water",
    description: "2D free-surface shallow-water flows (ShallowWaterApplication)",
    icon: "ptShallowWater",
    analysisStage: "KratosMultiphysics.ShallowWaterApplication.shallow_water_analysis",
    modelPartName: "main_model_part",
    materialsFileName: "TopographyMaterials.json",
    domainSizes: [2],
    sections: [
      {
        id: "problem",
        label: "Problem data",
        fields: [
          { id: "timeStep", label: "Time step", type: "number", default: 0.01 },
          { id: "endTime", label: "End time", type: "number", default: 1.0 },
          { id: "echoLevel", label: "Echo level", type: "int", default: 1 },
          { id: "gravity", label: "Gravity [m/s²]", type: "number", default: 9.81 },
          { id: "maxIterations", label: "Max iterations", type: "int", default: 10 },
          {
            id: "shockCapturing",
            label: "Shock capturing",
            type: "enum",
            default: "residual_viscosity",
            options: [
              { value: "residual_viscosity", label: "Residual viscosity" },
              { value: "gradient_jump", label: "Gradient jump" },
              { value: "flux_correction", label: "Flux correction" },
            ],
          },
          { id: "shockCapturingFactor", label: "Shock capturing factor", type: "number", default: 0.5 },
        ],
      },
    ],
    partsCondition: "parts",
    meshNaming: { elements: "Element", conditions: { 2: "LineCondition" } },
    conditions: [
      {
        id: "parts",
        label: "Water domain",
        list: "list_other_processes",
        target: "volume",
        fields: [],
        processTemplate: {},
        help: "Marks a SubModelPart as computing domain; assign a Manning roughness to it.",
      },
      {
        id: "imposedFlowRate",
        label: "Imposed flow rate",
        list: "boundary_conditions_process_list",
        target: "surface",
        fields: [{ id: "value", label: "q [m²/s]", type: "vector3", default: [0, 0, 0] }],
        processTemplate: {
          python_module: "assign_vector_variable_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignVectorVariableProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "MOMENTUM",
            value: "$field:value",
            interval: [0.0, "End"],
          },
        },
      },
      {
        id: "imposedFreeSurface",
        label: "Imposed free surface",
        list: "boundary_conditions_process_list",
        target: "surface",
        fields: [{ id: "value", label: "Elevation [m]", type: "number", default: 0 }],
        processTemplate: {
          python_module: "assign_scalar_variable_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignScalarVariableProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "HEIGHT",
            value: "$field:value",
            interval: [0.0, "End"],
          },
        },
      },
      {
        id: "slip",
        label: "Slip wall",
        list: "boundary_conditions_process_list",
        target: "surface",
        fields: [],
        processTemplate: {
          python_module: "apply_slip_process",
          kratos_module: "KratosMultiphysics.ShallowWaterApplication",
          process_name: "ApplySlipProcess",
          Parameters: { model_part_name: "$path" },
        },
      },
      {
        id: "initialWaterLevel",
        label: "Initial water level",
        list: "initial_conditions_process_list",
        target: "volume",
        fields: [
          {
            id: "variable",
            label: "Variable",
            type: "enum",
            default: "HEIGHT",
            options: [{ value: "HEIGHT" }, { value: "FREE_SURFACE_ELEVATION" }],
          },
          { id: "value", label: "Value [m]", type: "number", default: 1.0 },
        ],
        processTemplate: {
          python_module: "set_initial_water_level_process",
          kratos_module: "KratosMultiphysics.ShallowWaterApplication",
          process_name: "SetInitialWaterLevelProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "$field:variable",
            value: "$field:value",
          },
        },
      },
      {
        id: "topography",
        label: "Topography",
        list: "topography_process_list",
        target: "volume",
        fields: [
          {
            id: "value",
            label: "z(x,y) expression",
            type: "string",
            default: "0.0",
            help: "Bathymetry as a function of x and y, e.g. 0.05*x",
          },
        ],
        processTemplate: {
          python_module: "set_topography_process",
          kratos_module: "KratosMultiphysics.ShallowWaterApplication",
          process_name: "SetTopographyProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "TOPOGRAPHY",
            value: "$field:value",
          },
        },
      },
    ],
    materialLaws: [
      {
        id: "manning",
        // Roughness only; no constitutive-law block.
        name: "",
        variables: [{ id: "MANNING", label: "Manning coefficient", type: "number", default: 0.01 }],
      },
    ],
    output: { nodalDefaults: ["HEIGHT", "MOMENTUM", "VELOCITY"] },
  },
  {
    solverSettings: (v, ctx) => {
      const settings: JsonObject = {
        solver_type: "stabilized_shallow_water_solver",
        model_part_name: ctx.modelPartName,
        domain_size: 2,
        gravity: asNum(v.gravity, 9.81),
        model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
        material_import_settings: { materials_filename: ctx.materialsFileName },
        echo_level: asNum(v.echoLevel, 1),
        maximum_iterations: asNum(v.maxIterations, 10),
        shock_capturing_type: String(v.shockCapturing ?? "residual_viscosity"),
        shock_capturing_factor: asNum(v.shockCapturingFactor, 0.5),
        time_stepping: { automatic_time_step: false, time_step: asNum(v.timeStep, 0.01) },
      };
      return settings;
    },
  }
);
