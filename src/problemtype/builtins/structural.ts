/**
 * Built-in Structural Mechanics problemtype. Output shapes mirror what
 * GiDInterface's Structural app writes (apps/Structural/write/writeProjectParameters.tcl).
 */

import { defineProblemtype, asNum, asStr, asBool, dottedModelPart } from "../api";
import { JsonObject, JsonValue } from "../types";

export const structural = defineProblemtype(
  {
    id: "structural",
    name: "Structural Mechanics",
    description: "Static / dynamic solid mechanics (StructuralMechanicsApplication)",
    analysisStage:
      "KratosMultiphysics.StructuralMechanicsApplication.structural_mechanics_analysis",
    modelPartName: "Structure",
    materialsFileName: "StructuralMaterials.json",
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
            default: "static",
            options: [
              { value: "static", label: "Static" },
              { value: "dynamic", label: "Dynamic" },
            ],
          },
          {
            id: "analysisType",
            label: "Linearity",
            type: "enum",
            default: "linear",
            options: [
              { value: "linear", label: "Linear" },
              { value: "non_linear", label: "Non-linear" },
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
        label: "Body / Parts",
        list: "list_other_processes",
        target: "volume",
        fields: [],
        processTemplate: {},
        help: "Marks a SubModelPart as computing domain; assign a material to it.",
      },
      {
        id: "displacement",
        label: "Displacement",
        list: "constraints_process_list",
        target: "any",
        fields: [
          { id: "value", label: "Value [ux, uy, uz]", type: "vector3", default: [0, 0, 0] },
          { id: "constrained", label: "Fixed", type: "bool", default: true },
        ],
        // constrained is broadcast to per-component form by the buildProcess hook.
        processTemplate: {
          python_module: "assign_vector_variable_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignVectorVariableProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "DISPLACEMENT",
            interval: [0.0, "End"],
            constrained: "$field:constrained",
            value: "$field:value",
          },
        },
      },
      {
        id: "selfWeight",
        label: "Self weight",
        list: "loads_process_list",
        target: "volume",
        fields: [
          { id: "modulus", label: "Modulus [m/s²]", type: "number", default: 9.81 },
          { id: "direction", label: "Direction", type: "vector3", default: [0, 0, -1] },
        ],
        processTemplate: {
          python_module: "assign_vector_by_direction_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignVectorByDirectionProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "VOLUME_ACCELERATION",
            modulus: "$field:modulus",
            constrained: false,
            direction: "$field:direction",
            interval: [0.0, "End"],
          },
        },
      },
      {
        id: "pointLoad",
        label: "Point load",
        list: "loads_process_list",
        target: "nodes",
        fields: [
          { id: "modulus", label: "Modulus [N]", type: "number", default: 0 },
          { id: "direction", label: "Direction", type: "vector3", default: [0, 0, -1] },
        ],
        processTemplate: {
          python_module: "assign_vector_by_direction_to_condition_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignVectorByDirectionToConditionProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "POINT_LOAD",
            modulus: "$field:modulus",
            direction: "$field:direction",
            interval: [0.0, "End"],
          },
        },
      },
      {
        id: "surfacePressure",
        label: "Surface pressure",
        list: "loads_process_list",
        target: "surface",
        fields: [{ id: "value", label: "Pressure [Pa]", type: "number", default: 0 }],
        processTemplate: {
          python_module: "assign_scalar_variable_to_conditions_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignScalarVariableToConditionsProcess",
          Parameters: {
            model_part_name: "$path",
            variable_name: "POSITIVE_FACE_PRESSURE",
            value: "$field:value",
            interval: [0.0, "End"],
          },
        },
      },
    ],
    materialLaws: [
      {
        id: "linear_elastic_3d",
        name: "LinearElastic3DLaw",
        domainSize: 3,
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 7850 },
          { id: "YOUNG_MODULUS", label: "Young modulus [Pa]", type: "number", default: 2.1e11 },
          { id: "POISSON_RATIO", label: "Poisson ratio", type: "number", default: 0.29 },
        ],
      },
      {
        id: "linear_elastic_plane_strain",
        name: "LinearElasticPlaneStrain2DLaw",
        domainSize: 2,
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 7850 },
          { id: "YOUNG_MODULUS", label: "Young modulus [Pa]", type: "number", default: 2.1e11 },
          { id: "POISSON_RATIO", label: "Poisson ratio", type: "number", default: 0.29 },
          { id: "THICKNESS", label: "Thickness [m]", type: "number", default: 1.0 },
        ],
      },
      {
        id: "linear_elastic_plane_stress",
        name: "LinearElasticPlaneStress2DLaw",
        domainSize: 2,
        variables: [
          { id: "DENSITY", label: "Density [kg/m³]", type: "number", default: 7850 },
          { id: "YOUNG_MODULUS", label: "Young modulus [Pa]", type: "number", default: 2.1e11 },
          { id: "POISSON_RATIO", label: "Poisson ratio", type: "number", default: 0.29 },
          { id: "THICKNESS", label: "Thickness [m]", type: "number", default: 1.0 },
        ],
      },
    ],
    output: { nodalDefaults: ["DISPLACEMENT", "REACTION"], gaussDefaults: ["VON_MISES_STRESS"] },
  },
  {
    solverSettings: (v, ctx) => {
      const dynamic = v.solverType === "dynamic";
      const settings: JsonObject = {
        solver_type: dynamic ? "Dynamic" : "Static",
        model_part_name: ctx.modelPartName,
        domain_size: ctx.domainSize,
        echo_level: asNum(v.echoLevel, 1),
        analysis_type: asStr(v.analysisType, "linear"),
        model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
        material_import_settings: { materials_filename: ctx.materialsFileName },
        time_stepping: { time_step: asNum(v.timeStep, 0.1) },
        rotation_dofs: false,
      };
      if (dynamic) {
        settings.time_integration_method = "implicit";
        settings.scheme_type = "bossak";
      }
      return settings;
    },
    buildProcess: (cond, a, ctx) => {
      // Only displacement needs code (per-component constrained broadcast);
      // returning undefined lets every other condition use its template.
      if (cond.id !== "displacement") return undefined;
      const fixed = asBool(a.values.constrained as JsonValue, true);
      const value = Array.isArray(a.values.value) ? a.values.value : [0, 0, 0];
      return {
        python_module: "assign_vector_variable_process",
        kratos_module: "KratosMultiphysics",
        process_name: "AssignVectorVariableProcess",
        Parameters: {
          model_part_name: dottedModelPart(ctx.modelPartName, a.smpPath),
          variable_name: "DISPLACEMENT",
          interval: [0.0, "End"],
          constrained: [fixed, fixed, fixed],
          value,
        },
      };
    },
  }
);
