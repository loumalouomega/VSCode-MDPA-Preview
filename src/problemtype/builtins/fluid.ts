/**
 * Built-in Fluid Dynamics (monolithic Navier-Stokes) problemtype. Output shapes
 * mirror GiDInterface's Fluid app. This is the built-in that motivates the
 * imperative hooks: volume_model_part_name / skin_parts are derived from the
 * user's assignments, which a declarative template cannot express.
 */

import { defineProblemtype, asNum } from "../api";
import { JsonObject } from "../types";

export const fluid = defineProblemtype(
  {
    id: "fluid",
    name: "Fluid Dynamics",
    description: "Incompressible Navier-Stokes, monolithic solver (FluidDynamicsApplication)",
    icon: "ptFluid",
    analysisStage: "KratosMultiphysics.FluidDynamicsApplication.fluid_dynamics_analysis",
    modelPartName: "FluidModelPart",
    materialsFileName: "FluidMaterials.json",
    domainSizes: [2, 3],
    sections: [
      {
        id: "problem",
        label: "Problem data",
        fields: [
          { id: "timeStep", label: "Time step", type: "number", default: 0.01 },
          { id: "endTime", label: "End time", type: "number", default: 1.0 },
          { id: "echoLevel", label: "Echo level", type: "int", default: 0 },
          { id: "maxIterations", label: "Max iterations", type: "int", default: 10 },
          { id: "relVelTol", label: "Rel. velocity tol.", type: "number", default: 1e-3 },
          { id: "absVelTol", label: "Abs. velocity tol.", type: "number", default: 1e-5 },
          { id: "relPresTol", label: "Rel. pressure tol.", type: "number", default: 1e-3 },
          { id: "absPresTol", label: "Abs. pressure tol.", type: "number", default: 1e-5 },
          { id: "dynamicTau", label: "Dynamic tau", type: "number", default: 1.0 },
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
      {
        id: "inlet",
        label: "Inlet velocity",
        list: "constraints_process_list",
        target: "surface",
        fields: [
          { id: "modulus", label: "|v| [m/s]", type: "number", default: 1.0 },
          {
            id: "direction",
            label: "Direction",
            type: "enum",
            default: "automatic_inwards_normal",
            options: [
              { value: "automatic_inwards_normal", label: "Inwards normal" },
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
        fields: [{ id: "value", label: "Pressure [Pa]", type: "number", default: 0 }],
        processTemplate: {
          python_module: "apply_outlet_process",
          kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
          Parameters: {
            model_part_name: "$path",
            variable_name: "PRESSURE",
            constrained: true,
            value: "$field:value",
            hydrostatic_outlet: false,
            h_top: 0.0,
          },
        },
      },
      {
        id: "slip",
        label: "Slip wall",
        list: "constraints_process_list",
        target: "surface",
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
        fields: [],
        processTemplate: {
          python_module: "apply_noslip_process",
          kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
          Parameters: { model_part_name: "$path" },
        },
      },
    ],
    materialLaws: [
      {
        id: "newtonian_3d",
        name: "Newtonian3DLaw",
        domainSize: 3,
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 1000 },
          { id: "DYNAMIC_VISCOSITY", label: "Dynamic viscosity [Pa·s]", type: "number", default: 1e-3 },
        ],
      },
      {
        id: "newtonian_2d",
        name: "Newtonian2DLaw",
        domainSize: 2,
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 1000 },
          { id: "DYNAMIC_VISCOSITY", label: "Dynamic viscosity [Pa·s]", type: "number", default: 1e-3 },
        ],
      },
    ],
    output: { nodalDefaults: ["VELOCITY", "PRESSURE"] },
  },
  {
    solverSettings: (v, ctx) => {
      const settings: JsonObject = {
        model_part_name: ctx.modelPartName,
        domain_size: ctx.domainSize,
        solver_type: "Monolithic",
        model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
        material_import_settings: { materials_filename: ctx.materialsFileName },
        echo_level: asNum(v.echoLevel, 0),
        compute_reactions: false,
        maximum_iterations: asNum(v.maxIterations, 10),
        relative_velocity_tolerance: asNum(v.relVelTol, 1e-3),
        absolute_velocity_tolerance: asNum(v.absVelTol, 1e-5),
        relative_pressure_tolerance: asNum(v.relPresTol, 1e-3),
        absolute_pressure_tolerance: asNum(v.absPresTol, 1e-5),
        // Derived from the assignments — the reason this is a hook, not a template.
        volume_model_part_name: ctx.partsModelParts[0] ?? ctx.modelPartName,
        skin_parts: ctx.skinModelParts,
        no_skin_parts: [],
        time_stepping: { automatic_time_step: false, time_step: asNum(v.timeStep, 0.01) },
        formulation: {
          element_type: "vms",
          use_orthogonal_subscales: false,
          dynamic_tau: asNum(v.dynamicTau, 1.0),
        },
      };
      return settings;
    },
  }
);
