/**
 * Rendering a per-run quantity as Markdown (roadmap item 25, viewer half).
 *
 * The Kratos Runs `kratos.runs.quantityAcrossRuns` command opens this report for
 * one saved monitor evaluated over the isolated runs of a case; `runQuantity.ts`
 * stays the numerics core, so this module takes a `RunQuantity` and returns text.
 * Pure (no vscode) and deterministic, so the layout is Node-testable.
 *
 * A run with no evaluated value is a row with `—` cells and its reason below the
 * table, never 0. No unit is claimed beyond the monitor's own label-only `unit`.
 */
import * as path from "node:path";

import type { RunQuantity } from "./runQuantity";

/** A table cell: objects as compact JSON, pipes escaped, whitespace folded. */
function cell(value: unknown, budget = 60): string {
  if (value === undefined || value === null) return "—";
  const raw = typeof value === "string" ? value : typeof value === "number" ? String(value) : JSON.stringify(value);
  const flat = (raw ?? "—").replace(/\s+/g, " ").replace(/\|/g, "\\|");
  return flat.length > budget ? `${flat.slice(0, budget - 1)}…` : flat;
}

export function renderRunQuantityMarkdown(q: RunQuantity, opts: { caseName?: string; unit?: string } = {}): string {
  const unit = opts.unit ? ` [${opts.unit}]` : "";
  const out: string[] = [
    `# Quantity across runs — ${cell(q.monitor, 80)}${opts.caseName ? ` (${cell(opts.caseName, 80)})` : ""}`,
    "",
    "> One saved monitor evaluated once per finished isolated run. The value is the last evaluated frame of each run; the parameter columns are the recorded case settings that differ between the runs. A run without a value is shown as —, never as 0.",
    "",
  ];
  if (q.rows.length === 0) {
    out.push("No isolated run of this case is available.", "");
    return out.join("\n");
  }
  const header = ["Run", ...q.parameterColumns, ...q.columns.map((c) => `${c}${unit}`), "Frames"];
  out.push(`| ${header.map((h) => cell(h)).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);
  const reasons: string[] = [];
  for (const r of q.rows) {
    const name = r.runId ?? path.basename(r.runDirectory);
    const values = q.columns.map((_, i) => (r.values ? r.values[i] : null));
    out.push(
      `| ${[cell(name), ...q.parameterColumns.map((k) => cell(r.parameters[k])), ...values.map((v) => cell(v)), String(r.frames)].join(" | ")} |`
    );
    if (r.reason) reasons.push(`- ${cell(name, 80)}: ${cell(r.reason, 300)}`);
  }
  out.push("");
  if (reasons.length > 0) out.push("## Runs without a value", "", ...reasons, "");
  return out.join("\n");
}
