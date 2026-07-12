import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase, subModelPartPaths, resolveDomainSize } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";
import { fluid } from "../problemtype/builtins/fluid";
import { convectionDiffusion } from "../problemtype/builtins/convectionDiffusion";
import { MAIN_KRATOS_PY } from "../problemtype/mainKratosTemplate";
import { CaseState } from "../problemtype/types";

// One tetrahedron (3D) with a volume part and two boundary parts.
const MDPA_3D = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
End Conditions

Begin SubModelPart Parts
  Begin SubModelPart Solid
    Begin SubModelPartNodes
    1
    2
    3
    4
    End SubModelPartNodes
    Begin SubModelPartElements
    1
    End SubModelPartElements
  End SubModelPart
End SubModelPart

Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart

Begin SubModelPart Loaded
  Begin SubModelPartNodes
  4
  End SubModelPartNodes
End SubModelPart
`;

function structuralState(): CaseState {
  const state = defaultCaseState(structural.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0], constrained: true } },
    { conditionId: "selfWeight", smpPath: "Parts/Solid", values: { modulus: 9.81, direction: [0, 0, -1] } },
  ];
  state.materials = [
    { smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2.0e11 } },
  ];
  return state;
}

test("structural static: golden ProjectParameters document", async () => {
  const model = parseMdpa(MDPA_3D);
  const out = await generateCase(structural, model, structuralState(), "beam");
  assert.deepEqual(out.warnings, []);
  const pp = JSON.parse(out.projectParameters);
  assert.deepEqual(pp, {
    analysis_stage:
      "KratosMultiphysics.StructuralMechanicsApplication.structural_mechanics_analysis",
    problem_data: {
      problem_name: "beam",
      parallel_type: "OpenMP",
      echo_level: 1,
      start_time: 0,
      end_time: 1,
    },
    solver_settings: {
      solver_type: "Static",
      model_part_name: "Structure",
      domain_size: 3,
      echo_level: 1,
      analysis_type: "linear",
      model_import_settings: { input_type: "mdpa", input_filename: "beam" },
      material_import_settings: { materials_filename: "StructuralMaterials.json" },
      time_stepping: { time_step: 0.1 },
      rotation_dofs: false,
    },
    processes: {
      constraints_process_list: [
        {
          python_module: "assign_vector_variable_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignVectorVariableProcess",
          Parameters: {
            model_part_name: "Structure.Support",
            variable_name: "DISPLACEMENT",
            interval: [0, "End"],
            constrained: [true, true, true],
            value: [0, 0, 0],
          },
        },
      ],
      loads_process_list: [
        {
          python_module: "assign_vector_by_direction_process",
          kratos_module: "KratosMultiphysics",
          process_name: "AssignVectorByDirectionProcess",
          Parameters: {
            model_part_name: "Structure.Parts.Solid",
            variable_name: "VOLUME_ACCELERATION",
            modulus: 9.81,
            constrained: false,
            direction: [0, 0, -1],
            interval: [0, "End"],
          },
        },
      ],
      list_other_processes: [],
    },
    output_processes: {
      gid_output: [],
      vtk_output: [
        {
          python_module: "vtk_output_process",
          kratos_module: "KratosMultiphysics",
          process_name: "VtkOutputProcess",
          help: "This process writes postprocessing files for Paraview",
          Parameters: {
            model_part_name: "Structure",
            output_control_type: "step",
            output_interval: 1,
            file_format: "ascii",
            output_precision: 7,
            output_sub_model_parts: false,
            output_path: "vtk_output",
            save_output_files_in_folder: true,
            nodal_solution_step_data_variables: ["DISPLACEMENT", "REACTION"],
            nodal_data_value_variables: [],
            element_data_value_variables: [],
            condition_data_value_variables: [],
            gauss_point_variables_extrapolated_to_nodes: ["VON_MISES_STRESS"],
          },
        },
      ],
    },
  });
});

test("structural: materials file carries law, merged variables and dotted part name", async () => {
  const model = parseMdpa(MDPA_3D);
  const out = await generateCase(structural, model, structuralState(), "beam");
  const mats = JSON.parse(out.materials);
  assert.equal(out.materialsFileName, "StructuralMaterials.json");
  assert.deepEqual(mats, {
    properties: [
      {
        model_part_name: "Structure.Parts.Solid",
        properties_id: 1,
        Material: {
          Variables: { DENSITY: 7850, YOUNG_MODULUS: 2.0e11, POISSON_RATIO: 0.29 },
          Tables: {},
          constitutive_law: { name: "LinearElastic3DLaw" },
        },
      },
    ],
  });
});

test("structural dynamic: solver gains the implicit bossak scheme", async () => {
  const model = parseMdpa(MDPA_3D);
  const state = structuralState();
  state.values.problem.solverType = "dynamic";
  const out = await generateCase(structural, model, state, "beam");
  const ss = JSON.parse(out.projectParameters).solver_settings;
  assert.equal(ss.solver_type, "Dynamic");
  assert.equal(ss.time_integration_method, "implicit");
  assert.equal(ss.scheme_type, "bossak");
});

test("structural: default MainKratos.py is the flush-wrapping GiD template", async () => {
  const model = parseMdpa(MDPA_3D);
  const out = await generateCase(structural, model, structuralState(), "beam");
  assert.equal(out.mainScript, MAIN_KRATOS_PY);
  assert.ok(out.mainScript.includes('parameters["analysis_stage"].GetString()'));
});

test("fluid: volume_model_part_name and skin_parts derive from the assignments", async () => {
  const model = parseMdpa(MDPA_3D);
  const state = defaultCaseState(fluid.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "inlet", smpPath: "Loaded", values: { modulus: 2.0 } },
    { conditionId: "noSlip", smpPath: "Support", values: {} },
  ];
  state.materials = [{ smpPath: "Parts/Solid", lawId: "newtonian_3d", values: {} }];
  const out = await generateCase(fluid, model, state, "cavity");
  assert.deepEqual(out.warnings, []);
  const pp = JSON.parse(out.projectParameters);
  assert.equal(pp.solver_settings.volume_model_part_name, "FluidModelPart.Parts.Solid");
  assert.deepEqual(pp.solver_settings.skin_parts, [
    "FluidModelPart.Loaded",
    "FluidModelPart.Support",
  ]);
  // inlet + noSlip both land in constraints; parts emits no process
  assert.equal(pp.processes.constraints_process_list.length, 2);
  assert.equal(pp.processes.constraints_process_list[0].Parameters.modulus, 2.0);
  assert.deepEqual(pp.processes.list_other_processes, []);
  const mats = JSON.parse(out.materials);
  assert.equal(mats.properties[0].Material.constitutive_law.name, "Newtonian3DLaw");
});

test("convection-diffusion: domain/processes sub-model-part lists + law-less materials", async () => {
  const model = parseMdpa(MDPA_3D);
  const state = defaultCaseState(convectionDiffusion.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "temperature", smpPath: "Support", values: { value: 300 } },
  ];
  state.materials = [{ smpPath: "Parts/Solid", lawId: "thermal", values: {} }];
  const out = await generateCase(convectionDiffusion, model, state, "heat");
  const pp = JSON.parse(out.projectParameters);
  assert.deepEqual(pp.solver_settings.problem_domain_sub_model_part_list, [
    "ThermalModelPart.Parts.Solid",
  ]);
  assert.deepEqual(pp.solver_settings.processes_sub_model_part_list, [
    "ThermalModelPart.Support",
  ]);
  assert.equal(pp.processes.constraints_process_list[0].Parameters.variable_name, "TEMPERATURE");
  const mats = JSON.parse(out.materials);
  // Thermal materials carry variables only — no constitutive_law block.
  assert.equal(mats.properties[0].Material.constitutive_law, undefined);
  assert.equal(mats.properties[0].Material.Variables.CONDUCTIVITY, 0.6);
});

test("generateCase warns on unknown SubModelParts, conditions and missing parts/materials", async () => {
  const model = parseMdpa(MDPA_3D);
  const state = defaultCaseState(structural.decl);
  state.assignments = [
    { conditionId: "displacement", smpPath: "Nope", values: {} },
    { conditionId: "unknownCond", smpPath: "Support", values: {} },
  ];
  const out = await generateCase(structural, model, state, "beam");
  assert.ok(out.warnings.some((w) => w.includes('"Nope" is not in the mesh')));
  assert.ok(out.warnings.some((w) => w.includes('Unknown condition "unknownCond"')));
  assert.ok(out.warnings.some((w) => w.includes("No SubModelPart assigned as Parts")));
  assert.ok(out.warnings.some((w) => w.includes("No materials assigned")));
});

test("subModelPartPaths flattens the tree depth-first", () => {
  const model = parseMdpa(MDPA_3D);
  assert.deepEqual(subModelPartPaths(model.subModelParts), [
    "Parts",
    "Parts/Solid",
    "Support",
    "Loaded",
  ]);
});

test("resolveDomainSize falls back with a warning when the mesh size is unsupported", () => {
  const model = parseMdpa(MDPA_3D); // 3D
  const warnings: string[] = [];
  assert.equal(resolveDomainSize(structural, model, warnings), 3);
  assert.deepEqual(warnings, []);
  const only2d = { ...structural, decl: { ...structural.decl, domainSizes: [2 as const] } };
  assert.equal(resolveDomainSize(only2d, model, warnings), 2);
  assert.equal(warnings.length, 1);
});
