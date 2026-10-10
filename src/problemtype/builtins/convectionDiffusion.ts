import { monitoredMainScript } from "../mainKratosTemplate";
/**
 * Built-in Convection-Diffusion (thermal) problemtype. Output shapes mirror
 * GiDInterface's ConvectionDiffusion app
 * (apps/ConvectionDiffusion/write/writeProjectParameters.tcl): stationary and
 * transient strategies, the non-linear iteration parameters, imposed
 * temperature, initial temperature, heat fluxes and the thermal-face process.
 */

import { defineProblemtype, asBool, asNum, asStr } from "../api";
import { JsonObject, JsonValue } from "../types";
import {
  INITIAL,
  linearSolverFields,
  linearSolverSettings,
  scalarConstraint,
  scalarOnConditions,
} from "./common";

const NONLINEAR = { field: "analysisType", equals: "non_linear" };
const RESIDUAL = { field: "convergenceCriterion", oneOf: ["residual_criterion", "and_criterion", "or_criterion"] as JsonValue[] };
const TEMPERATURE = { field: "convergenceCriterion", oneOf: ["displacement_criterion", "and_criterion", "or_criterion"] as JsonValue[] };

export const convectionDiffusion = defineProblemtype(
  {
    id: "convectionDiffusion",
    name: "Convection-Diffusion (thermal)",
    description: "Transient / stationary heat transfer (ConvectionDiffusionApplication)",
    icon: "ptThermal",
    family: "thermal",
    analysisStage:
      "KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis",
    modelPartName: "ThermalModelPart",
    materialsFileName: "ConvectionDiffusionMaterials.json",
    domainSizes: [2, 3],
    sections: [
      {
        id: "problem",
        label: "Problem data",
        groups: [
          { id: "analysis", label: "Analysis", icon: "ptSolver" },
          { id: "time", label: "Time", icon: "ptTime" },
          { id: "nonlinear", label: "Non-linear iteration", icon: "ptSolver" },
          { id: "linear", label: "Linear solver", icon: "ptSolver", collapsed: true },
        ],
        fields: [
          {
            id: "solverType",
            label: "Analysis",
            type: "enum",
            default: "transient",
            group: "analysis",
            options: [
              { value: "transient", label: "Transient" },
              { value: "stationary", label: "Stationary" },
            ],
          },
          {
            id: "analysisType",
            label: "Linearity",
            type: "enum",
            default: "linear",
            group: "analysis",
            options: [
              { value: "linear", label: "Linear" },
              { value: "non_linear", label: "Non-linear" },
            ],
          },
          { id: "startTime", label: "Start time", type: "number", default: 0, group: "time", unit: "s" },
          { id: "timeStep", label: "Time step", type: "number", default: 0.1, group: "time", min: 0, unit: "s" },
          { id: "endTime", label: "End time", type: "number", default: 1.0, group: "time", unit: "s" },
          {
            id: "convergenceCriterion",
            label: "Convergence criterion",
            type: "enum",
            default: "residual_criterion",
            group: "nonlinear",
            visibleWhen: NONLINEAR,
            options: [
              { value: "residual_criterion", label: "Residual" },
              { value: "displacement_criterion", label: "Temperature" },
              { value: "and_criterion", label: "Residual and temperature" },
              { value: "or_criterion", label: "Residual or temperature" },
            ],
          },
          { id: "residualRelTol", label: "Residual rel. tol.", type: "number", default: 1e-5, min: 0, group: "nonlinear", visibleWhen: [NONLINEAR, RESIDUAL] },
          { id: "residualAbsTol", label: "Residual abs. tol.", type: "number", default: 1e-7, min: 0, group: "nonlinear", visibleWhen: [NONLINEAR, RESIDUAL] },
          { id: "temperatureRelTol", label: "Temperature rel. tol.", type: "number", default: 1e-5, min: 0, group: "nonlinear", visibleWhen: [NONLINEAR, TEMPERATURE] },
          { id: "temperatureAbsTol", label: "Temperature abs. tol.", type: "number", default: 1e-7, min: 0, group: "nonlinear", visibleWhen: [NONLINEAR, TEMPERATURE] },
          { id: "maxIteration", label: "Max iterations", type: "int", default: 10, min: 1, group: "nonlinear", visibleWhen: NONLINEAR },
          { id: "lineSearch", label: "Line search", type: "bool", default: false, group: "nonlinear", visibleWhen: NONLINEAR },
          ...linearSolverFields("linear"),
          { id: "echoLevel", label: "Echo level", type: "int", default: 1, min: 0, max: 3, advanced: true },
          { id: "computeReactions", label: "Compute reactions", type: "bool", default: false, advanced: true },
        ],
      },
    ],
    partsCondition: "parts",
    // The solver's element_replace_settings swap generic names for
    // EulerianConvDiff*/ThermalFace* at import time.
    meshNaming: {
      elements: "Element",
      conditions: { 2: "LineCondition", 3: "SurfaceCondition" },
    },
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
      scalarConstraint("TEMPERATURE", {
        id: "initialTemperature",
        label: "Initial temperature",
        unit: "K",
        dflt: 293.15,
        category: "initial",
        icon: "ptInitial",
        interval: INITIAL,
        fixed: false,
      }),
      {
        id: "temperature",
        label: "Fixed temperature",
        list: "constraints_process_list",
        target: "any",
        category: "constraints",
        icon: "ptConstraint",
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
        category: "loads",
        icon: "ptLoad",
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
      scalarOnConditions("FACE_HEAT_FLUX", {
        id: "faceHeatFlux",
        label: "Face heat flux",
        unit: "W/m²",
        icon: "ptLoad",
      }),
      {
        id: "thermalFace",
        label: "Thermal face (radiation / convection)",
        list: "loads_process_list",
        target: "surface",
        category: "loads",
        icon: "ptLoad",
        help: "Exchange with the ambient on a boundary: radiation and/or convection.",
        fields: [
          { id: "ambientTemperature", label: "Ambient temperature [K]", type: "number", default: 273.15 },
          { id: "addRadiation", label: "Add ambient radiation", type: "bool", default: false },
          {
            id: "emissivity",
            label: "Emissivity",
            type: "number",
            default: 0.0,
            min: 0,
            max: 1,
            visibleWhen: { field: "addRadiation", equals: true },
          },
          { id: "addConvection", label: "Add ambient convection", type: "bool", default: false },
          {
            id: "convectionCoefficient",
            label: "Convection coefficient [W/(m²·K)]",
            type: "number",
            default: 0.0,
            min: 0,
            visibleWhen: { field: "addConvection", equals: true },
          },
        ],
        processTemplate: {
          python_module: "apply_thermal_face_process",
          kratos_module: "KratosMultiphysics.ConvectionDiffusionApplication",
          process_name: "ApplyThermalFaceProcess",
          Parameters: {
            model_part_name: "$path",
            ambient_temperature: "$field:ambientTemperature",
            add_ambient_radiation: "$field:addRadiation",
            emissivity: "$field:emissivity",
            add_ambient_convection: "$field:addConvection",
            convection_coefficient: "$field:convectionCoefficient",
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
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 1000, unit: "kg/m³" },
          {
            id: "CONDUCTIVITY",
            label: "Conductivity [W/(m·K)]",
            type: "number",
            default: 0.6,
            unit: "W/(m·K)",
          },
          { id: "SPECIFIC_HEAT", label: "Specific heat [J/(kg·K)]", type: "number", default: 4184, unit: "J/(kg·K)" },
        ],
      },
    ],
    output: { nodalDefaults: ["TEMPERATURE"] },
  },
  {
    mainScript: () => monitoredMainScript("convectionDiffusion"),
    solverSettings: (v, ctx) => {
      const nonLinear = asStr(v.analysisType, "linear") === "non_linear";
      const settings: JsonObject = {
        solver_type: asStr(v.solverType, "transient"),
        analysis_type: nonLinear ? "non_linear" : "linear",
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
      if (asBool(v.computeReactions, false)) settings.compute_reactions = true;
      if (nonLinear) {
        const criterion = asStr(v.convergenceCriterion, "residual_criterion");
        settings.convergence_criterion = criterion;
        if (criterion !== "displacement_criterion") {
          settings.residual_relative_tolerance = asNum(v.residualRelTol, 1e-5);
          settings.residual_absolute_tolerance = asNum(v.residualAbsTol, 1e-7);
        }
        if (criterion !== "residual_criterion") {
          settings.solution_relative_tolerance = asNum(v.temperatureRelTol, 1e-5);
          settings.solution_absolute_tolerance = asNum(v.temperatureAbsTol, 1e-7);
        }
        settings.max_iteration = asNum(v.maxIteration, 10);
        settings.line_search = asBool(v.lineSearch, false);
      }
      const linear = linearSolverSettings(v);
      if (linear) settings.linear_solver_settings = linear;
      if (v.solverType === "stationary") {
        settings.element_replace_settings = { element_name: "LaplacianElement", condition_name: "ThermalFace" };
      }
      return settings;
    },
  }
);
