/**
 * The read side of an OptimizationApplication run's progress: the file
 * `optimization_problem_ascii_output_process` writes (summary.csv by default).
 * Pure — the `node:fs` half is `summaryLogFile.ts`.
 *
 * The format, as the process writes it at master: `#`-comment lines with the
 * Kratos version, the time stamp and an "Initial values" block, then
 * `# Headers:` followed by a `#  STEP, <component>:<key>, …` line, one data row
 * per optimization step, and `# End of file` when the process finalized.
 *
 * Decisions that are claims, and so stated here:
 * - Columns are classified using the CASE's own names (the objective's and the
 *   constraints' responses, read from optimization_parameters.json), never
 *   guessed from the column text alone.
 * - A constraint is satisfied when its `std_value` is <= 0: that is the
 *   standardized value minus its reference, and its sign is the algorithm's
 *   test. A constraint without that column is reported as unknown, not as met.
 * - No `# End of file` means the run did not finalize — running, killed or
 *   crashed — and the verdict says so; a stopped run still finalizes (the
 *   generated driver catches the stop and calls Finalize) and reads "stopped".
 * - A value that is not a number stays text; a missing cell is a gap (null).
 */

import type { JsonObject, JsonValue } from "../types";
import type { PlotRecipe, PlotSeriesSpec, PlotTable } from "../../parser/plot/types";

export type SummaryCell = number | string | null;

export interface ParsedOptimizationSummary {
  kratosVersion?: string;
  timestamp?: string;
  /** component → key → value, from the "Initial values" block. */
  initialValues: Record<string, Record<string, SummaryCell>>;
  /** Header columns without STEP, as written (e.g. `strain_energy:value`). */
  columns: string[];
  /** One row per step: the STEP value then one cell per column. */
  rows: { step: number; cells: SummaryCell[] }[];
  /** `# End of file` was written: the output process finalized. */
  ended: boolean;
  malformed: number;
  warnings: string[];
}

const cell = (raw: string): SummaryCell => {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
};

export function parseOptimizationSummary(text: string): ParsedOptimizationSummary {
  const out: ParsedOptimizationSummary = { initialValues: {}, columns: [], rows: [], ended: false, malformed: 0, warnings: [] };
  const lines = text.split(/\r?\n/);
  const cutLast = text.length > 0 && !text.endsWith("\n");
  let inInitial = false;
  let component: string | undefined;
  let expectHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (line.startsWith("#")) {
      const body = line.slice(1);
      const trimmed = body.trim();
      if (/^End of file/i.test(trimmed)) {
        out.ended = true;
        continue;
      }
      if (/^Kratos version\s*:/i.test(trimmed)) out.kratosVersion = trimmed.split(":").slice(1).join(":").trim();
      else if (/^Timestamp\s*:/i.test(trimmed)) out.timestamp = trimmed.split(":").slice(1).join(":").trim();
      else if (/Initial values/i.test(trimmed) && !/End of initial values/i.test(trimmed)) inInitial = true;
      else if (/End of initial values/i.test(trimmed)) inInitial = false;
      else if (/^Headers:/i.test(trimmed)) expectHeader = true;
      else if (expectHeader) {
        const names = trimmed.split(",").map((s) => s.trim());
        if (names[0]?.toUpperCase() === "STEP") out.columns = names.slice(1);
        else out.warnings.push(`The header line does not start with STEP: "${trimmed}".`);
        expectHeader = false;
      } else if (inInitial) {
        // "\t<component>:" opens a component; "\t\t<key>: <value>" is one value.
        const depth = (body.match(/^\s*/)?.[0] ?? "").replace(/ /g, "").length;
        const m = /^([^:]+):\s*(.*)$/.exec(trimmed);
        if (m && m[2] === "" && depth <= 1) {
          component = m[1].trim();
          out.initialValues[component] ??= {};
        } else if (m && component) {
          out.initialValues[component][m[1].trim()] = cell(m[2]);
        }
      }
      continue;
    }
    const parts = line.split(",");
    const step = Number(parts[0]);
    const isLast = i === lines.length - 1 || lines.slice(i + 1).every((l) => l.trim() === "");
    if (!Number.isFinite(step) || (out.columns.length > 0 && parts.length !== out.columns.length + 1)) {
      if (isLast && cutLast) out.warnings.push("The last row was cut short (the file is still being written, or the run was killed); it is not shown.");
      else out.malformed++;
      continue;
    }
    out.rows.push({ step, cells: parts.slice(1).map(cell) });
  }
  if (out.columns.length === 0 && out.rows.length > 0) out.warnings.push("No header line was found; columns are unnamed.");
  if (out.malformed > 0) out.warnings.push(`${out.malformed} malformed row(s) were skipped.`);
  return out;
}

/** What the case says about its optimization — read from optimization_parameters.json. */
export interface OptimizationCaseInfo {
  objective?: string;
  objectiveType?: string;
  constraints: { response: string; type: string }[];
  controls: string[];
  maxIter?: number;
  algorithm?: string;
  /** The summary file the ascii output process writes (relative to the case). */
  summaryFile: string;
  /** The design-field folder, when the vtu output process is configured. */
  designFieldsFolder?: string;
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: JsonValue | undefined): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Reads the case facts out of an optimization_parameters.json document (tolerant of missing pieces). */
export function optimizationCaseInfo(doc: unknown): OptimizationCaseInfo {
  const info: OptimizationCaseInfo = { constraints: [], controls: [], summaryFile: "summary.csv" };
  if (!isObject(doc)) return info;
  const algorithm = isObject(doc.algorithm_settings) ? doc.algorithm_settings : undefined;
  if (algorithm) {
    info.algorithm = str(algorithm.type);
    const objective = isObject(algorithm.objective) ? algorithm.objective : undefined;
    info.objective = str(objective?.response_expression) ?? str(objective?.response_name);
    info.objectiveType = str(objective?.type);
    if (Array.isArray(algorithm.constraints)) {
      for (const c of algorithm.constraints) {
        if (!isObject(c)) continue;
        const response = str(c.response_expression) ?? str(c.response_name);
        if (response) info.constraints.push({ response, type: str(c.type) ?? "" });
      }
    }
    if (Array.isArray(algorithm.controls)) info.controls = algorithm.controls.filter((x): x is string => typeof x === "string");
    const settings = isObject(algorithm.settings) ? algorithm.settings : undefined;
    const conv = isObject(settings?.conv_settings) ? settings!.conv_settings as JsonObject : undefined;
    if (typeof conv?.max_iter === "number") info.maxIter = conv.max_iter;
  }
  const processes = isObject(doc.processes) ? doc.processes : undefined;
  const data = isObject(processes?.optimization_data_processes) ? processes!.optimization_data_processes as JsonObject : undefined;
  for (const list of Object.values(data ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (!isObject(p) || !isObject(p.settings)) continue;
      if (p.type === "optimization_problem_ascii_output_process") {
        let name = str(p.settings.output_file_name) ?? "summary.csv";
        if (!name.endsWith(".csv")) name += ".csv";
        info.summaryFile = name;
      }
      if (p.type === "optimization_problem_vtu_output_process") {
        info.designFieldsFolder = str(p.settings.output_path) ?? "Optimization_Results";
      }
    }
  }
  return info;
}

export type OptimizationVerdict = "no-data" | "running" | "finished" | "stopped" | "incomplete";

export interface ConstraintStatus {
  response: string;
  type: string;
  value?: number;
  stdValue?: number;
  /** std_value <= 0; undefined when the column is not written. */
  satisfied?: boolean;
}

export interface OptimizationSummary {
  verdict: OptimizationVerdict;
  iterations: number;
  lastStep?: number;
  maxIter?: number;
  reachedMaxIter: boolean;
  objective?: {
    response: string;
    type?: string;
    initial?: number;
    current?: number;
    /** (current − initial) / |initial| × 100, from the objective's own column. */
    changePercent?: number;
  };
  constraints: ConstraintStatus[];
  warnings: string[];
}

const num = (c: SummaryCell | undefined): number | undefined => (typeof c === "number" && Number.isFinite(c) ? c : undefined);

/** The column index of `<component>:<key>`, or -1. */
export function columnIndex(parsed: ParsedOptimizationSummary, component: string, key: string): number {
  return parsed.columns.indexOf(`${component}:${key}`);
}

function lastNumber(parsed: ParsedOptimizationSummary, index: number): number | undefined {
  if (index < 0) return undefined;
  for (let r = parsed.rows.length - 1; r >= 0; r--) {
    const v = num(parsed.rows[r].cells[index]);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function summarizeOptimization(
  parsed: ParsedOptimizationSummary,
  info: OptimizationCaseInfo,
  runStatus?: string
): OptimizationSummary {
  const rows = parsed.rows;
  const summary: OptimizationSummary = {
    verdict: "no-data",
    iterations: rows.length,
    lastStep: rows.length > 0 ? rows[rows.length - 1].step : undefined,
    maxIter: info.maxIter,
    reachedMaxIter: false,
    constraints: [],
    warnings: [...parsed.warnings],
  };
  if (info.maxIter !== undefined && summary.lastStep !== undefined) summary.reachedMaxIter = summary.lastStep + 1 >= info.maxIter;
  if (parsed.ended) summary.verdict = runStatus === "cancelled" ? "stopped" : "finished";
  else if (rows.length === 0) summary.verdict = runStatus === "running" || runStatus === "detached" ? "running" : "no-data";
  else summary.verdict = runStatus === "running" || runStatus === "detached" ? "running" : "incomplete";
  if (info.objective) {
    const index = columnIndex(parsed, info.objective, "value");
    const values = index < 0 ? [] : rows.map((r) => num(r.cells[index])).filter((v): v is number => v !== undefined);
    const initial = num(parsed.initialValues[info.objective]?.initial_value) ?? values[0];
    const current = values.length > 0 ? values[values.length - 1] : undefined;
    summary.objective = { response: info.objective, type: info.objectiveType, initial, current };
    if (initial !== undefined && current !== undefined && initial !== 0) {
      summary.objective.changePercent = ((current - initial) / Math.abs(initial)) * 100;
    }
    if (index < 0 && rows.length > 0) summary.warnings.push(`The summary has no "${info.objective}:value" column; the objective cannot be followed.`);
  }
  for (const c of info.constraints) {
    const value = lastNumber(parsed, columnIndex(parsed, c.response, "value"));
    const stdValue = lastNumber(parsed, columnIndex(parsed, c.response, "std_value"));
    summary.constraints.push({ response: c.response, type: c.type, value, stdValue, satisfied: stdValue === undefined ? undefined : stdValue <= 0 });
  }
  return summary;
}

const sci = (x: number): string => (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(3) : x.toPrecision(4));

/** One line for the Kratos Runs tree, e.g. "Optimization — iter 7/10 · objective −10.7% · 1/1 constraints met · running". */
export function optimizationRowText(s: OptimizationSummary): string {
  if (s.iterations === 0) return `Optimization — no iterations yet · ${s.verdict}`;
  const parts = [`iter ${(s.lastStep ?? 0) + 1}${s.maxIter !== undefined ? `/${s.maxIter}` : ""}`];
  if (s.objective?.changePercent !== undefined) {
    const p = s.objective.changePercent;
    parts.push(`objective ${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`);
  } else if (s.objective?.current !== undefined) parts.push(`objective ${sci(s.objective.current)}`);
  if (s.constraints.length > 0) {
    const known = s.constraints.filter((c) => c.satisfied !== undefined);
    const met = known.filter((c) => c.satisfied).length;
    parts.push(known.length === s.constraints.length ? `${met}/${s.constraints.length} constraints met` : `${s.constraints.length} constraints (status unknown)`);
  }
  parts.push(s.verdict);
  return `Optimization — ${parts.join(" · ")}`;
}

/** A VS Code ThemeIcon id for the optimization row. */
export function optimizationIconId(s: OptimizationSummary): string {
  if (s.verdict === "finished") return s.constraints.some((c) => c.satisfied === false) ? "warning" : "pass";
  if (s.verdict === "incomplete") return "warning";
  if (s.verdict === "stopped") return "debug-stop";
  return "pulse";
}

/** The summary as an inline plot table: STEP plus every numeric column, ids c0, c1, … */
export function optimizationTable(parsed: ParsedOptimizationSummary): PlotTable {
  return {
    columns: [
      { id: "step", label: "Step", type: "number" },
      ...parsed.columns.map((label, i) => ({ id: `c${i}`, label, type: "number" as const })),
    ],
    rows: parsed.rows.map((r) => [r.step, ...r.cells.map((c) => (typeof c === "number" ? c : null))]),
    diagnostics: [...parsed.warnings],
  };
}

/**
 * Objective against step in the first panel; the constraints' std_value (<= 0
 * is satisfied) in the second when there are any. No unit is claimed: the
 * process writes none.
 */
export function optimizationPlotRecipe(parsed: ParsedOptimizationSummary, info: OptimizationCaseInfo, title: string): { recipe: PlotRecipe; notes: string[] } {
  const notes: string[] = [];
  const table = optimizationTable(parsed);
  const series: PlotSeriesSpec[] = [];
  const col = (component: string, key: string): string | undefined => {
    const i = columnIndex(parsed, component, key);
    return i < 0 ? undefined : `c${i}`;
  };
  const objective = info.objective ? col(info.objective, "value") ?? col("algorithm", "std_obj_value") : col("algorithm", "std_obj_value");
  if (objective) series.push({ id: "objective", source: "summary", name: `Objective${info.objective ? ` (${info.objective})` : ""}`, x: "step", y: objective, panel: 0 });
  else notes.push("The summary has no objective column; choose a column in the series settings.");
  const constrained = info.constraints.map((c) => ({ c, id: col(c.response, "std_value") })).filter((x) => x.id !== undefined);
  for (const { c, id } of constrained) {
    series.push({ id: `constraint-${c.response}`, source: "summary", name: `${c.response} ${c.type} (std, ≤ 0 is met)`, x: "step", y: id!, panel: 1 });
  }
  if (info.constraints.length > constrained.length) notes.push("Some constraints have no std_value column in the summary and are not drawn.");
  return {
    notes,
    recipe: {
      version: 1,
      sources: [{ id: "summary", type: "inline", table }],
      series,
      presentation: {
        family: "line",
        title,
        xLabel: "Optimization step",
        yLabel: "Value (unit undeclared)",
        lineMode: "lines+markers",
        panels: constrained.length > 0 ? 2 : 1,
      },
    },
  };
}

/** The progress table the webview panel draws: header + rows, bounded to the last `limit` steps. */
export function boundRows(parsed: ParsedOptimizationSummary, limit: number): ParsedOptimizationSummary["rows"] {
  return parsed.rows.length <= limit ? parsed.rows : parsed.rows.slice(parsed.rows.length - limit);
}

/** One line stating the problem, e.g. "minimize strain_energy subject to mass <= reference · controls: material_control". */
export function optimizationFormulation(info: OptimizationCaseInfo): string {
  const goal = info.objectiveType === "maximization" ? "maximize" : "minimize";
  const parts = [`${goal} ${info.objective ?? "(no objective)"}`];
  if (info.constraints.length > 0) parts.push(`subject to ${info.constraints.map((c) => `${c.response} ${c.type || "?"} reference`).join(", ")}`);
  let text = parts.join(" ");
  if (info.controls.length > 0) text += ` · controls: ${info.controls.join(", ")}`;
  if (info.algorithm) text += ` · ${info.algorithm.replace(/^algorithm_/, "").replace(/_/g, " ")}`;
  return text;
}

const csvCell = (c: SummaryCell): string => {
  if (c === null) return "";
  const s = String(c);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The parsed summary as plain CSV (STEP plus every column, gaps blank). */
export function optimizationSummaryToCsv(parsed: Pick<ParsedOptimizationSummary, "columns" | "rows">): string {
  const header = ["STEP", ...parsed.columns].map((c) => csvCell(c)).join(",");
  return [header, ...parsed.rows.map((r) => [r.step, ...r.cells].map((c) => csvCell(c as SummaryCell)).join(","))].join("\n") + "\n";
}
