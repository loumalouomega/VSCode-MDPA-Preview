/**
 * Built-in Convection-Diffusion (thermal) problemtype. Output shapes mirror
 * GiDInterface's ConvectionDiffusion app.
 */

import { defineProblemtype, asNum, asStr } from "../api";
import { JsonObject } from "../types";

export const convectionDiffusion = defineProblemtype(
  {
    id: "convectionDiffusion",
    name: "Convection-Diffusion (thermal)",
    description: "Transient / stationary heat transfer (ConvectionDiffusionApplication)",
    analysisStage:
      "KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis",
    modelPartName: "ThermalModelPart",
    materialsFileName: "ConvectionDiffusionMaterials.json",
    domainSizes: [2, 3],
    sections: [
      {
        id: "problem",
        label: "Problem data",
        fields: [
          {
            id: "solverType",
            label: "Analysis",
            type: "enum",
            default: "transient",
            options: [
              { value: "transient", label: "Transient" },
              { value: "stationary", label: "Stationary" },
            ],
          },
          { id: "timeStep", label: "Time step", type: "number", default: 0.1 },
          { id: "endTime", label: "End time", type: "number", default: 1.0 },
          { id: "echoLevel", label: "Echo level", type: "int", default: 1 },
        ],
      },
    ],
    partsCondition: "parts",
    conditions: [
      {
        id: "parts",
        label: "Thermal body",
        list: "list_other_processes",
        target: "volume",
        fields: [],
        processTemplate: {},
        help: "Marks a SubModelPart as computing domain; assign a material to it.",
      },
      {
        id: "temperature",
        label: "Fixed temperature",
        list: "constraints_process_list",
        target: "any",
        fields: [{ id: "value", label: "Temperature [K]", type: "number", default: 293.15 }],
        processTemplate: {
          python_module: "assign_scalar_variable_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignScalarVariableProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "TEMPERATURE",
            constrained: true,
            value: "$field:value",
            interval: [0.0, "End"],
          },
        },
      },
      {
        id: "heatFlux",
        label: "Heat flux (volume)",
        list: "loads_process_list",
        target: "volume",
        fields: [{ id: "value", label: "Heat flux [W/m³]", type: "number", default: 0 }],
        processTemplate: {
          python_module: "assign_scalar_variable_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignScalarVariableProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "HEAT_FLUX",
            constrained: false,
            value: "$field:value",
            interval: [0.0, "End"],
          },
        },
      },
      {
        id: "faceHeatFlux",
        label: "Face heat flux",
        list: "loads_process_list",
        target: "surface",
        fields: [{ id: "value", label: "Heat flux [W/m²]", type: "number", default: 0 }],
        processTemplate: {
          python_module: "assign_scalar_variable_to_conditions_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignScalarVariableToConditionsProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "FACE_HEAT_FLUX",
            value: "$field:value",
            interval: [0.0, "End"],
          },
        },
      },
    ],
    materialLaws: [
      {
        id: "thermal",
        // Thermal materials carry variables only; no constitutive law block.
        name: "",
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 1000 },
          { id: "CONDUCTIVITY", label: "Conductivity [W/(m·K)]", type: "number", default: 0.6 },
          { id: "SPECIFIC_HEAT", label: "Specific heat [J/(kg·K)]", type: "number", default: 4184 },
        ],
      },
    ],
    output: { nodalDefaults: ["TEMPERATURE"] },
  },
  {
    solverSettings: (v, ctx) => {
      const settings: JsonObject = {
        solver_type: asStr(v.solverType, "transient"),
        analysis_type: "linear",
        model_part_name: ctx.modelPartName,
        domain_size: ctx.domainSize,
        model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
        material_import_settings: { materials_filename: ctx.materialsFileName },
        echo_level: asNum(v.echoLevel, 1),
        // Derived from the assignments, like the fluid solver's skin_parts.
        problem_domain_sub_model_part_list: ctx.partsModelParts,
        processes_sub_model_part_list: ctx.skinModelParts,
        time_stepping: { time_step: asNum(v.timeStep, 0.1) },
      };
      return settings;
    },
  }
);
