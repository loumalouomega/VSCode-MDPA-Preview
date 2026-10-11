/**
 * The convergence history as a scientific-plot recipe (roadmap item 8). Pure:
 * no vscode, no fs. The history is handed to the plotting workspace as an
 * INLINE table, so nothing is written next to the case and the plot library's
 * own rules (gaps are not drawn, unknown units stay unknown) apply unchanged.
 *
 * Decisions that are claims, and so stated here:
 * - The residual column carries NO unit: the norm is criterion-dependent and the
 *   solver does not declare one (see `convergenceToCsv`'s header).
 * - Time carries no unit or physical-time domain either; the script does not say.
 * - A residual the solver did not publish is `null` (a gap), never 0.
 * - A run restarted (step or time went backwards) is one series per segment, so
 *   a restart is never joined to the earlier run by a line.
 */

import type { ConvergenceStep } from "./convergence";
import type { PlotRecipe, PlotSeriesSpec, PlotTable } from "../parser/plot/types";

/** More restarts than this fold into the last series with a note; the chart stays readable. */
export const CONVERGENCE_MAX_SEGMENTS = 8;

const finite = (v: number | undefined): number | null => (v !== undefined && Number.isFinite(v) ? v : null);

export function convergenceTable(steps: readonly ConvergenceStep[]): PlotTable {
  return {
    columns: [
      { id: "segment", label: "Segment", type: "number" },
      { id: "step", label: "Step", type: "number" },
      { id: "time", label: "Time", type: "number" },
      { id: "residual", label: "Residual", type: "number" },
      { id: "ratio", label: "Convergence ratio", type: "number" },
      { id: "iterations", label: "Nonlinear iterations", type: "number" },
    ],
    rows: steps.map((s) => [
      s.segment, s.step, finite(s.time), finite(s.residual), finite(s.convergenceRatio), finite(s.nonlinearIteration),
    ]),
    diagnostics: [],
  };
}

export interface ConvergencePlot {
  recipe: PlotRecipe;
  /** Things the user should know before reading the chart (residual absent, restarts folded). */
  notes: string[];
}

/** Residual against step, one series per run segment, on a log axis. */
export function convergencePlotRecipe(steps: readonly ConvergenceStep[], title: string): ConvergencePlot {
  const notes: string[] = [];
  const table = convergenceTable(steps);
  const segments = [...new Set(steps.map((s) => s.segment))].sort((a, b) => a - b);
  const shown = segments.slice(0, CONVERGENCE_MAX_SEGMENTS);
  if (segments.length > shown.length) {
    notes.push(`${segments.length} run segments; only the first ${shown.length} are drawn (the table holds all of them).`);
  }
  if (!steps.some((s) => s.residual !== undefined && Number.isFinite(s.residual))) {
    notes.push("The solver published no residual for these steps; the chart has nothing to draw. Choose another column in the series settings.");
  }
  const series: PlotSeriesSpec[] = shown.map((segment) => ({
    id: `residual-${segment}`,
    source: "convergence",
    name: segments.length > 1 ? `Residual (segment ${segment})` : "Residual",
    x: "step",
    y: "residual",
    filter: { column: "segment", min: segment, max: segment },
  }));
  return {
    notes,
    recipe: {
      version: 1,
      sources: [{ id: "convergence", type: "inline", table }],
      series,
      presentation: {
        family: "line",
        title,
        xLabel: "Step",
        yLabel: "Residual (unit undeclared)",
        yScale: "log",
        lineMode: "lines+markers",
        panels: 1,
      },
    },
  };
}
