/**
 * Built-in Potential Flow problemtype (CompressiblePotentialFlowApplication).
 * Mirrors GiDInterface's PotentialFluid app, which reuses the Fluid solver
 * dict minus time stepping: the solver replaces the generic mdpa elements with
 * potential-flow elements per formulation.element_type. No materials — the
 * free-stream state rides on the far-field process.
 */

import { defineProblemtype, asNum, asStr } from "../api";
import { JsonObject } from "../types";

export const potentialFlow = defineProblemtype(
  {
    id: "potentialFlow",
    name: "Potential Flow",
    description:
      "Incompressible / compressible potential flow around bodies (CompressiblePotentialFlowApplication)",
    icon: "ptPotentialFlow",
    analysisStage:
      "KratosMultiphysics.CompressiblePotentialFlowApplication.potential_flow_analysis",
    modelPartName: "FluidModelPart",
    materialsFileName: "FluidMaterials.json",
    domainSizes: [2, 3],
    sections: [
      {
        id: "problem",
        label: "Problem data",
        fields: [
          {
            id: "formulation",
            label: "Formulation",
            type: "enum",
            default: "incompressible",
            options: [
              { value: "incompressible", label: "Incompressible" },
              { value: "compressible", label: "Compressible" },
            ],
          },
          { id: "echoLevel", label: "Echo level", type: "int", default: 0 },
          { id: "maxIterations", label: "Max iterations", type: "int", default: 10 },
        ],
      },
    ],
    partsCondition: "parts",
    meshNaming: {
      elements: "Element",
      conditions: { 2: "LineCondition", 3: "SurfaceCondition" },
    },
    conditions: [
      {
        id: "parts",
        label: "Fluid domain",
        list: "list_other_processes",
        target: "volume",
        fields: [],
        processTemplate: {},
        help: "Marks a SubModelPart as the flow domain.",
      },
      {
        id: "farField",
        label: "Far field",
        list: "constraints_process_list",
        target: "surface",
        fields: [
          { id: "angleOfAttack", label: "Angle of attack [rad]", type: "number", default: 0.0 },
          { id: "machInfinity", label: "Mach ∞", type: "number", default: 0.03 },
          { id: "speedOfSound", label: "Speed of sound [m/s]", type: "number", default: 340.0 },
        ],
        processTemplate: {
          python_module: "apply_far_field_process",
          kratos_module: "KratosMultiphysics.CompressiblePotentialFlowApplication",
          process_name: "FarFieldProcess",
          Parameters: {
            model_part_name: "$path",
            angle_of_attack: "$field:angleOfAttack",
            mach_infinity: "$field:machInfinity",
            speed_of_sound: "$field:speedOfSound",
          },
        },
      },
      {
        id: "body2d",
        label: "Body / wake (2D)",
        list: "list_other_processes",
        target: "surface",
        fields: [{ id: "epsilon", label: "Wake ε", type: "number", default: 1e-9 }],
        processTemplate: {
          python_module: "define_wake_process_2d",
          kratos_module: "KratosMultiphysics.CompressiblePotentialFlowApplication",
          process_name: "DefineWakeProcess2D",
          Parameters: {
            model_part_name: "$path",
            epsilon: "$field:epsilon",
          },
        },
        help: "The body boundary whose trailing edge sheds the wake (2D cases).",
      },
    ],
    materialLaws: [],
    output: { nodalDefaults: ["VELOCITY_POTENTIAL", "AUXILIARY_VELOCITY_POTENTIAL"] },
  },
  {
    solverSettings: (v, ctx) => {
      const settings: JsonObject = {
        model_part_name: ctx.modelPartName,
        domain_size: ctx.domainSize,
        solver_type: "potential_flow",
        model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
        formulation: { element_type: asStr(v.formulation, "incompressible") },
        maximum_iterations: asNum(v.maxIterations, 10),
        echo_level: asNum(v.echoLevel, 0),
        volume_model_part_name: ctx.partsModelParts[0] ?? ctx.modelPartName,
        skin_parts: ctx.skinModelParts,
        no_skin_parts: [],
      };
      return settings;
    },
  }
);
