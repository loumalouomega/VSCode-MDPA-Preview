import { monitoredMainScript } from "../mainKratosTemplate";
/**
 * Built-in Fluid Dynamics problemtype. Output shapes mirror GiDInterface's
 * Fluid app (apps/Fluid/write/writeProjectParameters.tcl): the monolithic
 * Navier-Stokes strategy with its element formulations (QSVMS, DVMS, FIC) and
 * Bossak / BDF2 time schemes, the fractional-step strategy, wall-law and custom
 * constraint conditions, initial conditions and gravity. This is the built-in
 * that motivates the imperative hooks: volume_model_part_name / skin_parts /
 * no_skin_parts are derived from the user's assignments, which a declarative
 * template cannot express.
 */

import { defineProblemtype, asBool, asNum, asStr, dottedModelPart, resolveProcessTemplate } from "../api";
import { JsonObject, JsonValue } from "../types";
import {
  INITIAL,
  broadcastConstrained,
  linearSolverFields,
  linearSolverSettings,
  scalarConstraint,
  vectorConstraint,
} from "./common";

/** Conditions that are not boundary skin: GiD lists them in `no_skin_parts`. */
const NO_SKIN = new Set(["velocityConstraints", "pressureConstraints"]);

/**
 * Conditions that name a SubModelPart without being a boundary condition of the
 * solver: monitors read results off a part and a periodic pair is constrained
 * by a process, so neither belongs in `skin_parts` or `no_skin_parts`.
 */
export const FLUID_NOT_BOUNDARY = new Set(["flowForces", "aerodynamicCoefficients", "pressureCoefficient", "yPlus", "periodic"]);

/** Kratos' `formulation.element_type` for each element choice whose key differs from ours. */
const FORMULATION_KEY: Record<string, string> = { axisymmetric: "axisymmetric_navier_stokes" };

/** Output variables a monitor writes as non-historical nodal data, by condition. */
const MONITOR_OUTPUT: Record<string, string> = { pressureCoefficient: "PRESSURE_COEFFICIENT", yPlus: "Y_PLUS" };

const MONOLITHIC = { field: "strategy", equals: "monolithic" };
const STOKES = { field: "strategy", equals: "stokes" };
const ELEMENT_IS = (v: string) => ({ field: "elementType", equals: v });
const BOSSAK = { field: "timeScheme", equals: "bossak" };
const FRACTIONAL = { field: "strategy", equals: "fractional_step" };
const ADAPTIVE = { field: "timeStepMode", equals: "adaptive" };
const OSS_ELEMENTS = { field: "elementType", oneOf: ["qsvms", "dvms"] as JsonValue[] };

export const fluid = defineProblemtype(
  {
    id: "fluid",
    name: "Fluid Dynamics",
    description: "Incompressible Navier-Stokes: monolithic (QSVMS, DVMS, FIC) or fractional step (FluidDynamicsApplication)",
    icon: "ptFluid",
    family: "fluid",
    analysisStage: "KratosMultiphysics.FluidDynamicsApplication.fluid_dynamics_analysis",
    modelPartName: "FluidModelPart",
    materialsFileName: "FluidMaterials.json",
    domainSizes: [2, 3],
    sections: [
      {
        id: "problem",
        label: "Problem data",
        groups: [
          { id: "formulation", label: "Formulation", icon: "ptSolver" },
          { id: "time", label: "Time", icon: "ptTime" },
          { id: "convergence", label: "Convergence", icon: "ptSolver" },
          { id: "gravity", label: "Gravity", icon: "ptGravity", collapsed: true },
          { id: "linear", label: "Linear solver", icon: "ptSolver", collapsed: true },
        ],
        fields: [
          {
            id: "strategy",
            label: "Strategy",
            type: "enum",
            default: "monolithic",
            group: "formulation",
            options: [
              { value: "monolithic", label: "Monolithic" },
              { value: "fractional_step", label: "Fractional step" },
              { value: "stokes", label: "Stokes (monolithic, linear)" },
            ],
          },
          {
            id: "elementType",
            label: "Element",
            type: "enum",
            default: "qsvms",
            group: "formulation",
            visibleWhen: MONOLITHIC,
            options: [
              { value: "qsvms", label: "Quasi-static VMS" },
              { value: "dvms", label: "Dynamic VMS" },
              { value: "fic", label: "FIC" },
              { value: "vms", label: "Classic VMS (legacy)" },
              { value: "weakly_compressible", label: "Weakly compressible" },
              { value: "axisymmetric", label: "Axisymmetric (2D)" },
              { value: "p2p1", label: "P2-P1 continuous (quadratic)" },
            ],
          },
          { id: "timeIntegrated", label: "Element integrates in time", type: "bool", default: false, group: "formulation", visibleWhen: [MONOLITHIC, ELEMENT_IS("qsvms")], help: "TimeIntegratedQSVMS: the element applies the time scheme itself instead of the strategy." },
          { id: "ficBeta", label: "FIC beta", type: "number", default: 0.8, min: 0, group: "formulation", visibleWhen: [MONOLITHIC, ELEMENT_IS("fic")] },
          { id: "soundVelocity", label: "Speed of sound", type: "number", default: 1e12, min: 0, unit: "m/s", group: "formulation", visibleWhen: [MONOLITHIC, ELEMENT_IS("weakly_compressible")], help: "The default is effectively incompressible; use the real speed of sound for a compressible-limit study." },
          { id: "nonNewtonian", label: "Non-Newtonian (Herschel-Bulkley)", type: "bool", default: false, group: "formulation", visibleWhen: [MONOLITHIC, ELEMENT_IS("vms")], help: "The legacy VMS element takes its power-law parameters from the solver; the other elements read a constitutive law from the material." },
          { id: "powerLawK", label: "Consistency index K", type: "number", default: 1e-6, min: 0, group: "formulation", visibleWhen: [MONOLITHIC, ELEMENT_IS("vms"), { field: "nonNewtonian", equals: true }] },
          { id: "powerLawN", label: "Power-law index n", type: "number", default: 1.0, min: 0, group: "formulation", visibleWhen: [MONOLITHIC, ELEMENT_IS("vms"), { field: "nonNewtonian", equals: true }] },
          { id: "yieldStress", label: "Yield stress", type: "number", default: 0, min: 0, unit: "Pa", group: "formulation", visibleWhen: [MONOLITHIC, ELEMENT_IS("vms"), { field: "nonNewtonian", equals: true }] },
          { id: "regularization", label: "Regularization coefficient", type: "number", default: 100, min: 0, group: "formulation", visibleWhen: [MONOLITHIC, ELEMENT_IS("vms"), { field: "nonNewtonian", equals: true }] },
          { id: "forceSteadyState", label: "Force steady state", type: "bool", default: false, group: "formulation", visibleWhen: STOKES },
          { id: "timeOrder", label: "Time order", type: "int", default: 2, min: 1, max: 2, group: "formulation", visibleWhen: FRACTIONAL },
          { id: "useSlipConditions", label: "Slip conditions on the skin", type: "bool", default: true, group: "formulation", visibleWhen: FRACTIONAL },
          { id: "considerPeriodic", label: "Periodic boundaries", type: "bool", default: false, group: "formulation", help: "Turn on when a Periodic boundary condition is assigned." },
          {
            id: "timeScheme",
            label: "Time scheme",
            type: "enum",
            default: "bossak",
            group: "formulation",
            visibleWhen: MONOLITHIC,
            options: [
              { value: "bdf2", label: "BDF2" },
              { value: "bossak", label: "Bossak" },
            ],
          },
          { id: "bossakAlpha", label: "Bossak alpha", type: "number", default: -0.3, min: -0.5, max: 0, group: "formulation", visibleWhen: [MONOLITHIC, BOSSAK] },
          { id: "oss", label: "Orthogonal subscales", type: "bool", default: false, group: "formulation", visibleWhen: [MONOLITHIC, OSS_ELEMENTS] },
          { id: "dynamicTau", label: "Dynamic tau", type: "number", default: 1.0, min: 0, group: "formulation" },
          {
            id: "timeStepMode",
            label: "Time stepping",
            type: "enum",
            default: "fixed",
            group: "time",
            options: [
              { value: "fixed", label: "Fixed step" },
              { value: "adaptive", label: "Adaptive (CFL)" },
            ],
          },
          { id: "startTime", label: "Start time", type: "number", default: 0, group: "time", unit: "s" },
          { id: "timeStep", label: "Time step", type: "number", default: 0.01, group: "time", min: 0, unit: "s" },
          { id: "courantTarget", label: "Target Courant number", type: "number", default: 1.0, group: "time", visibleWhen: ADAPTIVE },
          { id: "minDeltaTime", label: "Min. time step", type: "number", default: 1e-4, group: "time", visibleWhen: ADAPTIVE },
          { id: "maxDeltaTime", label: "Max. time step", type: "number", default: 0.1, group: "time", visibleWhen: ADAPTIVE },
          // Guidance only: read by the time-step estimate, never written to the solver.
          { id: "refVelocity", label: "Reference velocity (estimate only)", type: "number", default: 1.0, group: "time" },
          { id: "endTime", label: "End time", type: "number", default: 1.0, group: "time", unit: "s" },
          { id: "maxIterations", label: "Max iterations", type: "int", default: 10, min: 1, group: "convergence", visibleWhen: MONOLITHIC },
          { id: "relVelTol", label: "Rel. velocity tol.", type: "number", default: 1e-3, min: 0, group: "convergence", visibleWhen: MONOLITHIC },
          { id: "absVelTol", label: "Abs. velocity tol.", type: "number", default: 1e-5, min: 0, group: "convergence", visibleWhen: MONOLITHIC },
          { id: "relPresTol", label: "Rel. pressure tol.", type: "number", default: 1e-3, min: 0, group: "convergence", visibleWhen: MONOLITHIC },
          { id: "absPresTol", label: "Abs. pressure tol.", type: "number", default: 1e-5, min: 0, group: "convergence", visibleWhen: MONOLITHIC },
          { id: "velocityTolerance", label: "Velocity tolerance", type: "number", default: 1e-3, min: 0, group: "convergence", visibleWhen: FRACTIONAL },
          { id: "maxVelocityIterations", label: "Max velocity iterations", type: "int", default: 4, min: 1, group: "convergence", visibleWhen: FRACTIONAL },
          { id: "predictorCorrector", label: "Predictor-corrector", type: "bool", default: false, group: "convergence", visibleWhen: FRACTIONAL },
          { id: "pressureTolerance", label: "Pressure tolerance", type: "number", default: 1e-3, min: 0, group: "convergence", visibleWhen: [FRACTIONAL, { field: "predictorCorrector", equals: true }] },
          { id: "maxPressureIterations", label: "Max pressure iterations", type: "int", default: 4, min: 1, group: "convergence", visibleWhen: [FRACTIONAL, { field: "predictorCorrector", equals: true }] },
          {
            id: "gravityValue",
            label: "Gravity",
            type: "number",
            default: 0,
            min: 0,
            group: "gravity",
            unit: "m/s²",
            help: "Body force modulus; 0 writes no gravity process.",
          },
          { id: "gravityDirection", label: "Direction", type: "vector3", default: [0, -1, 0], group: "gravity" },
          ...linearSolverFields("linear"),
          { id: "echoLevel", label: "Echo level", type: "int", default: 0, min: 0, max: 3, advanced: true },
          { id: "computeReactions", label: "Compute reactions", type: "bool", default: false, advanced: true },
        ],
      },
    ],
    partsCondition: "parts",
    // The fluid solver replaces elements from formulation.element_type, so the
    // mdpa carries generic names.
    meshNaming: { elements: "Element", conditions: "WallCondition" },
    conditions: [
      {
        id: "parts",
        label: "Fluid body",
        list: "list_other_processes",
        target: "volume",
        fields: [],
        processTemplate: {},
        help: "Marks a SubModelPart as the fluid domain; assign a material to it.",
      },
      vectorConstraint("VELOCITY", {
        id: "initialVelocity",
        label: "Initial velocity",
        unit: "m/s",
        category: "initial",
        list: "initial_conditions_process_list",
        icon: "ptInitial",
        interval: INITIAL,
        fixed: false,
      }),
      scalarConstraint("PRESSURE", {
        id: "initialPressure",
        label: "Initial pressure",
        unit: "Pa",
        category: "initial",
        list: "initial_conditions_process_list",
        icon: "ptInitial",
        interval: INITIAL,
        fixed: false,
      }),
      {
        id: "inlet",
        label: "Inlet velocity",
        list: "constraints_process_list",
        target: "surface",
        category: "constraints",
        icon: "ptConstraint",
        fields: [
          { id: "modulus", label: "|v| [m/s]", type: "number", default: 1.0 },
          {
            id: "modulusExpression",
            label: "|v| expression",
            type: "string",
            default: "",
            advanced: true,
            help: "A Kratos expression in the inlet's own coordinates and the current time t, e.g. 0.1214*(1-cos(0.1*pi*t))*y*(1-y). When set it replaces the numeric |v| above.",
          },
          {
            id: "intervalStart",
            label: "Active from [s]",
            type: "number",
            default: 0,
            advanced: true,
            help: "The process applies from this time on. Two inlet assignments on one surface with disjoint windows write a two-phase inlet (the fsi_mok benchmark ramps up until 10 s, then holds).",
          },
          {
            id: "intervalEnd",
            label: "Active until [s]",
            type: "string",
            default: "End",
            advanced: true,
            help: "\"End\" keeps the process active to the end of the simulation; a number deactivates it there.",
          },
          {
            id: "direction",
            label: "Direction",
            type: "enum",
            default: "automatic_inwards_normal",
            options: [
              { value: "automatic_inwards_normal", label: "Inwards normal" },
              { value: "automatic_outwards_normal", label: "Outwards normal" },
              { value: "x", label: "+X" },
              { value: "y", label: "+Y" },
              { value: "z", label: "+Z" },
            ],
          },
        ],
        processTemplate: {
          python_module: "apply_inlet_process",
          kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
          Parameters: {
            model_part_name: "$path",
            variable_name: "VELOCITY",
            modulus: "$field:modulus",
            direction: "$field:direction",
            interval: [0.0, "End"],
          },
        },
      },
      {
        id: "outlet",
        label: "Outlet pressure",
        list: "constraints_process_list",
        target: "surface",
        category: "constraints",
        icon: "ptConstraint",
        fields: [
          { id: "value", label: "Pressure [Pa]", type: "number", default: 0 },
          { id: "hydrostatic", label: "Add hydrostatic contribution", type: "bool", default: false },
          {
            id: "hTop",
            label: "Top height [m]",
            type: "number",
            default: 0.0,
            visibleWhen: { field: "hydrostatic", equals: true },
            help: "Fluid height above the outlet.",
          },
        ],
        processTemplate: {
          python_module: "apply_outlet_process",
          kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
          Parameters: {
            model_part_name: "$path",
            variable_name: "PRESSURE",
            constrained: true,
            value: "$field:value",
            hydrostatic_outlet: "$field:hydrostatic",
            h_top: "$field:hTop",
          },
        },
      },
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
      {
        id: "wallLaw",
        label: "Wall law",
        list: "constraints_process_list",
        target: "surface",
        category: "constraints",
        icon: "ptConstraint",
        fields: [
          {
            id: "wallModel",
            label: "Wall model",
            type: "enum",
            default: "navier_slip",
            options: [
              { value: "navier_slip", label: "Navier slip" },
              { value: "linear_log", label: "Linear-logarithmic" },
            ],
          },
          { id: "slipLength", label: "Slip length [m]", type: "number", default: 0.001, visibleWhen: { field: "wallModel", equals: "navier_slip" } },
          { id: "yWall", label: "Wall distance [m]", type: "number", default: 0.001, visibleWhen: { field: "wallModel", equals: "linear_log" } },
        ],
        // wall_model_settings is nested per model and added by the buildProcess hook.
        processTemplate: {
          python_module: "apply_wall_law_process",
          kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
          process_name: "ApplyWallLawProcess",
          Parameters: { model_part_name: "$path", wall_model_name: "$field:wallModel" },
        },
      },
      vectorConstraint("VELOCITY", {
        id: "velocityConstraints",
        label: "Custom velocity constraints",
        unit: "m/s",
        icon: "ptConstraint",
        help: "Imposes velocity components on a SubModelPart that is not a skin boundary.",
      }),
      scalarConstraint("PRESSURE", {
        id: "pressureConstraints",
        label: "Custom pressure constraints",
        unit: "Pa",
        icon: "ptConstraint",
        help: "Imposes pressure on a SubModelPart that is not a skin boundary.",
      }),
      {
        id: "periodic",
        label: "Periodic boundary",
        list: "constraints_process_list",
        target: "surface",
        category: "constraints",
        icon: "ptConstraint",
        help: "Ties this boundary (the slave) to the master boundary a translation away, for velocity and pressure. Assign it to the slave only and turn on Periodic boundaries.",
        fields: [
          { id: "master", label: "Master boundary", type: "smp", default: "" },
          { id: "translation", label: "Translation direction", type: "vector3", default: [1, 0, 0], help: "From the slave to the master." },
          { id: "magnitude", label: "Translation distance [m]", type: "number", default: 1.0, min: 0 },
        ],
        processTemplate: {},
      },
      {
        id: "flowForces",
        label: "Forces and moments on a body",
        list: "auxiliar_process_list",
        target: "surface",
        category: "other",
        icon: "ptResults",
        help: "Integrates pressure and viscous traction over this wall and writes Fx Fy Fz (and moments) per step to <model part>_drag.dat.",
        fields: [
          { id: "referencePoint", label: "Moment reference point", type: "vector3", default: [0, 0, 0] },
          { id: "writeMoments", label: "Write moments", type: "bool", default: true },
          { id: "printToScreen", label: "Print to screen", type: "bool", default: false },
        ],
        processTemplate: {
          python_module: "compute_body_fitted_flow_forces_and_moments_process",
          kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
          process_name: "ComputeBodyFittedFlowForcesAndMomentsProcess",
          Parameters: {
            model_part_name: "$path",
            interval: [0.0, "End"],
            print_to_screen: "$field:printToScreen",
            write_forces_output_file: true,
            write_moments_output_file: "$field:writeMoments",
            reference_point: "$field:referencePoint",
          },
        },
      },
      {
        id: "aerodynamicCoefficients",
        label: "Aerodynamic coefficients",
        list: "auxiliar_process_list",
        target: "surface",
        category: "other",
        icon: "ptResults",
        help: "Writes drag, lift and moment coefficients of this wall: force over the dynamic pressure times the reference area (moments also times the reference chord).",
        fields: [
          { id: "referenceArea", label: "Reference area [m²]", type: "number", default: 1.0, min: 0 },
          { id: "referenceChord", label: "Reference chord [m]", type: "number", default: 1.0, min: 0 },
          { id: "dynamicPressure", label: "Dynamic pressure [Pa]", type: "number", default: 1.0, min: 0, help: "0.5 · density · speed²." },
          { id: "referencePoint", label: "Moment reference point", type: "vector3", default: [0, 0, 0] },
          { id: "printToScreen", label: "Print to screen", type: "bool", default: false },
        ],
        processTemplate: {
          python_module: "compute_aerodynamic_coefficients_process",
          kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
          process_name: "ComputeAerodynamicCoefficientsProcess",
          Parameters: {
            model_part_name: "$path",
            interval: [0.0, "End"],
            print_coefficients_to_screen: "$field:printToScreen",
            write_output_file: true,
            is_embedded: false,
            reference_point: "$field:referencePoint",
            reference_area: "$field:referenceArea",
            reference_chord: "$field:referenceChord",
            dynamic_pressure: "$field:dynamicPressure",
          },
        },
      },
      {
        id: "pressureCoefficient",
        label: "Pressure coefficient",
        list: "auxiliar_process_list",
        target: "surface",
        category: "other",
        icon: "ptResults",
        help: "Writes PRESSURE_COEFFICIENT on this part's nodes for the output: (p − p∞) over the free-stream dynamic pressure.",
        fields: [
          { id: "freestreamDensity", label: "Free-stream density [kg/m³]", type: "number", default: 1.204, min: 0 },
          { id: "freestreamVelocity", label: "Free-stream speed [m/s]", type: "number", default: 1.0, min: 0 },
          { id: "freestreamPressure", label: "Free-stream pressure [Pa]", type: "number", default: 0.0 },
        ],
        processTemplate: {
          python_module: "compute_pressure_coefficient_process",
          kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
          process_name: "ComputePressureCoefficientProcess",
          Parameters: {
            model_part_name: "$path",
            freestream_density: "$field:freestreamDensity",
            freestream_velocity: "$field:freestreamVelocity",
            freestream_pressure: "$field:freestreamPressure",
            pressure_is_historical: true,
            execution_step: "ExecuteBeforeOutputStep",
          },
        },
      },
      {
        id: "yPlus",
        label: "Wall y+",
        list: "auxiliar_process_list",
        target: "surface",
        category: "other",
        icon: "ptResults",
        help: "Writes Y_PLUS on this wall's nodes for the output, to check the first cell height against the wall model.",
        fields: [],
        processTemplate: {
          python_module: "compute_y_plus_process",
          kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
          process_name: "ComputeYPlusProcess",
          Parameters: { model_part_name: "$path", output_variable_name: "Y_PLUS", output_to_elements: false, calculate_normals_every_time_step: false, echo_level: 0 },
        },
      },
    ],
    materialLaws: [
      {
        id: "newtonian_3d",
        name: "Newtonian3DLaw",
        domainSize: 3,
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 1000, unit: "kg/m³" },
          { id: "DYNAMIC_VISCOSITY", label: "Dynamic viscosity [Pa·s]", type: "number", default: 1e-3, unit: "Pa·s" },
        ],
      },
      {
        id: "newtonian_2d",
        name: "Newtonian2DLaw",
        domainSize: 2,
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 1000, unit: "kg/m³" },
          { id: "DYNAMIC_VISCOSITY", label: "Dynamic viscosity [Pa·s]", type: "number", default: 1e-3, unit: "Pa·s" },
        ],
      },
      // Non-Newtonian fluids: a viscosity that follows the strain rate. The element
      // reads the law from the material, so these are offered to the monolithic
      // strategy; the legacy VMS element uses the solver's own power-law settings.
      {
        id: "bingham_3d",
        name: "Bingham3DLaw",
        domainSize: 3,
        group: "Non-Newtonian",
        when: MONOLITHIC,
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 1000, unit: "kg/m³" },
          { id: "DYNAMIC_VISCOSITY", label: "Plastic viscosity [Pa·s]", type: "number", default: 1e-3, unit: "Pa·s" },
          { id: "YIELD_STRESS", label: "Yield stress [Pa]", type: "number", default: 1.0, unit: "Pa" },
          { id: "REGULARIZATION_COEFFICIENT", label: "Regularization coefficient", type: "number", default: 100 },
        ],
      },
      {
        id: "bingham_2d",
        name: "Bingham2DLaw",
        domainSize: 2,
        group: "Non-Newtonian",
        when: MONOLITHIC,
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 1000, unit: "kg/m³" },
          { id: "DYNAMIC_VISCOSITY", label: "Plastic viscosity [Pa·s]", type: "number", default: 1e-3, unit: "Pa·s" },
          { id: "YIELD_STRESS", label: "Yield stress [Pa]", type: "number", default: 1.0, unit: "Pa" },
          { id: "REGULARIZATION_COEFFICIENT", label: "Regularization coefficient", type: "number", default: 100 },
        ],
      },
      {
        id: "herschel_bulkley_3d",
        name: "HerschelBulkley3DLaw",
        domainSize: 3,
        group: "Non-Newtonian",
        when: MONOLITHIC,
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 1000, unit: "kg/m³" },
          { id: "YIELD_STRESS", label: "Yield stress [Pa]", type: "number", default: 1.0, unit: "Pa" },
          { id: "POWER_LAW_K", label: "Consistency index K", type: "number", default: 1e-3 },
          { id: "POWER_LAW_N", label: "Power-law index n", type: "number", default: 1.0 },
          { id: "REGULARIZATION_COEFFICIENT", label: "Regularization coefficient", type: "number", default: 100 },
        ],
      },
    ],
    output: { nodalDefaults: ["VELOCITY", "PRESSURE"] },
  },
  {
    buildProcess: (cond, a, ctx) => {
      if (cond.id === "inlet") {
        const result = resolveProcessTemplate(cond, a, ctx);
        const params = result.Parameters as JsonObject;
        // Optional symbolic modulus and activation window: the expression is a
        // Kratos function of the inlet's own coordinates and time t and
        // replaces the numeric |v| when set; two inlet assignments on one
        // surface with disjoint windows then write a two-phase inlet (the
        // fsi_mok benchmark: the ramp expression up to 10 s, the steady one to
        // the end). Absent values reproduce the template's [0, "End"] window
        // exactly, so cases already recorded keep their bytes.
        const expression = asStr(a.values.modulusExpression, "").trim();
        if (expression) params.modulus = expression;
        const until = asStr(a.values.intervalEnd, "End").trim();
        params.interval = [
          asNum(a.values.intervalStart, 0),
          until === "" || /^end$/i.test(until) ? "End" : Number.isFinite(Number(until)) ? Number(until) : until,
        ];
        const direction = a.values.direction;
        if (direction === "x") params.direction = [1, 0, 0];
        if (direction === "y") params.direction = [0, 1, 0];
        if (direction === "z") params.direction = [0, 0, 1];
        return result;
      }
      if (cond.id === "periodic") {
        const master = asStr(a.values.master, "");
        const direction = Array.isArray(a.values.translation) ? a.values.translation : [1, 0, 0];
        return {
          python_module: "apply_periodic_condition_process",
          kratos_module: "KratosMultiphysics",
          process_name: "ApplyPeriodicConditionProcess",
          Parameters: {
            model_part_name: ctx.modelPartName,
            first_model_part_name: dottedModelPart(ctx.modelPartName, master),
            second_model_part_name: dottedModelPart(ctx.modelPartName, a.smpPath),
            variable_names: ["VELOCITY", "PRESSURE"],
            transformation_settings: {
              translation_settings: { dir_of_translation: direction, magnitude: asNum(a.values.magnitude, 1) },
            },
          },
        };
      }
      if (cond.id === "wallLaw") {
        const result = resolveProcessTemplate(cond, a, ctx);
        const params = result.Parameters as JsonObject;
        params.wall_model_settings =
          params.wall_model_name === "linear_log"
            ? { y_wall: asNum(a.values.yWall, 0.001) }
            : { slip_length: asNum(a.values.slipLength, 0.001) };
        return result;
      }
      // The custom velocity / pressure constraints are plain Assign*VariableProcess.
      return broadcastConstrained(cond, a, ctx);
    },
    mainScript: () => monitoredMainScript("fluid"),
    validate: (ctx) => {
      const problems: string[] = [];
      const v = ctx.values;
      if (v.elementType === "axisymmetric" && v.strategy === "monolithic" && ctx.domainSize !== 2) {
        problems.push("The axisymmetric element is two-dimensional: use a 2D mesh or another element.");
      }
      const periodic = ctx.assignments.filter((a) => a.conditionId === "periodic");
      if (periodic.length > 0 && !asBool(v.considerPeriodic, false)) {
        problems.push('A Periodic boundary is assigned but "Periodic boundaries" is off in Problem data: the solver would ignore the pairing.');
      }
      for (const a of periodic) {
        if (!asStr(a.values.master, "")) problems.push(`The periodic boundary "${a.smpPath}" has no master boundary.`);
        if (a.values.master === a.smpPath) problems.push(`The periodic boundary "${a.smpPath}" is its own master.`);
      }
      return problems;
    },
    solverSettings: (v, ctx) => {
      const fractional = v.strategy === "fractional_step";
      // skin_parts / no_skin_parts split the assignments by whether the
      // condition is a boundary skin (GiD's SkinConditions attribute).
      const skin: string[] = [];
      const noSkin: string[] = [];
      for (const a of ctx.assignments) {
        if (a.conditionId === "parts" || a.conditionId.startsWith("initial") || FLUID_NOT_BOUNDARY.has(a.conditionId)) continue;
        (NO_SKIN.has(a.conditionId) ? noSkin : skin).push(dottedModelPart(ctx.modelPartName, a.smpPath));
      }
      const strategy = asStr(v.strategy, "monolithic");
      const settings: JsonObject = {
        model_part_name: ctx.modelPartName,
        domain_size: ctx.domainSize,
        solver_type: fractional ? "FractionalStep" : strategy === "stokes" ? "monolithic_stokes" : "Monolithic",
        model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
        material_import_settings: { materials_filename: ctx.materialsFileName },
        echo_level: asNum(v.echoLevel, 0),
        compute_reactions: asBool(v.computeReactions, false),
        // Derived from the assignments — the reason this is a hook, not a template.
        volume_model_part_name: ctx.partsModelParts[0] ?? ctx.modelPartName,
        skin_parts: skin,
        no_skin_parts: noSkin,
        time_stepping:
          v.timeStepMode === "adaptive"
            ? {
                automatic_time_step: true,
                CFL_number: asNum(v.courantTarget, 1.0),
                minimum_delta_time: asNum(v.minDeltaTime, 1e-4),
                maximum_delta_time: asNum(v.maxDeltaTime, 0.1),
                // No time_step in adaptive mode: EstimateDtUtility rejects keys
                // outside its defaults; the solver starts from the minimum.
              }
            : { automatic_time_step: false, time_step: asNum(v.timeStep, 0.01) },
      };
      if (asBool(v.considerPeriodic, false)) settings.consider_periodic_conditions = true;
      const linear = linearSolverSettings(v);
      if (fractional) {
        settings.dynamic_tau = asNum(v.dynamicTau, 1.0);
        settings.predictor_corrector = asBool(v.predictorCorrector, false);
        if (settings.predictor_corrector) {
          settings.pressure_tolerance = asNum(v.pressureTolerance, 1e-3);
          settings.maximum_pressure_iterations = asNum(v.maxPressureIterations, 4);
        }
        settings.velocity_tolerance = asNum(v.velocityTolerance, 1e-3);
        settings.maximum_velocity_iterations = asNum(v.maxVelocityIterations, 4);
        settings.time_order = asNum(v.timeOrder, 2);
        settings.use_slip_conditions = asBool(v.useSlipConditions, true);
        if (linear) {
          settings.velocity_linear_solver_settings = { ...linear };
          settings.pressure_linear_solver_settings = { ...linear };
        }
      } else if (strategy === "stokes") {
        // The Stokes solver is linear, steady-capable and takes the symbolic Stokes element.
        settings.formulation = { element_type: "symbolic_stokes" };
        settings.analysis_type = "linear";
        settings.force_steady_state = asBool(v.forceSteadyState, false);
        if (linear) settings.linear_solver_settings = linear;
      } else {
        const elementType = asStr(v.elementType, "qsvms");
        settings.maximum_iterations = asNum(v.maxIterations, 10);
        settings.relative_velocity_tolerance = asNum(v.relVelTol, 1e-3);
        settings.absolute_velocity_tolerance = asNum(v.absVelTol, 1e-5);
        settings.relative_pressure_tolerance = asNum(v.relPresTol, 1e-3);
        settings.absolute_pressure_tolerance = asNum(v.absPresTol, 1e-5);
        settings.time_scheme = asStr(v.timeScheme, "bossak");
        // Kratos' own defaults (alpha -0.3, FIC beta 0.8) are not written, so recorded cases keep their bytes.
        if (settings.time_scheme === "bossak" && asNum(v.bossakAlpha, -0.3) !== -0.3) settings.alpha = asNum(v.bossakAlpha, -0.3);
        // Each formulation validates its own key set, so only its keys are written.
        const formulation: JsonObject = { element_type: FORMULATION_KEY[elementType] ?? elementType };
        if (elementType === "qsvms" || elementType === "dvms" || elementType === "vms") {
          formulation.use_orthogonal_subscales = asBool(v.oss, false);
        }
        if (elementType === "qsvms" && asBool(v.timeIntegrated, false)) formulation.element_manages_time_integration = true;
        if (elementType === "fic" && asNum(v.ficBeta, 0.8) !== 0.8) formulation.beta = asNum(v.ficBeta, 0.8);
        if (elementType === "weakly_compressible") formulation.sound_velocity = asNum(v.soundVelocity, 1e12);
        if (elementType === "vms" && asBool(v.nonNewtonian, false)) {
          formulation.non_newtonian_fluid_parameters = {
            power_law_k: asNum(v.powerLawK, 1e-6),
            power_law_n: asNum(v.powerLawN, 1.0),
            yield_stress: asNum(v.yieldStress, 0),
            regularization_coefficient: asNum(v.regularization, 100),
          };
        }
        formulation.dynamic_tau = asNum(v.dynamicTau, 1.0);
        settings.formulation = formulation;
        if (linear) settings.linear_solver_settings = linear;
      }
      settings.reform_dofs_at_each_step = false;
      return settings;
    },
    postProcess: (pp, ctx) => {
      // A monitor that writes a nodal result needs it in the output's non-historical list.
      const wanted = [...new Set(ctx.assignments.map((a) => MONITOR_OUTPUT[a.conditionId]).filter((n): n is string => Boolean(n)))];
      const vtk = (((pp.output_processes as JsonObject | undefined)?.vtk_output as JsonObject[] | undefined) ?? [])[0];
      if (wanted.length > 0 && vtk) {
        const parameters = vtk.Parameters as JsonObject;
        const list = Array.isArray(parameters.nodal_data_value_variables) ? [...(parameters.nodal_data_value_variables as string[])] : [];
        for (const n of wanted) if (!list.includes(n)) list.push(n);
        parameters.nodal_data_value_variables = list;
      }
      const modulus = asNum(ctx.values.gravityValue, 0);
      if (modulus === 0) return pp;
      // GiD writes gravity as its own process list on the fluid part.
      const direction = Array.isArray(ctx.values.gravityDirection) ? ctx.values.gravityDirection : [0, -1, 0];
      (pp.processes as JsonObject).gravity = [
        {
          python_module: "assign_vector_by_direction_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignVectorByDirectionProcess",
          Parameters: {
            model_part_name: ctx.partsModelParts[0] ?? ctx.modelPartName,
            variable_name: "BODY_FORCE",
            modulus,
            constrained: false,
            direction,
          },
        },
      ];
      return pp;
    },
  }
);
