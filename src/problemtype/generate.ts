/**
 * The case generator: assembles the GiD-shaped ProjectParameters.json,
 * the materials file and MainKratos.py from a ProblemtypeRuntime, the parsed
 * MdpaModel (for the SubModelPart list / domain size) and the user's CaseState.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable.
 */

import { MdpaModel, SubModelPart } from "../parser/types";
import {
  CaseState,
  GenContext,
  GeneratedCase,
  JsonObject,
  JsonValue,
  ProblemtypeRuntime,
} from "./types";
import { asNum, dottedModelPart, fieldDefault, flattenValues } from "./api";

/** Flattens the SubModelPart tree into slash-separated paths (depth-first). */
export function subModelPartPaths(parts: SubModelPart[]): string[] {
  const out: string[] = [];
  const walk = (p: SubModelPart): void => {
    out.push(p.path);
    p.children.forEach(walk);
  };
  parts.forEach(walk);
  return out;
}

/** Picks the case's domain size: the mesh's, clamped to what the problemtype supports. */
export function resolveDomainSize(
  runtime: ProblemtypeRuntime,
  model: MdpaModel,
  warnings: string[]
): 2 | 3 {
  const meshSize: 2 | 3 = model.is3D ? 3 : 2;
  if (runtime.decl.domainSizes.includes(meshSize)) return meshSize;
  const fallback = runtime.decl.domainSizes[0];
  warnings.push(
    `Problemtype "${runtime.decl.id}" does not support domain size ${meshSize}; using ${fallback}.`
  );
  return fallback;
}

/** Builds the plain-data hook context from model + state. */
export function buildGenContext(
  runtime: ProblemtypeRuntime,
  model: MdpaModel,
  state: CaseState,
  mdpaStem: string,
  warnings: string[]
): GenContext {
  const decl = runtime.decl;
  const paths = subModelPartPaths(model.subModelParts);
  const known = new Set(paths);
  for (const a of [...state.assignments, ...state.materials]) {
    if (!known.has(a.smpPath)) {
      warnings.push(`SubModelPart "${a.smpPath}" is not in the mesh.`);
    }
  }
  const partsId = decl.partsCondition;
  const partsModelParts = state.assignments
    .filter((a) => partsId !== undefined && a.conditionId === partsId)
    .map((a) => dottedModelPart(decl.modelPartName, a.smpPath));
  const skinModelParts = state.assignments
    .filter((a) => partsId === undefined || a.conditionId !== partsId)
    .map((a) => dottedModelPart(decl.modelPartName, a.smpPath));
  return {
    mdpaStem,
    domainSize: resolveDomainSize(runtime, model, warnings),
    modelPartName: decl.modelPartName,
    materialsFileName: decl.materialsFileName,
    values: flattenValues(decl, state),
    assignments: state.assignments,
    materials: state.materials,
    partsModelParts,
    skinModelParts,
    subModelParts: paths,
  };
}

/** The GiD-style vtk_output_process entry (output_path is always "vtk_output"). */
export function vtkOutputProcess(ctx: GenContext, state: CaseState, gauss: string[]): JsonObject {
  return {
    python_module: "vtk_output_process",
    kratos_module: "KratosMultiphysics",
    process_name: "VtkOutputProcess",
    help: "This process writes postprocessing files for Paraview",
    Parameters: {
      model_part_name: ctx.modelPartName,
      output_control_type: state.output.controlType,
      output_interval: state.output.interval,
      file_format: state.output.format,
      output_precision: 7,
      output_sub_model_parts: false,
      output_path: "vtk_output",
      save_output_files_in_folder: true,
      nodal_solution_step_data_variables: [...state.output.nodalVariables],
      nodal_data_value_variables: [],
      element_data_value_variables: [],
      condition_data_value_variables: [],
      gauss_point_variables_extrapolated_to_nodes: [...gauss],
    },
  };
}

/** Builds the materials-file document from the case's material assignments. */
export function buildMaterials(ctx: GenContext, state: CaseState, runtime: ProblemtypeRuntime, warnings: string[]): JsonObject {
  const properties: JsonValue[] = [];
  state.materials.forEach((m, i) => {
    const law = runtime.decl.materialLaws.find((l) => l.id === m.lawId);
    if (!law) {
      warnings.push(`Unknown material law "${m.lawId}" on "${m.smpPath}" — skipped.`);
      return;
    }
    const variables: JsonObject = {};
    for (const v of law.variables) {
      variables[v.id] = m.values[v.id] !== undefined ? m.values[v.id] : fieldDefault(v);
    }
    const material: JsonObject = { Variables: variables, Tables: {} };
    if (law.name.length > 0) {
      material.constitutive_law = { name: law.name };
    }
    properties.push({
      model_part_name: dottedModelPart(ctx.modelPartName, m.smpPath),
      properties_id: i + 1,
      Material: material,
    });
  });
  // Kratos' ReadMaterialsUtility assigns properties per SubModelPart, so the
  // ids here do not need to match any property ids already in the mdpa.
  // Problemtypes without material laws (e.g. potential flow) legitimately
  // produce an empty file — no warning then.
  if (properties.length === 0 && runtime.decl.materialLaws.length > 0) {
    warnings.push("No materials assigned — the materials file will be empty.");
  }
  return { properties };
}

/** Generates the whole case (ProjectParameters + materials + MainKratos.py). */
export async function generateCase(
  runtime: ProblemtypeRuntime,
  model: MdpaModel,
  state: CaseState,
  mdpaStem: string
): Promise<GeneratedCase> {
  const warnings: string[] = [];
  const decl = runtime.decl;
  const ctx = buildGenContext(runtime, model, state, mdpaStem, warnings);
  const values = ctx.values;

  // The three GiD-standard lists are always present; conditions may target
  // additional custom lists (e.g. ShallowWater's boundary_conditions_process_list).
  const processes: Record<string, JsonValue[]> = {
    constraints_process_list: [],
    loads_process_list: [],
    list_other_processes: [],
  };
  for (const c of decl.conditions) {
    if (!(c.list in processes)) processes[c.list] = [];
  }
  for (const a of state.assignments) {
    const cond = decl.conditions.find((c) => c.id === a.conditionId);
    if (!cond) {
      warnings.push(`Unknown condition "${a.conditionId}" on "${a.smpPath}" — skipped.`);
      continue;
    }
    // The Parts pseudo-condition names the domain; it emits no process entry.
    if (decl.partsCondition !== undefined && cond.id === decl.partsCondition) continue;
    processes[cond.list].push(await runtime.buildProcess(cond, a, ctx));
  }
  if (decl.partsCondition !== undefined && ctx.partsModelParts.length === 0) {
    warnings.push("No SubModelPart assigned as Parts/body — solver settings may be incomplete.");
  }

  let projectParameters: JsonObject = {
    analysis_stage: decl.analysisStage,
    problem_data: {
      problem_name: mdpaStem,
      parallel_type: "OpenMP",
      echo_level: asNum(values.echoLevel, 1),
      start_time: asNum(values.startTime, 0),
      end_time: asNum(values.endTime, 1),
    },
    solver_settings: await runtime.solverSettings(values, ctx),
    processes,
    output_processes: {
      gid_output: [],
      vtk_output: [vtkOutputProcess(ctx, state, decl.output.gaussDefaults ?? [])],
    },
  };
  projectParameters = await runtime.postProcess(projectParameters, ctx);

  const materials = buildMaterials(ctx, state, runtime, warnings);
  const mainScript = await runtime.mainScript(ctx);

  return {
    projectParameters: JSON.stringify(projectParameters, null, 4) + "\n",
    materials: JSON.stringify(materials, null, 4) + "\n",
    materialsFileName: decl.materialsFileName,
    mainScript,
    warnings,
  };
}
