import { monitoredMainScript } from "../mainKratosTemplate";
/**
 * Built-in Shallow Water problemtype (ShallowWaterApplication). Mirrors
 * GiDInterface's ShallowWater app (apps/ShallowWater/xml/Strategies.xml): the
 * three solvers — stabilized shallow water, Boussinesq dispersive waves and
 * linear waves — with their time schemes (BDF, Adams-Moulton, Crank-Nicolson),
 * MANNING-only materials (TopographyMaterials.json), and the app's own process
 * lists — topography_process_list / initial_conditions_process_list /
 * boundary_conditions_process_list.
 *
 * The automatic time step ids are deliberately not `timeStepMode` /
 * `courantTarget`: those names switch on the fluid time-stepping validation
 * (generate.ts) and its estimate, which describe CFD only.
 */

import { defineProblemtype, asBool, asNum, asStr } from "../api";
import { JsonObject, JsonValue } from "../types";
import { linearSolverFields, linearSolverSettings } from "./common";

const STABILIZED = { field: "solver", equals: "stabilized_shallow_water_solver" };
const HAS_SHOCK_FACTOR = { field: "solver", oneOf: ["stabilized_shallow_water_solver", "boussinesq_solver"] as JsonValue[] };
const SCHEME_WITH_ORDER = { field: "scheme", oneOf: ["bdf", "Adams-Moulton"] as JsonValue[] };
const ADAPTIVE = { field: "adaptiveStep", equals: true };

export const shallowWater = defineProblemtype(
  {
    id: "shallowWater",
    name: "Shallow Water",
    description: "2D free-surface shallow-water flows: stabilized, Boussinesq and linear waves (ShallowWaterApplication)",
    icon: "ptShallowWater",
    family: "fluid",
    analysisStage: "KratosMultiphysics.ShallowWaterApplication.shallow_water_analysis",
    modelPartName: "main_model_part",
    materialsFileName: "TopographyMaterials.json",
    domainSizes: [2],
    sections: [
      {
        id: "problem",
        label: "Problem data",
        groups: [
          { id: "model", label: "Physics", icon: "ptSolver" },
          { id: "time", label: "Time", icon: "ptTime" },
          { id: "stabilization", label: "Stabilization", icon: "ptSolver" },
          { id: "gravity", label: "Gravity", icon: "ptGravity" },
          { id: "linear", label: "Linear solver", icon: "ptSolver", collapsed: true },
        ],
        fields: [
          {
            id: "solver",
            label: "Solution type",
            type: "enum",
            default: "stabilized_shallow_water_solver",
            group: "model",
            options: [
              { value: "stabilized_shallow_water_solver", label: "Shallow water flow" },
              { value: "boussinesq_solver", label: "Dispersive waves (Boussinesq)" },
              { value: "wave_solver", label: "Linear waves" },
            ],
          },
          {
            id: "scheme",
            label: "Scheme",
            type: "enum",
            default: "bdf",
            group: "model",
            options: [
              { value: "bdf", label: "BDF" },
              { value: "Adams-Moulton", label: "Adams-Moulton" },
              { value: "cn", label: "Crank-Nicolson" },
            ],
            help: "Adams-Moulton belongs to the Boussinesq solver and Crank-Nicolson to the linear-wave solver.",
          },
          { id: "timeIntegrationOrder", label: "Integration order", type: "int", default: 2, min: 1, max: 4, group: "model", visibleWhen: SCHEME_WITH_ORDER },
          { id: "startTime", label: "Start time", type: "number", default: 0, group: "time", unit: "s" },
          { id: "endTime", label: "End time", type: "number", default: 1.0, group: "time", unit: "s" },
          { id: "adaptiveStep", label: "Automatic time step (CFL)", type: "bool", default: false, group: "time" },
          { id: "timeStep", label: "Time step", type: "number", default: 0.01, group: "time", min: 0, unit: "s", visibleWhen: { field: "adaptiveStep", equals: false } },
          { id: "cflNumber", label: "CFL number", type: "number", default: 1.0, group: "time", min: 0, visibleWhen: ADAPTIVE },
          { id: "minDeltaTime", label: "Min. time step", type: "number", default: 1e-4, group: "time", visibleWhen: ADAPTIVE },
          { id: "maxDeltaTime", label: "Max. time step", type: "number", default: 1.0, group: "time", visibleWhen: ADAPTIVE },
          { id: "maxIterations", label: "Max iterations", type: "int", default: 10, min: 1, group: "stabilization" },
          { id: "stabilizationFactor", label: "Stabilization factor", type: "number", default: 0.01, min: 0, group: "stabilization" },
          {
            id: "shockCapturing",
            label: "Shock capturing",
            type: "enum",
            default: "residual_viscosity",
            group: "stabilization",
            visibleWhen: STABILIZED,
            options: [
              { value: "residual_viscosity", label: "Residual viscosity" },
              { value: "gradient_jump", label: "Gradient jump" },
              { value: "flux_correction", label: "Flux correction" },
            ],
          },
          { id: "shockCapturingFactor", label: "Shock capturing factor", type: "number", default: 0.5, min: 0, group: "stabilization", visibleWhen: HAS_SHOCK_FACTOR },
          { id: "gravity", label: "Gravity", type: "number", default: 9.81, group: "gravity", unit: "m/s²", help: "Always vertical, positive down." },
          ...linearSolverFields("linear"),
          { id: "echoLevel", label: "Echo level", type: "int", default: 1, min: 0, max: 3, advanced: true },
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
        id: "initialWaterLevel",
        label: "Initial water level",
        list: "initial_conditions_process_list",
        target: "volume",
        category: "initial",
        icon: "ptInitial",
        fields: [
          {
            id: "variable",
            label: "Variable",
            type: "enum",
            default: "HEIGHT",
            options: [{ value: "HEIGHT" }, { value: "FREE_SURFACE_ELEVATION" }],
          },
          { id: "value", label: "Value [m]", type: "number", default: 1.0 },
          { id: "setMinimumHeight", label: "Set a minimum height", type: "bool", default: false },
          {
            id: "minimumHeight",
            label: "Minimum height [m]",
            type: "number",
            default: 1e-3,
            min: 0,
            visibleWhen: { field: "setMinimumHeight", equals: true },
          },
        ],
        processTemplate: {
          python_module: "set_initial_water_level_process",
          kratos_module: "KratosMultiphysics.ShallowWaterApplication",
          process_name: "SetInitialWaterLevelProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "$field:variable",
            value: "$field:value",
            set_minimum_height: "$field:setMinimumHeight",
            minimum_height_value: "$field:minimumHeight",
          },
        },
      },
      {
        id: "initialPerturbation",
        label: "Initial perturbation",
        list: "initial_conditions_process_list",
        target: "volume",
        category: "initial",
        icon: "ptInitial",
        help: "A localised bump on the initial water level, centred on given coordinates.",
        fields: [
          {
            id: "variable",
            label: "Variable",
            type: "enum",
            default: "HEIGHT",
            options: [{ value: "HEIGHT" }, { value: "FREE_SURFACE_ELEVATION" }],
          },
          { id: "maximumPerturbation", label: "Maximum value [m]", type: "number", default: 1.0 },
          { id: "distanceOfInfluence", label: "Distance of influence [m]", type: "number", default: 1.0, min: 0 },
          { id: "defaultValue", label: "Default value [m]", type: "number", default: 0.0 },
          { id: "sourceCoordinates", label: "Source point", type: "vector3", default: [0, 0, 0] },
        ],
        processTemplate: {
          python_module: "set_initial_perturbation_process",
          kratos_module: "KratosMultiphysics.ShallowWaterApplication",
          process_name: "SetInitialPerturbationProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "$field:variable",
            maximum_perturbation_value: "$field:maximumPerturbation",
            distance_of_influence: "$field:distanceOfInfluence",
            default_value: "$field:defaultValue",
            source_type: "coordinates",
            source_coordinates: "$field:sourceCoordinates",
          },
        },
      },
      {
        id: "imposedFlowRate",
        label: "Imposed flow rate",
        list: "boundary_conditions_process_list",
        target: "surface",
        category: "constraints",
        icon: "ptConstraint",
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
        id: "imposedVelocity",
        label: "Imposed velocity",
        list: "boundary_conditions_process_list",
        target: "surface",
        category: "constraints",
        icon: "ptConstraint",
        fields: [{ id: "value", label: "v [m/s]", type: "vector3", default: [0, 0, 0] }],
        processTemplate: {
          python_module: "assign_vector_variable_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignVectorVariableProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "VELOCITY",
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
        category: "constraints",
        icon: "ptConstraint",
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
        category: "constraints",
        icon: "ptConstraint",
        fields: [],
        processTemplate: {
          python_module: "apply_slip_process",
          kratos_module: "KratosMultiphysics.ShallowWaterApplication",
          process_name: "ApplySlipProcess",
          Parameters: { model_part_name: "$path" },
        },
      },
      {
        id: "topography",
        label: "Topography",
        list: "topography_process_list",
        target: "volume",
        category: "other",
        icon: "ptParts",
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
    mainScript: () => monitoredMainScript("shallowWater"),
    solverSettings: (v, ctx) => {
      const solver = asStr(v.solver, "stabilized_shallow_water_solver");
      const scheme = asStr(v.scheme, "bdf");
      const adaptive = asBool(v.adaptiveStep, false);
      const settings: JsonObject = {
        solver_type: solver,
        model_part_name: ctx.modelPartName,
        domain_size: 2,
        gravity: asNum(v.gravity, 9.81),
        model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
        material_import_settings: { materials_filename: ctx.materialsFileName },
        echo_level: asNum(v.echoLevel, 1),
        maximum_iterations: asNum(v.maxIterations, 10),
        stabilization_factor: asNum(v.stabilizationFactor, 0.01),
      };
      if (solver === "stabilized_shallow_water_solver") {
        settings.shock_capturing_type = asStr(v.shockCapturing, "residual_viscosity");
      }
      if (solver !== "wave_solver") settings.shock_capturing_factor = asNum(v.shockCapturingFactor, 0.5);
      // The scheme's own parameter, written flat like GiD does.
      if (scheme === "bdf" || scheme === "Adams-Moulton") {
        settings.time_integration_order = asNum(v.timeIntegrationOrder, scheme === "bdf" ? 2 : 4);
      }
      const linear = linearSolverSettings(v);
      if (linear) settings.linear_solver_settings = linear;
      settings.time_stepping = adaptive
        ? {
            automatic_time_step: true,
            courant_number: asNum(v.cflNumber, 1.0),
            maximum_delta_time: asNum(v.maxDeltaTime, 1.0),
            minimum_delta_time: asNum(v.minDeltaTime, 1e-4),
          }
        : { automatic_time_step: false, time_step: asNum(v.timeStep, 0.01) };
      return settings;
    },
  }
);
