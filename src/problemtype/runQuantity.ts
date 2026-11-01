/**
 * A per-run quantity (roadmap item 25): one saved monitor evaluated once per
 * isolated run of the same case, one row per run with its recorded case
 * parameters as columns. It reads each run through `readRunEvidence` (the
 * discovery `case_compare` already uses) and `evaluateMonitors` (the numerics
 * monitors and plots share), so it adds no second run reader and no new number.
 *
 * The value of a run is the LAST evaluated frame of the monitor (the final
 * state of the run); a run that is not terminal or has no frame yields a row
 * with `value: null` and the reason. Parameter columns are the case-state
 * leaves that differ between the runs plus every entry of the case's
 * `parameters` table, so a sweep's varied inputs are exactly the columns.
 */
import * as path from "node:path";
import { readRunEvidence, flatten } from "./runCompare";
import { terminalExecution } from "./runReceipt";
import { evaluateMonitors } from "./monitorsFile";
import type { MonitorDefinition } from "./monitors";

export interface RunQuantityRow {
  runDirectory: string;
  runId?: string;
  state?: string;
  /** Last evaluated frame's value(s); null where the run could not be evaluated. */
  values: (number | null)[] | null;
  frame?: number;
  time?: number;
  frames: number;
  /** Case-state leaves that differ across the runs (and the case parameters), by dotted path. */
  parameters: Record<string, unknown>;
  reason?: string;
}

export interface RunQuantity {
  monitor: string;
  columns: string[];
  /** The parameter paths used as columns, in order. */
  parameterColumns: string[];
  rows: RunQuantityRow[];
}

export async function runQuantity(runDirectories: readonly string[], monitor: MonitorDefinition, opts: { signal?: AbortSignal } = {}): Promise<RunQuantity> {
  const evidence = runDirectories.map((d) => readRunEvidence(d));
  // Flatten each run's recorded settings and keep the leaves that vary, plus the parameter table.
  const flat = evidence.map((e) => {
    const m = new Map<string, unknown>();
    if (e.preparation) flatten(e.preparation.settings, "", m);
    return m;
  });
  const paths = new Set<string>();
  for (const m of flat) for (const k of m.keys()) paths.add(k);
  const parameterColumns = [...paths].filter((k) => {
    if (k.startsWith("parameters.")) return true;
    const first = JSON.stringify(flat[0]?.get(k));
    return flat.some((m) => JSON.stringify(m.get(k)) !== first);
  }).sort();
  let columns: string[] = [];
  const rows: RunQuantityRow[] = [];
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i];
    const parameters: Record<string, unknown> = {};
    for (const k of parameterColumns) parameters[k] = flat[i].get(k);
    const base = { runDirectory: e.runDirectory, ...(e.receipt ? { runId: e.receipt.requestId, state: e.receipt.state } : {}), parameters };
    if (e.problem || !e.receipt) { rows.push({ ...base, values: null, frames: 0, reason: e.problem ?? "No execution receipt." }); continue; }
    if (!terminalExecution(e.receipt)) { rows.push({ ...base, values: null, frames: 0, reason: `The run is ${e.receipt.state}, not finished.` }); continue; }
    const mesh = path.resolve(e.receipt.meshPath);
    const ev = await evaluateMonitors(mesh, [monitor], { signal: opts.signal });
    if (!ev.available || ev.results.length === 0) { rows.push({ ...base, values: null, frames: 0, reason: ev.reason ?? "The monitor could not be evaluated." }); continue; }
    const table = ev.results[0].table;
    const valueCols: number[] = [];
    for (let c = 2; c < table.columns.length; c++) if (table.columns[c].id !== "covered" && table.columns[c].id !== "measure") valueCols.push(c);
    if (columns.length === 0) columns = valueCols.map((c) => table.columns[c].label);
    const last = table.rows[table.rows.length - 1];
    if (!last) { rows.push({ ...base, values: null, frames: 0, reason: "The run wrote no evaluable frame." }); continue; }
    rows.push({
      ...base,
      values: valueCols.map((c) => (typeof last[c] === "number" && Number.isFinite(last[c] as number) ? (last[c] as number) : null)),
      time: typeof last[0] === "number" ? last[0] : undefined,
      frame: typeof last[1] === "number" ? last[1] : undefined,
      frames: table.rows.length,
    });
  }
  return { monitor: monitor.id, columns, parameterColumns, rows };
}

/** CSV with the parameter columns first. */
export function runQuantityToCsv(q: RunQuantity): string {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["run", ...q.parameterColumns, ...q.columns, "frames", "reason"];
  const lines = [header.map(esc).join(",")];
  for (const r of q.rows) lines.push([r.runId ?? path.basename(r.runDirectory), ...q.parameterColumns.map((k) => r.parameters[k]), ...(r.values ?? q.columns.map(() => null)), r.frames, r.reason ?? ""].map(esc).join(","));
  return lines.join("\n") + "\n";
}
