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

const MONOLITHIC = { field: "strategy", equals: "monolithic" };
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
            ],
          },
          {
            id: "timeScheme",
            label: "Time scheme",
            type: "enum",
            default: "bdf2",
            group: "formulation",
            visibleWhen: MONOLITHIC,
            options: [
              { value: "bdf2", label: "BDF2" },
              { value: "bossak", label: "Bossak" },
            ],
          },
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
    ],
    output: { nodalDefaults: ["VELOCITY", "PRESSURE"] },
  },
  {
    buildProcess: (cond, a, ctx) => {
      if (cond.id === "inlet") {
        const result = resolveProcessTemplate(cond, a, ctx);
        const params = result.Parameters as JsonObject;
        const direction = a.values.direction;
        if (direction === "x") params.direction = [1, 0, 0];
        if (direction === "y") params.direction = [0, 1, 0];
        if (direction === "z") params.direction = [0, 0, 1];
        return result;
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
    solverSettings: (v, ctx) => {
      const fractional = v.strategy === "fractional_step";
      // skin_parts / no_skin_parts split the assignments by whether the
      // condition is a boundary skin (GiD's SkinConditions attribute).
      const skin: string[] = [];
      const noSkin: string[] = [];
      for (const a of ctx.assignments) {
        if (a.conditionId === "parts" || a.conditionId.startsWith("initial")) continue;
        (NO_SKIN.has(a.conditionId) ? noSkin : skin).push(dottedModelPart(ctx.modelPartName, a.smpPath));
      }
      const settings: JsonObject = {
        model_part_name: ctx.modelPartName,
        domain_size: ctx.domainSize,
        solver_type: fractional ? "FractionalStep" : "Monolithic",
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
                time_step: asNum(v.timeStep, 0.01),
              }
            : { automatic_time_step: false, time_step: asNum(v.timeStep, 0.01) },
      };
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
        if (linear) {
          settings.velocity_linear_solver_settings = { ...linear };
          settings.pressure_linear_solver_settings = { ...linear };
        }
      } else {
        const elementType = asStr(v.elementType, "qsvms");
        settings.maximum_iterations = asNum(v.maxIterations, 10);
        settings.relative_velocity_tolerance = asNum(v.relVelTol, 1e-3);
        settings.absolute_velocity_tolerance = asNum(v.absVelTol, 1e-5);
        settings.relative_pressure_tolerance = asNum(v.relPresTol, 1e-3);
        settings.absolute_pressure_tolerance = asNum(v.absPresTol, 1e-5);
        settings.time_scheme = asStr(v.timeScheme, "bdf2");
        const formulation: JsonObject = { element_type: elementType };
        // Only the VMS family has an orthogonal-subscales switch (GiD checks the same).
        if (elementType === "qsvms" || elementType === "dvms" || elementType === "vms") {
          formulation.use_orthogonal_subscales = asBool(v.oss, false);
        }
        formulation.dynamic_tau = asNum(v.dynamicTau, 1.0);
        settings.formulation = formulation;
        if (linear) settings.linear_solver_settings = linear;
      }
      settings.reform_dofs_at_each_step = false;
      return settings;
    },
    postProcess: (pp, ctx) => {
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
