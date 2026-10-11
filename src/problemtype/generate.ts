import { materialJson } from "./materialJson";
/**
 * The case generator: assembles the GiD-shaped ProjectParameters.json,
 * the materials file and MainKratos.py from a ProblemtypeRuntime, the parsed
 * MdpaModel (for the SubModelPart list / domain size) and the user's CaseState.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable.
 */

import { MdpaModel, SubModelPart } from "../parser/types";
import {
  Assignment,
  CaseState,
  DomainContext,
  DomainSpec,
  GenContext,
  GeneratedCase,
  JsonObject,
  JsonValue,
  ProblemtypeDeclaration,
  ProblemtypeRuntime,
} from "./types";
import { asNum, dottedModelPart, fieldDefault, flattenValues } from "./api";
import { validateMaterialAssignment } from "./materialCatalog";
import { validateFluidTimeStepping } from "./timeStepEstimate";

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

/** The domain that owns a condition, when the problemtype declares domains. */
export function domainOfCondition(decl: ProblemtypeDeclaration, conditionId: string): DomainSpec | undefined {
  return decl.domains?.find((d) => d.conditionIds.includes(conditionId));
}

/** The domain a material law belongs to (declared on the law, else the first domain with materials). */
export function domainOfLaw(decl: ProblemtypeDeclaration, lawId: string): DomainSpec | undefined {
  const law = decl.materialLaws.find((l) => l.id === lawId);
  return decl.domains?.find((d) => d.id === law?.domain);
}

/** Ids of every Parts-style pseudo-condition (one per domain, or the single `partsCondition`). */
export function partsConditionIds(decl: Pick<ProblemtypeDeclaration, "partsCondition" | "domains">): string[] {
  if (decl.domains && decl.domains.length > 0) return decl.domains.map((d) => d.partsCondition);
  return decl.partsCondition !== undefined ? [decl.partsCondition] : [];
}

/**
 * Problems that make a coupled case ungeneratable, named so the user can fix
 * them: a domain with no computing part, a required condition (the FSI
 * interface, say) with no assignment. Shared by Generate (which throws) and
 * `case_validate` (which lists them), so the two cannot disagree. Empty for a
 * problemtype without domains.
 */
export function domainProblems(
  decl: ProblemtypeDeclaration,
  assignments: Pick<Assignment, "conditionId" | "smpPath">[]
): string[] {
  const out: string[] = [];
  for (const d of decl.domains ?? []) {
    const has = (conditionId: string): boolean => assignments.some((a) => a.conditionId === conditionId);
    if (!has(d.partsCondition)) {
      out.push(`Domain "${d.label}" has no computing part: assign at least one SubModelPart as "${decl.conditions.find((c) => c.id === d.partsCondition)?.label ?? d.partsCondition}".`);
    }
    for (const r of d.required ?? []) {
      if (!has(r.conditionId)) out.push(`Domain "${d.label}": ${r.message}`);
    }
  }
  return out;
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
  const domainSize = resolveDomainSize(runtime, model, warnings);
  const values = flattenValues(decl, state);
  const partIds = new Set(partsConditionIds(decl));
  const modelPartOf = (conditionId: string): string => domainOfCondition(decl, conditionId)?.modelPartName ?? decl.modelPartName;
  const dotted = (a: Assignment): string => dottedModelPart(modelPartOf(a.conditionId), a.smpPath);
  const partsModelParts = state.assignments.filter((a) => partIds.has(a.conditionId)).map(dotted);
  const skinModelParts = state.assignments.filter((a) => !partIds.has(a.conditionId)).map(dotted);
  const ctx: GenContext = {
    mdpaStem,
    domainSize,
    modelPartName: decl.modelPartName,
    materialsFileName: decl.materialsFileName,
    values,
    assignments: state.assignments,
    materials: state.materials,
    partsModelParts,
    skinModelParts,
    subModelParts: paths,
  };
  if (decl.domains && decl.domains.length > 0) {
    const domains: Record<string, DomainContext> = {};
    for (const d of decl.domains) {
      const own = state.assignments.filter((a) => d.conditionIds.includes(a.conditionId));
      domains[d.id] = {
        mdpaStem: `${mdpaStem}_${d.mdpaSuffix}`,
        domainSize,
        modelPartName: d.modelPartName,
        materialsFileName: d.materialsFileName ?? decl.materialsFileName,
        values,
        assignments: own,
        materials: state.materials.filter((m) => domainOfLaw(decl, m.lawId)?.id === d.id),
        partsModelParts: own.filter((a) => a.conditionId === d.partsCondition).map((a) => dottedModelPart(d.modelPartName, a.smpPath)),
        skinModelParts: own.filter((a) => a.conditionId !== d.partsCondition).map((a) => dottedModelPart(d.modelPartName, a.smpPath)),
        subModelParts: paths,
      };
    }
    ctx.domains = domains;
  }
  return ctx;
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

/**
 * Builds the materials-file document from the case's material assignments.
 *
 * Refuses rather than degrades. A material whose law the problemtype does not
 * declare, or whose density is zero or negative, used to be written out (or
 * silently dropped) and left for Kratos to fail on with a missing property. The
 * checks are the ones the sidebar row and `case_validate` already show, so
 * Generate can never disagree with them. Warnings still collect, and a
 * problemtype with no material laws legitimately produces an empty file.
 */
export function buildMaterials(
  ctx: GenContext | DomainContext,
  state: Pick<CaseState, "materials">,
  runtime: ProblemtypeRuntime,
  warnings: string[],
  fileLabel?: string
): JsonObject {
  const properties: JsonValue[] = [];
  const problems: string[] = [];
  state.materials.forEach((m, i) => {
    const law = runtime.decl.materialLaws.find((l) => l.id === m.lawId);
    if (!law) {
      problems.push(
        `"${m.smpPath}": material law "${m.lawId}" is not declared by problemtype "${runtime.decl.id}".`
      );
      return;
    }
    const label = `${m.smpPath} (${law.name || law.id})`;
    for (const issue of validateMaterialAssignment(law, m.values, m.preset)) {
      const message = `${label}: ${issue.message}`;
      if (issue.severity === "error") problems.push(message);
      else warnings.push(message);
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
  if (problems.length > 0) {
    throw new Error(
      `The case has material problems, so no materials file was written:\n- ${problems.join("\n- ")}`
    );
  }
  // Kratos' ReadMaterialsUtility assigns properties per SubModelPart, so the
  // ids here do not need to match any property ids already in the mdpa.
  // Problemtypes without material laws (e.g. potential flow) legitimately
  // produce an empty file — no warning then.
  if (properties.length === 0 && runtime.decl.materialLaws.length > 0) {
    warnings.push(`No materials assigned — the materials file${fileLabel ? ` ${fileLabel}` : ""} will be empty.`);
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
  const partIds = new Set(partsConditionIds(decl));
  for (const a of state.assignments) {
    const cond = decl.conditions.find((c) => c.id === a.conditionId);
    if (!cond) {
      warnings.push(`Unknown condition "${a.conditionId}" on "${a.smpPath}" — skipped.`);
      continue;
    }
    // The Parts pseudo-condition names the domain; it emits no process entry,
    // and neither does a condition that only marks a SubModelPart for the hooks.
    if (partIds.has(cond.id) || cond.noProcess) continue;
    // A coupled problemtype builds each condition against ITS domain's model part.
    const owner = domainOfCondition(decl, cond.id);
    processes[cond.list].push(await runtime.buildProcess(cond, a, owner && ctx.domains ? { ...ctx.domains[owner.id], domains: ctx.domains } : ctx));
  }
  const missing = [...domainProblems(decl, state.assignments), ...(await runtime.validate(ctx))];
  if (missing.length > 0) {
    throw new Error(`The case is incomplete, so no case files were written:\n- ${missing.join("\n- ")}`);
  }
  if (!decl.domains && decl.partsCondition !== undefined && ctx.partsModelParts.length === 0) {
    warnings.push("No SubModelPart assigned as Parts/body — solver settings may be incomplete.");
  }
  // Fixed/adaptive time-stepping values are solver settings Kratos reads
  // directly, so a bad combination is refused here rather than left for the
  // solver (same rule as buildMaterials). Any problemtype carrying the fluid
  // time-stepping fields gets the check, not just decl id "fluid".
  if ("timeStepMode" in values) {
    const problems: string[] = [];
    for (const issue of validateFluidTimeStepping(values as Record<string, unknown>)) {
      if (issue.severity === "error") problems.push(issue.message);
      else warnings.push(issue.message);
    }
    if (problems.length > 0) {
      throw new Error(
        `The case has time-stepping problems, so no case files were written:\n- ${problems.join("\n- ")}`
      );
    }
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
    output_processes: state.outputProcesses ?? {
      gid_output: [],
      vtk_output: [vtkOutputProcess(ctx, state, decl.output.gaussDefaults ?? [])],
    },
  };
  projectParameters = await runtime.postProcess(projectParameters, ctx);

  // One materials document per domain (a coupled case) or the single one.
  const extraFiles: { name: string; content: string }[] = [];
  let materials: JsonObject;
  let materialsFileName = decl.materialsFileName;
  let materialsText: string;
  if (decl.domains && ctx.domains) {
    const withFiles = decl.domains.filter((d) => d.materialsFileName !== undefined);
    const docs = withFiles.map((d) => {
      const dctx = ctx.domains![d.id];
      const doc = buildMaterials(dctx, { materials: dctx.materials }, runtime, warnings, d.materialsFileName);
      return { name: d.materialsFileName as string, doc };
    });
    materials = docs[0]?.doc ?? { properties: [] };
    materialsFileName = docs[0]?.name ?? decl.materialsFileName;
    materialsText = materialJson(materials, runtime);
    for (const d of docs.slice(1)) extraFiles.push({ name: d.name, content: materialJson(d.doc, runtime) });
  } else {
    materials = buildMaterials(ctx, state, runtime, warnings);
    materialsText = materialJson(materials, runtime);
  }
  extraFiles.push(...(await runtime.extraFiles(ctx, materials)));
  const mainScript = await runtime.mainScript(ctx);

  return {
    projectParameters: JSON.stringify(projectParameters, null, 4) + "\n",
    materials: materialsText,
    materialsFileName,
    mainScript,
    extraFiles,
    warnings,
  };
}
