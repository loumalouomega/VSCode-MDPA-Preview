// MPI/Trilinos generator variant (roadmap item 32). Pure, import-free besides
// types: used by the generator, the sidebar and tests. Launching under
// `mpirun -n N` is the runner's job, not this module's. The Kratos key names
// (`parallel_type`, `partition_in_memory`, the `amgcl` solver and its
// `krylov_type`) come from Kratos' sources and tests; no MPI run has checked them.

import type { CaseState, JsonObject, JsonValue, ParallelState } from "./types";

/** Built-ins with an MPI variant. */
export const PARALLEL_PROBLEMTYPES: readonly string[] = ["structural", "fluid"];

export function supportsMpi(problemtypeId: string): boolean {
  return PARALLEL_PROBLEMTYPES.includes(problemtypeId);
}

/** The applications an MPI run imports on top of the case's own. */
export const MPI_APPLICATIONS: readonly string[] = ["MetisApplication", "TrilinosApplication"];

/** Analyses whose Kratos strategy has no distributed counterpart. */
const SERIAL_ANALYSES = ["eigen_value", "harmonic_analysis"];

const isObject = (v: JsonValue | undefined): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);

/** The distributed solver for one serial `linear_solver_settings`; undefined means serial-only. */
export function distributedLinearSolver(serial: JsonObject): { settings?: JsonObject; note?: string; refusal?: string } {
  const type = String(serial.solver_type ?? "");
  if (type === "amgcl") return { settings: { ...serial } };
  if (type === "cg" || type === "bicgstab") {
    const settings: JsonObject = { solver_type: "amgcl", krylov_type: type };
    if (serial.tolerance !== undefined) settings.tolerance = serial.tolerance;
    if (serial.max_iteration !== undefined) settings.max_iteration = serial.max_iteration;
    const pre = String(serial.preconditioner_type ?? "none");
    return {
      settings,
      note: pre !== "none" ? `The "${pre}" preconditioner has no MPI counterpart; algebraic multigrid (amgcl) preconditions the ${type} solve instead.` : undefined,
    };
  }
  return { refusal: `The linear solver "${type}" is serial-only; choose Automatic, Conjugate gradients or BiCGStab for an MPI case.` };
}

/** Reasons a case cannot take the MPI variant (empty = it can). */
export function parallelRefusals(problemtypeId: string, parallel: ParallelState | undefined): string[] {
  if (!parallel) return [];
  if (!supportsMpi(problemtypeId)) {
    return [`MPI is not available for the "${problemtypeId}" problemtype (supported: ${PARALLEL_PROBLEMTYPES.join(", ")}).`];
  }
  return [];
}

/**
 * Applies the MPI variant to a built solver document. A state without
 * `parallel` returns the document untouched. Throws one message naming every
 * serial-only choice, in the generator's "no case files were written" shape.
 */
export function applyParallel(document: JsonObject, state: CaseState): { document: JsonObject; warnings: string[] } {
  const parallel = state.parallel;
  if (!parallel) return { document, warnings: [] };
  const warnings: string[] = [];
  const problems: string[] = [];
  const solver: JsonObject = { ...(isObject(document.solver_settings) ? document.solver_settings : {}) };
  const solverType = String(solver.solver_type ?? "");
  if (SERIAL_ANALYSES.includes(solverType.toLowerCase())) {
    problems.push(`The "${solverType}" analysis has no distributed strategy; use a Static or Dynamic analysis for an MPI case.`);
  }
  const keys = Object.keys(solver).filter((k) => k.endsWith("linear_solver_settings") && isObject(solver[k]));
  const rewrite = (key: string, serial: JsonObject): void => {
    const out = distributedLinearSolver(serial);
    if (out.refusal) problems.push(out.refusal);
    else if (out.settings) {
      solver[key] = out.settings;
      if (out.note && !warnings.includes(out.note)) warnings.push(out.note);
    }
  };
  if (keys.length > 0) {
    for (const k of keys) rewrite(k, solver[k] as JsonObject);
  } else if (/fractional/i.test(solverType)) {
    // Automatic: Kratos' serial default is skyline LU, which cannot run distributed.
    solver.velocity_linear_solver_settings = { solver_type: "amgcl" };
    solver.pressure_linear_solver_settings = { solver_type: "amgcl" };
  } else {
    solver.linear_solver_settings = { solver_type: "amgcl" };
  }
  if (problems.length > 0) {
    throw new Error(`The MPI variant cannot be generated, so no case files were written:\n- ${[...new Set(problems)].join("\n- ")}`);
  }
  if (parallel.partitionInMemory) {
    solver.model_import_settings = { ...(isObject(solver.model_import_settings) ? solver.model_import_settings : {}), partition_in_memory: true };
  }
  const problemData = { ...(isObject(document.problem_data) ? document.problem_data : {}), parallel_type: "MPI" };
  return { document: { ...document, problem_data: problemData, solver_settings: solver }, warnings };
}
