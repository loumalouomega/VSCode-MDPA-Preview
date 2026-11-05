/**
 * A per-run quantity drawn against a recorded case parameter (roadmap item 30,
 * second half). Pure: it turns a `RunQuantity` (one row per isolated run) into an
 * INLINE-source plot recipe, so the plot library's own rules apply unchanged.
 *
 * The x axis is a numeric case parameter picked by its dotted path (a path into
 * the recorded case state; array positions are numeric segments, e.g.
 * `assignments.0.values.modulus`). A run without a value, or without that
 * parameter, is a gap (`null`), never 0, and no unit is claimed for either axis:
 * a materials/case value carries none in the receipt.
 */
import type { PlotRecipe, PlotTable } from "../parser/plot/types";
import type { RunQuantity, RunQuantityRow } from "./runQuantity";

/** Value of a numeric parameter in a row; the row's parameters are keyed by leaf path or by array-holding prefix. */
export function parameterValue(row: RunQuantityRow, dotted: string): number | undefined {
  const direct = row.parameters[dotted];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  for (const [key, value] of Object.entries(row.parameters)) {
    if (!dotted.startsWith(key + ".")) continue;
    let cur: unknown = value;
    for (const seg of dotted.slice(key.length + 1).split(".")) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (typeof cur === "number" && Number.isFinite(cur)) return cur;
  }
  return undefined;
}

/** Dotted paths that are numeric for at least one run, to offer when no parameter is named. */
export function numericParameterPaths(q: RunQuantity): string[] {
  const out = new Set<string>();
  const walk = (value: unknown, prefix: string): void => {
    if (typeof value === "number" && Number.isFinite(value)) out.add(prefix);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${prefix}.${k}`);
  };
  for (const r of q.rows) for (const [k, v] of Object.entries(r.parameters)) walk(v, k);
  return [...out].sort();
}

export interface RunQuantityPlot {
  recipe: PlotRecipe;
  parameter: string;
  notes: string[];
}

export function runQuantityPlotRecipe(q: RunQuantity, parameter: string | undefined, title: string): RunQuantityPlot {
  const candidates = numericParameterPaths(q);
  const chosen = parameter ?? candidates[0];
  if (!chosen) throw new Error("None of the runs records a numeric case parameter to draw against.");
  if (parameter && !candidates.includes(parameter))
    throw new Error(`"${parameter}" is not a numeric parameter recorded by these runs. Numeric parameters: ${candidates.join(", ") || "none"}.`);
  const notes: string[] = [];
  const valueIds = q.columns.map((_, i) => `v${i}`);
  const points = q.rows
    .map((r) => ({ x: parameterValue(r, chosen), r }))
    .sort((a, b) => (a.x ?? Infinity) - (b.x ?? Infinity));
  const missing = points.filter((p) => p.x === undefined).length;
  if (missing > 0) notes.push(`${missing} run(s) record no value for ${chosen}; they are rows with a gap on the x axis and are not drawn.`);
  const unevaluated = q.rows.filter((r) => r.values === null).length;
  if (unevaluated > 0) notes.push(`${unevaluated} run(s) have no evaluated value (not finished, no receipt or no frame); they are gaps.`);
  const table: PlotTable = {
    columns: [
      { id: "parameter", label: chosen, type: "number" },
      ...q.columns.map((label, i) => ({ id: valueIds[i], label, type: "number" as const })),
    ],
    rows: points.map(({ x, r }) => [x ?? null, ...q.columns.map((_, i) => (r.values && typeof r.values[i] === "number" ? (r.values[i] as number) : null))]),
    diagnostics: [],
  };
  return {
    parameter: chosen,
    notes,
    recipe: {
      version: 1,
      sources: [{ id: "runs", type: "inline", table }],
      series: q.columns.map((label, i) => ({ id: `q${i}`, source: "runs", name: label, x: "parameter", y: valueIds[i] })),
      presentation: { family: "line", title, xLabel: `${chosen} (unit undeclared)`, yLabel: "Value (unit undeclared)", lineMode: "lines+markers", panels: 1 },
    },
  };
}
