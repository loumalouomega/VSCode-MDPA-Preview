import { monitoredMainScript } from "../mainKratosTemplate";
/**
 * Built-in Potential Flow problemtype (CompressiblePotentialFlowApplication).
 * Mirrors GiDInterface's PotentialFluid app, which reuses the Fluid solver
 * dict minus time stepping: the solver replaces the generic mdpa elements with
 * potential-flow elements per formulation.element_type. No materials — the
 * free-stream state rides on the far-field process.
 *
 * Differences from GiDInterface kept on purpose: the far field is written with
 * `apply_far_field_and_wake_process` (the process the installed Kratos ships;
 * GiD still names the older `apply_far_field_process`), and GiD's 3D wake / wing
 * tip / 3D body entries are not offered because GiD itself only writes a
 * `placeholder_process` for them — there is no 3D wake process to configure.
 */

import { defineProblemtype, asNum, asStr } from "../api";
import { JsonObject } from "../types";
import { linearSolverFields, linearSolverSettings } from "./common";

export const potentialFlow = defineProblemtype(
  {
    id: "potentialFlow",
    name: "Potential Flow",
    description:
      "Incompressible / compressible potential flow around bodies (CompressiblePotentialFlowApplication)",
    icon: "ptPotentialFlow",
    family: "fluid",
    analysisStage:
      "KratosMultiphysics.CompressiblePotentialFlowApplication.potential_flow_analysis",
    modelPartName: "FluidModelPart",
    materialsFileName: "FluidMaterials.json",
    domainSizes: [2, 3],
    sections: [
      {
        id: "problem",
        label: "Problem data",
        groups: [
          { id: "formulation", label: "Formulation", icon: "ptSolver" },
          { id: "convergence", label: "Convergence", icon: "ptSolver" },
          { id: "linear", label: "Linear solver", icon: "ptSolver", collapsed: true },
        ],
        fields: [
          {
            id: "formulation",
            label: "Formulation",
            type: "enum",
            default: "incompressible",
            group: "formulation",
            options: [
              { value: "incompressible", label: "Incompressible" },
              { value: "compressible", label: "Compressible" },
            ],
          },
          { id: "maxIterations", label: "Max iterations", type: "int", default: 10, min: 1, group: "convergence" },
          ...linearSolverFields("linear"),
          { id: "echoLevel", label: "Echo level", type: "int", default: 0, min: 0, max: 3, advanced: true },
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
        category: "constraints",
        icon: "ptConstraint",
        fields: [
          { id: "angleOfAttack", label: "Angle of attack [rad]", type: "number", default: 0.0 },
          { id: "machInfinity", label: "Mach ∞", type: "number", default: 0.03 },
          { id: "speedOfSound", label: "Speed of sound [m/s]", type: "number", default: 340.0 },
        ],
        processTemplate: {
          python_module: "apply_far_field_and_wake_process",
          kratos_module: "KratosMultiphysics.CompressiblePotentialFlowApplication",
          process_name: "ApplyFarFieldAndWakeProcess",
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
        category: "other",
        icon: "ptSolver",
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
    mainScript: () => monitoredMainScript("potentialFlow"),
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
      const linear = linearSolverSettings(v);
      if (linear) settings.linear_solver_settings = linear;
      return settings;
    },
  }
);
