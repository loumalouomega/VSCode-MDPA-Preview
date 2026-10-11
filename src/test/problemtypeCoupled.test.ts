import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase, domainProblems, buildGenContext } from "../problemtype/generate";
import { planCaseMesh } from "../problemtype/caseMesh";
import { defaultCaseState, validateDeclaration } from "../problemtype/api";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { catalogGroups, groupConditions } from "../problemtype/layout";
import { compressibleFluid } from "../problemtype/builtins/compressibleFluid";
import { embeddedFluid } from "../problemtype/builtins/embeddedFluid";
import { freeSurface } from "../problemtype/builtins/freeSurface";
import { buoyancy } from "../problemtype/builtins/buoyancy";
import { fsi } from "../problemtype/builtins/fsi";
import { conjugateHeatTransfer } from "../problemtype/builtins/conjugateHeatTransfer";
import { CaseState } from "../problemtype/types";

// Two tetrahedra — a fluid one and a solid one — with an interface face on each.
const MDPA = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
5 0.0 0.0 0.0
6 1.0 0.0 0.0
7 0.0 1.0 0.0
8 0.0 0.0 -1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
2 0 5 6 7 8
End Elements

Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
2 0 5 6 7
End Conditions

Begin SubModelPart Fluid
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

Begin SubModelPart Solid
  Begin SubModelPartNodes
  5
  6
  7
  8
  End SubModelPartNodes
  Begin SubModelPartElements
  2
  End SubModelPartElements
End SubModelPart

Begin SubModelPart FluidWall
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart

Begin SubModelPart SolidWall
  Begin SubModelPartNodes
  5
  6
  7
  End SubModelPartNodes
  Begin SubModelPartConditions
  2
  End SubModelPartConditions
End SubModelPart

Begin SubModelPart Inlet
  Begin SubModelPartNodes
  4
  End SubModelPartNodes
End SubModelPart
`;

test("every built-in is a valid, grouped declaration", () => {
  assert.ok(BUILTIN_PROBLEMTYPES.length >= 12);
  for (const r of BUILTIN_PROBLEMTYPES) {
    assert.deepEqual(validateDeclaration(r.decl), [], r.decl.id);
    assert.ok(r.decl.family, `${r.decl.id} has a family`);
  }
  const ids = new Set(BUILTIN_PROBLEMTYPES.map((r) => r.decl.id));
  assert.equal(ids.size, BUILTIN_PROBLEMTYPES.length, "ids are unique");
  const groups = catalogGroups(BUILTIN_PROBLEMTYPES.map((r) => ({ decl: r.decl })));
  assert.deepEqual(groups.map((g) => g.id), ["solid", "fluid", "thermal", "coupled", "workflow"]);
});

test("compressible fluid: explicit solver, shock capturing and conservative initial conditions", async () => {
  const model = parseMdpa(MDPA);
  const state = defaultCaseState(compressibleFluid.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Fluid", values: {} },
    { conditionId: "initialDensity", smpPath: "Fluid", values: { value: 1.2 } },
    { conditionId: "slip", smpPath: "FluidWall", values: {} },
    { conditionId: "densityBC", smpPath: "Inlet", values: { value: 2 } },
  ];
  state.materials = [{ smpPath: "Fluid", lawId: "newtonian_2d", values: {} }];
  const out = await generateCase(compressibleFluid, model, state, "shock");
  const pp = JSON.parse(out.projectParameters);
  assert.equal(pp.solver_settings.solver_type, "CompressibleExplicit");
  assert.equal(pp.solver_settings.time_scheme, "RK4");
  assert.deepEqual(pp.solver_settings.shock_capturing_settings, { type: "physics_based" });
  assert.deepEqual(pp.solver_settings.no_skin_parts, ["FluidModelPart.Inlet"]);
  assert.deepEqual(pp.solver_settings.skin_parts, ["FluidModelPart.FluidWall"]);
  assert.equal(pp.processes.initial_conditions_process_list[0].Parameters.variable_name, "DENSITY");
  assert.equal(JSON.parse(out.materials).properties[0].Material.Variables.HEAT_CAPACITY_RATIO, 1.4);
});

test("embedded fluid: embedded formulation, distance reading and its auxiliary processes", async () => {
  const model = parseMdpa(MDPA);
  const state = defaultCaseState(embeddedFluid.decl);
  state.assignments = [{ conditionId: "parts", smpPath: "Fluid", values: {} }, { conditionId: "noSlip", smpPath: "FluidWall", values: {} }];
  state.materials = [{ smpPath: "Fluid", lawId: "newtonian_3d", values: {} }];
  Object.assign(state.values.problem, { isSlip: true, computeDrag: true, meshAdaptivity: true, distanceMode: "from_GiD_file", distanceFile: "dist.post.res" });
  const pp = JSON.parse((await generateCase(embeddedFluid, model, state, "emb")).projectParameters);
  assert.equal(pp.solver_settings.formulation.element_type, "embedded_navier_stokes");
  assert.equal(pp.solver_settings.formulation.is_slip, true);
  assert.equal(pp.solver_settings.formulation.slip_length, 0.001);
  assert.equal(pp.solver_settings.compute_reactions, true);
  assert.deepEqual(pp.solver_settings.distance_reading_settings, { import_mode: "from_GiD_file", distance_file_name: "dist.post.res" });
  assert.equal(pp.problem_data.mesh_adaptivity, true);
  assert.equal(pp.processes.mesh_adaptivity_process_list[0].process_name, "MmgProcess");
  assert.deepEqual(pp.processes.auxiliar_process_list.map((p: { process_name: string }) => p.process_name), ["ApplyDistanceModificationProcess", "ComputeEmbeddedDragProcess"]);
  assert.equal(pp.solver_settings.time_scheme, "bdf2");
});

test("free surface: edge-based level set with the fluid inline and no materials", async () => {
  const model = parseMdpa(MDPA);
  const state = defaultCaseState(freeSurface.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Fluid", values: {} },
    { conditionId: "initialDistance", smpPath: "Fluid", values: { value: -0.5 } },
  ];
  const out = await generateCase(freeSurface, model, state, "dam");
  const pp = JSON.parse(out.projectParameters);
  assert.equal(pp.analysis_stage, "KratosMultiphysics.FreeSurfaceApplication.free_surface_analysis");
  assert.equal(pp.solver_settings.solver_type, "EdgebasedLevelset");
  assert.equal(pp.solver_settings.density, 1000);
  assert.equal(pp.solver_settings.compute_porous_resistance_law, "NONE");
  assert.equal(pp.processes.initial_conditions_process_list[0].Parameters.variable_name, "DISTANCE");
  assert.deepEqual(out.warnings, []);
});

test("buoyancy: thermally-coupled nested settings, Boussinesq process and two materials files", async () => {
  const model = parseMdpa(MDPA);
  const state = defaultCaseState(buoyancy.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Fluid", values: {} },
    { conditionId: "noSlip", smpPath: "FluidWall", values: {} },
    { conditionId: "t_temperature", smpPath: "FluidWall", values: { value: 350 } },
  ];
  state.materials = [{ smpPath: "Fluid", lawId: "newtonian_3d", values: {} }];
  const out = await generateCase(buoyancy, model, state, "cavity");
  const pp = JSON.parse(out.projectParameters);
  assert.equal(pp.analysis_stage, "KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis");
  assert.equal(pp.solver_settings.solver_type, "ThermallyCoupled");
  assert.equal(pp.solver_settings.fluid_solver_settings.solver_type, "Monolithic");
  assert.deepEqual(pp.solver_settings.fluid_solver_settings.model_import_settings, { input_type: "use_input_model_part" });
  assert.equal(pp.solver_settings.thermal_solver_settings.material_import_settings.materials_filename, "BuoyancyMaterials.json");
  assert.deepEqual(pp.solver_settings.thermal_solver_settings.problem_domain_sub_model_part_list, ["ThermalModelPart.Fluid"]);
  const constraints = pp.processes.constraints_process_list.map((p: { process_name: string }) => p.process_name);
  assert.ok(constraints.includes("ApplyBoussinesqForceProcess"));
  assert.ok(constraints.includes("AssignScalarVariableProcess"));
  assert.equal(pp.processes.initial_conditions_process_list, undefined);
  const extra = out.extraFiles.find((f) => f.name === "BuoyancyMaterials.json");
  assert.ok(extra, "the second materials file is written");
  const doc = JSON.parse(extra!.content);
  assert.equal(doc.properties.length, 1);
  assert.equal(doc.properties[0].model_part_name, "ThermalModelPart");
  assert.equal(doc.properties[0].Material.Variables.CONDUCTIVITY, 0.024);
});

function fsiState(): CaseState {
  const state = defaultCaseState(fsi.decl);
  state.assignments = [
    { conditionId: "f_parts", smpPath: "Fluid", values: {} },
    { conditionId: "f_inlet", smpPath: "Inlet", values: { modulus: 2 } },
    { conditionId: "fluidInterface", smpPath: "FluidWall", values: { mapperFace: "positive" } },
    { conditionId: "s_parts", smpPath: "Solid", values: {} },
    { conditionId: "s_displacement", smpPath: "SolidWall", values: {} },
    { conditionId: "structureInterface", smpPath: "SolidWall", values: {} },
  ];
  state.materials = [
    { smpPath: "Fluid", lawId: "newtonian_3d", values: {} },
    { smpPath: "Solid", lawId: "linear_elastic_3d", values: {} },
  ];
  return state;
}

test("fsi: one ProjectParameters with nested physics, per-physics lists and two materials files", async () => {
  const model = parseMdpa(MDPA);
  const out = await generateCase(fsi, model, fsiState(), "flap");
  const pp = JSON.parse(out.projectParameters);
  assert.equal(pp.analysis_stage, "KratosMultiphysics.FSIApplication.fsi_analysis");
  const ss = pp.solver_settings;
  assert.equal(ss.solver_type, "Partitioned");
  assert.equal(ss.coupling_scheme, "DirichletNeumann");
  assert.equal(ss.fluid_solver_settings.model_import_settings.input_filename, "flap_Fluid");
  assert.equal(ss.structure_solver_settings.model_import_settings.input_filename, "flap_Structural");
  assert.equal(ss.fluid_solver_settings.model_part_name, "FluidModelPart");
  assert.equal(ss.structure_solver_settings.model_part_name, "Structure");
  assert.deepEqual(ss.structure_solver_settings.time_stepping, ss.fluid_solver_settings.time_stepping);
  assert.deepEqual(ss.coupling_settings.fluid_interfaces_list, ["FluidModelPart.FluidWall"]);
  assert.deepEqual(ss.coupling_settings.structure_interfaces_list, ["Structure.SolidWall"]);
  assert.deepEqual(ss.coupling_settings.mapper_settings, [
    { mapper_face: "positive", fluid_interface_submodelpart_name: "FluidModelPart.FluidWall", structure_interface_submodelpart_name: "Structure.SolidWall" },
  ]);
  assert.deepEqual(ss.coupling_settings.coupling_strategy_settings, { solver_type: "Relaxation", w_0: 0.825, acceleration_type: "Aitken" });
  assert.equal(ss.mesh_solver_settings.solver_type, "structural_similarity");
  // The interface marks parts for the settings; it is not a process.
  assert.equal(pp.processes.fluid_boundary_conditions_process_list.length, 1);
  assert.equal(pp.processes.fluid_boundary_conditions_process_list[0].Parameters.model_part_name, "FluidModelPart.Inlet");
  assert.equal(pp.processes.structure_constraints_process_list[0].Parameters.model_part_name, "Structure.SolidWall");
  assert.deepEqual(pp.processes.structure_constraints_process_list[0].Parameters.constrained, [true, true, true]);
  assert.deepEqual(ss.fluid_solver_settings.skin_parts, ["FluidModelPart.Inlet", "FluidModelPart.FluidWall"]);
  assert.equal(pp.processes.constraints_process_list, undefined);
  assert.equal(pp.output_processes.vtk_output.length, 2);
  assert.equal(pp.output_processes.vtk_output[1].Parameters.model_part_name, "Structure");
  // One materials file per physics, each against its own root model part.
  assert.equal(out.materialsFileName, "FluidMaterials.json");
  assert.equal(JSON.parse(out.materials).properties[0].model_part_name, "FluidModelPart.Fluid");
  const structure = out.extraFiles.find((f) => f.name === "StructuralMaterials.json");
  assert.equal(JSON.parse(structure!.content).properties[0].model_part_name, "Structure.Solid");
});

test("fsi: a missing or unbalanced interface refuses generation, naming what to fix", async () => {
  const model = parseMdpa(MDPA);
  const state = fsiState();
  state.assignments = state.assignments.filter((a) => a.conditionId !== "fluidInterface");
  await assert.rejects(() => generateCase(fsi, model, state, "flap"), /FSI fluid interface/);
  assert.match(domainProblems(fsi.decl, state.assignments).join("|"), /Domain "Fluid"/);

  const unbalanced = fsiState();
  unbalanced.assignments.push({ conditionId: "fluidInterface", smpPath: "Inlet", values: {} });
  await assert.rejects(() => generateCase(fsi, model, unbalanced, "flap"), /2 fluid vs 1 structure/);
  const ctx = buildGenContext(fsi, model, unbalanced, "flap", []);
  assert.equal((await fsi.validate(ctx)).length, 1);

  const noParts = fsiState();
  noParts.assignments = noParts.assignments.filter((a) => a.conditionId !== "s_parts");
  await assert.rejects(() => generateCase(fsi, model, noParts, "flap"), /Domain "Structure" has no computing part/);
});

test("fsi: the source mesh is sliced into one mesh per physics, paths preserved", () => {
  const model = parseMdpa(MDPA);
  const plan = planCaseMesh(fsi, model, fsiState(), "flap", true);
  assert.equal(plan.shouldWriteMesh, false);
  assert.deepEqual(plan.domainMeshes.map((m) => m.stem), ["flap_Fluid", "flap_Structural"]);
  const [fluidMesh, structureMesh] = plan.domainMeshes.map((m) => m.model);
  const elementIds = (m: typeof fluidMesh) => m.blocks.filter((b) => b.kind === "Elements").flatMap((b) => [...b.entityIds]);
  assert.deepEqual(elementIds(fluidMesh), [1]);
  assert.deepEqual(elementIds(structureMesh), [2]);
  assert.deepEqual(fluidMesh.subModelParts.map((p) => p.path).sort(), ["Fluid", "FluidWall", "Inlet"]);
  assert.deepEqual(structureMesh.subModelParts.map((p) => p.path).sort(), ["Solid", "SolidWall"]);
  // The fluid solver replaces elements itself; the structure's are renamed by its formulation.
  assert.ok(fluidMesh.blocks.some((b) => b.kind === "Elements" && b.name.startsWith("Element")));
  assert.ok(structureMesh.blocks.some((b) => b.kind === "Elements" && b.name.startsWith("SmallDisplacementElement")));
});

test("conditions of a coupled problemtype are grouped per physics", () => {
  const branches = groupConditions(fsi.decl).map((b) => b.label);
  assert.ok(branches.includes("Fluid · Boundary conditions"));
  assert.ok(branches.includes("Structure · Loads"));
  assert.ok(!branches.some((l) => /parts/i.test(l)));
});

function chtState(): CaseState {
  const state = defaultCaseState(conjugateHeatTransfer.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Fluid", values: {} },
    { conditionId: "fluidThermalInterface", smpPath: "FluidWall", values: {} },
    { conditionId: "s_parts", smpPath: "Solid", values: {} },
    { conditionId: "solidThermalInterface", smpPath: "SolidWall", values: {} },
    { conditionId: "s_temperature", smpPath: "SolidWall", values: { value: 350 } },
  ];
  state.materials = [
    { smpPath: "Fluid", lawId: conjugateHeatTransfer.decl.materialLaws.find((l) => l.domain === "fluid")!.id, values: {} },
    { smpPath: "Solid", lawId: "solid_thermal", values: { CONDUCTIVITY: 50 } },
  ];
  return state;
}

test("conjugate heat transfer: fluid and solid domains, modelers and coupling interfaces", async () => {
  const model = parseMdpa(MDPA);
  const out = await generateCase(conjugateHeatTransfer, model, chtState(), "plate");
  const pp = JSON.parse(out.projectParameters);
  assert.equal(pp.analysis_stage, "KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis");
  const ss = pp.solver_settings;
  assert.equal(ss.solver_type, "conjugate_heat_transfer");
  assert.equal(ss.fluid_domain_solver_settings.solver_type, "ThermallyCoupled");
  assert.equal(ss.fluid_domain_solver_settings.thermal_solver_settings.model_part_name, "FluidThermalModelPart");
  assert.equal(ss.solid_domain_solver_settings.thermal_solver_settings.model_part_name, "ThermalModelPart");
  assert.deepEqual(ss.coupling_settings.fluid_interfaces_list, ["FluidThermalModelPart.FluidWall"]);
  assert.deepEqual(ss.coupling_settings.solid_interfaces_list, ["ThermalModelPart.SolidWall"]);
  assert.equal(ss.coupling_settings.max_iteration, 10);
  // GiD imports both meshes through modelers and copies the fluid connectivity for its thermal solver.
  assert.deepEqual(pp.modelers.map((m: { name: string }) => m.name.split(".").pop()), ["ImportMDPAModeler", "ImportMDPAModeler", "ConnectivityPreserveModeler"]);
  assert.equal(pp.modelers[0].parameters.input_filename, "plate_Fluid");
  assert.equal(pp.modelers[1].parameters.input_filename, "plate_Solid");
  // Fluid thermal processes act on the thermal copy; solid ones stay in their own lists.
  const fluidIface = pp.processes.fluid_constraints_process_list.find((p: { python_module: string }) => p.python_module === "apply_thermal_face_process");
  assert.equal(fluidIface.Parameters.model_part_name, "FluidThermalModelPart.FluidWall");
  assert.ok(pp.processes.fluid_constraints_process_list.some((p: { process_name: string }) => p.process_name === "ApplyBoussinesqForceProcess"));
  const solid = pp.processes.solid_constraints_process_list;
  assert.deepEqual(solid.map((p: { Parameters: { model_part_name: string } }) => p.Parameters.model_part_name), ["ThermalModelPart.SolidWall", "ThermalModelPart.SolidWall"]);
  assert.equal(pp.processes.constraints_process_list, undefined);
  assert.equal(pp.output_processes.vtk_output.length, 2);
  assert.deepEqual(pp.output_processes.vtk_output[1].Parameters.nodal_solution_step_data_variables, ["TEMPERATURE"]);
  assert.equal(JSON.parse(out.materials).properties[0].model_part_name, "FluidModelPart.Fluid");
  const solidMaterials = JSON.parse(out.extraFiles.find((f) => f.name === "SolidMaterials.json")!.content);
  assert.equal(solidMaterials.properties[0].model_part_name, "ThermalModelPart.Solid");
  assert.equal(solidMaterials.properties[0].Material.Variables.CONDUCTIVITY, 50);
  const thermalCopy = JSON.parse(out.extraFiles.find((f) => f.name === "BuoyancyMaterials.json")!.content);
  assert.equal(thermalCopy.properties[0].model_part_name, "FluidThermalModelPart");
});

test("conjugate heat transfer: a missing interface half refuses generation", async () => {
  const model = parseMdpa(MDPA);
  const state = chtState();
  state.assignments = state.assignments.filter((a) => a.conditionId !== "solidThermalInterface");
  await assert.rejects(() => generateCase(conjugateHeatTransfer, model, state, "plate"), /Solid thermal interface/);
});
