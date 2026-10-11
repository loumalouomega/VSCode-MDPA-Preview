/**
 * Built-in Free Surface problemtype: an edge-based level-set solver for a fluid
 * with a free surface (FreeSurfaceApplication). Mirrors GiDInterface's
 * FreeSurface app (apps/FreeSurface/write/writeProjectParameters.tcl): the
 * `EdgebasedLevelset` strategy carries the fluid density and viscosity itself
 * (there is no materials file), the free surface is the nodal DISTANCE field
 * (initial condition), and the boundary conditions are the Fluid ones.
 *
 * Not solver-verified in this repository: the shape follows GiDInterface's writer.
 */

import { defineProblemtype, asBool, asNum } from "../api";
import type { JsonObject } from "../types";
import { fluid } from "./fluid";
import { INITIAL, scalarConstraint } from "./common";

const BASE = fluid.decl;
const KEEP_CONDITIONS = ["parts", "initialVelocity", "initialPressure", "inlet", "outlet", "slip", "noSlip"];

export const freeSurface = defineProblemtype(
  {
    ...BASE,
    id: "freeSurface",
    name: "Free Surface",
    description: "Edge-based level-set flow with a free surface (FreeSurfaceApplication)",
    icon: "ptFreeSurface",
    family: "fluid",
    analysisStage: "KratosMultiphysics.FreeSurfaceApplication.free_surface_analysis",
    materialsFileName: "FluidMaterials.json",
    materialLaws: [],
    // Conditions are LineCondition / SurfaceCondition blocks (GiD swaps WallCondition for them).
    meshNaming: { elements: "Element", conditions: { 2: "LineCondition", 3: "SurfaceCondition" } },
    sections: [
      {
        id: "problem",
        label: "Problem data",
        groups: [
          { id: "fluid", label: "Fluid", icon: "ptFreeSurface" },
          { id: "time", label: "Time", icon: "ptTime" },
          { id: "levelset", label: "Level set", icon: "ptSolver" },
          { id: "stabilization", label: "Stabilization", icon: "ptSolver", collapsed: true },
        ],
        fields: [
          { id: "density", label: "Density", type: "number", default: 1000, min: 0, group: "fluid", unit: "kg/m³" },
          { id: "viscosity", label: "Viscosity", type: "number", default: 1e-6, min: 0, group: "fluid", unit: "m²/s", help: "Kinematic viscosity." },
          { id: "startTime", label: "Start time", type: "number", default: 0, group: "time", unit: "s" },
          { id: "endTime", label: "End time", type: "number", default: 1.0, group: "time", unit: "s" },
          { id: "maxSafetyFactor", label: "Max. safety factor", type: "number", default: 0.1, min: 0, group: "time" },
          { id: "maxTimeStepSize", label: "Max. time step size", type: "number", default: 1e-2, min: 0, group: "time", unit: "s" },
          { id: "initialSteps", label: "Initial time steps", type: "int", default: 10, min: 0, group: "time" },
          { id: "initialTimeStepSize", label: "Initial time step size", type: "number", default: 1e-5, min: 0, group: "time", unit: "s" },
          { id: "reductionOnFailure", label: "Reduction on failure", type: "number", default: 0.3, min: 0, group: "time" },
          { id: "redistanceFrequency", label: "Redistance frequency", type: "number", default: 5, min: 0, group: "levelset" },
          { id: "extrapolationLayers", label: "Extrapolation layers", type: "number", default: 5, min: 0, group: "levelset" },
          { id: "useMassCorrection", label: "Mass correction", type: "bool", default: false, group: "levelset" },
          { id: "wallLawY", label: "Wall law y", type: "number", default: 0, min: 0, group: "levelset" },
          { id: "stabdtPressureFactor", label: "Pressure stabilization factor", type: "number", default: 1, group: "stabilization" },
          { id: "stabdtConvectionFactor", label: "Convection stabilization factor", type: "number", default: 0.01, group: "stabilization" },
          { id: "tau2Factor", label: "Tau2 factor", type: "number", default: 1, group: "stabilization" },
          { id: "assumeConstantPressure", label: "Assume constant pressure", type: "bool", default: false, group: "stabilization" },
          { id: "echoLevel", label: "Echo level", type: "int", default: 0, min: 0, max: 3, advanced: true },
        ],
      },
    ],
    conditions: [
      ...BASE.conditions.filter((c) => KEEP_CONDITIONS.includes(c.id)),
      scalarConstraint("DISTANCE", {
        id: "initialDistance",
        label: "Initial distance (free surface)",
        category: "initial",
        list: "initial_conditions_process_list",
        icon: "ptInitial",
        interval: INITIAL,
        fixed: false,
        unit: "m",
        help: "Signed distance to the free surface: negative in the fluid, positive in the air.",
      }),
    ],
    output: { nodalDefaults: ["VELOCITY", "PRESSURE", "DISTANCE"] },
  },
  {
    buildProcess: (cond, a, ctx) => fluid.buildProcess(cond, a, ctx),
    solverSettings: (v, ctx) => {
      const settings: JsonObject = {
        model_part_name: ctx.modelPartName,
        domain_size: ctx.domainSize,
        solver_type: "EdgebasedLevelset",
        model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
        echo_level: asNum(v.echoLevel, 0),
        max_safety_factor: asNum(v.maxSafetyFactor, 0.1),
        max_time_step_size: asNum(v.maxTimeStepSize, 1e-2),
        density: asNum(v.density, 1000),
        viscosity: asNum(v.viscosity, 1e-6),
        wall_law_y: asNum(v.wallLawY, 0),
        use_mass_correction: asBool(v.useMassCorrection, false),
        redistance_frequency: asNum(v.redistanceFrequency, 5),
        extrapolation_layers: asNum(v.extrapolationLayers, 5),
        number_of_initial_time_steps: asNum(v.initialSteps, 10),
        initial_time_step_size: asNum(v.initialTimeStepSize, 1e-5),
        reduction_on_failure: asNum(v.reductionOnFailure, 0.3),
        stabdt_pressure_factor: asNum(v.stabdtPressureFactor, 1),
        stabdt_convection_factor: asNum(v.stabdtConvectionFactor, 0.01),
        tau2_factor: asNum(v.tau2Factor, 1),
        assume_constant_pressure: asBool(v.assumeConstantPressure, false),
        compute_porous_resistance_law: "NONE",
      };
      return settings;
    },
  }
);

