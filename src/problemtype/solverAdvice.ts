/**
 * Pure advice about the linear solver of a case (roadmap item 43). Nothing here
 * changes the generated JSON: Automatic writes no `linear_solver_settings`
 * (`linearSolverSettings` in builtins/common.ts), so Kratos picks the default of
 * the selected solver type. This module only says so, estimates the size of the
 * system and warns when a direct solver meets a large 3D case.
 */
import type { JsonValue } from "./types";

/** Degrees of freedom per node by problemtype id (3D / 2D); undefined = not estimated. */
const DOFS_PER_NODE: Record<string, { d3: number; d2: number }> = {
  structural: { d3: 3, d2: 2 },
  convectionDiffusion: { d3: 1, d2: 1 },
  potentialFlow: { d3: 1, d2: 1 },
  fluid: { d3: 4, d2: 3 },
  shallowWater: { d3: 3, d2: 3 },
};

/** Direct solvers: factorisation memory grows much faster than the DOF count. */
export const DIRECT_SOLVERS = ["LinearSolversApplication.sparse_lu", "skyline_lu_factorization", "sparse_lu"];
/** A direct solver is flagged above this many DOFs in 3D. */
export const DIRECT_SOLVER_DOF_LIMIT = 200_000;

export interface SolverAdvice {
  kind: "automatic" | "chosen";
  /** The solver type written to the JSON, or undefined for Automatic. */
  name?: string;
  /** What the choice means, in one sentence. */
  why: string;
  /** Estimated number of unknowns, or undefined when the problemtype is not in the table. */
  dofs?: number;
  direct: boolean;
}

export function estimateDofs(problemtypeId: string, nodeCount: number, is3D: boolean): number | undefined {
  const per = DOFS_PER_NODE[problemtypeId];
  if (!per) return undefined;
  return nodeCount * (is3D ? per.d3 : per.d2);
}

export function adviseLinearSolver(
  problemtypeId: string,
  values: Record<string, JsonValue>,
  nodeCount: number,
  is3D: boolean
): SolverAdvice | undefined {
  // A problemtype with no linear-solver field has nothing to advise on.
  if (values.linearSolver === undefined) return undefined;
  const chosen = typeof values.linearSolver === "string" ? values.linearSolver : "automatic";
  const dofs = estimateDofs(problemtypeId, nodeCount, is3D);
  if (chosen === "automatic") {
    return {
      kind: "automatic",
      why: "Automatic writes no linear_solver_settings, so Kratos uses the default solver of the selected strategy.",
      dofs,
      direct: false,
    };
  }
  return {
    kind: "chosen",
    name: chosen,
    why: `The case sets linear_solver_settings to "${chosen}".`,
    dofs,
    direct: DIRECT_SOLVERS.includes(chosen),
  };
}

export interface SolverFinding {
  severity: "warning" | "info";
  code: string;
  message: string;
}

export function solverFindings(advice: SolverAdvice | undefined, is3D: boolean): SolverFinding[] {
  if (!advice) return [];
  const size = advice.dofs !== undefined ? ` (about ${advice.dofs.toLocaleString("en-US")} unknowns)` : "";
  const out: SolverFinding[] = [
    {
      severity: "info",
      code: "solver-choice",
      message: advice.kind === "automatic"
        ? `Linear solver: automatic${size}. ${advice.why}`
        : `Linear solver: ${advice.name}${size}.`,
    },
  ];
  if (advice.direct && is3D && advice.dofs !== undefined && advice.dofs > DIRECT_SOLVER_DOF_LIMIT) {
    out.push({
      severity: "warning",
      code: "solver-direct-large",
      message: `A direct solver (${advice.name}) on about ${advice.dofs.toLocaleString("en-US")} unknowns in 3D can need a lot of memory and time; consider an iterative solver (cg or bicgstab) or AMGCL.`,
    });
  }
  return out;
}
