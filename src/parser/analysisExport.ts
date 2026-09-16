/**
 * CSV serializers for the three analysis panels (Quality, Mesh Size, Field
 * integrals) — the export half of the roadmap item the Data table and Plot
 * over time already closed for themselves.
 *
 * Pure (no vscode/DOM/fs/wasm) and bundled into BOTH runtimes, the same
 * arrangement as `dataTable.ts`: the panels serialize what they already hold
 * and post finished text for the host to save (the `menuExportSeries`
 * direction, not the Data table's host-rebuild — these payloads are kilobytes
 * already on screen, and rebuilding them host-side would re-run a full-mesh
 * scan or a wasm `dataIntegrate` for nothing).
 *
 * Two rules, both inherited:
 *  - File precision is RAW (`String(v)` — the shortest decimal that
 *    round-trips a double; NaN/Infinity print verbatim), never the panels'
 *    display rounding. Same split `dataTable.ts` draws between `row(i)` and
 *    its writers: the file must not disagree with the panel about the number.
 *  - Id lists are CAPPED (`ANALYSIS_EXPORT_ID_LIMIT`, with a `…(+N more)`
 *    trailer): a whole mesh can be bad, and a megabyte-long spreadsheet cell
 *    is not data. Counts stay complete — only the listing is cut, which is
 *    what the in-scene highlight is for.
 */

import { csvField } from "./dataTable";
import type { FieldIntegral, IntegralTotals } from "./fieldIntegrate";
import type { BoxStats, MeshSizeResult } from "./meshSize";
import type { MetricResult, QualityBand, QualityReport } from "./meshQuality";

/**
 * Id lists longer than this export as `…(+N more)`. Beyond it you need the
 * in-scene highlight, not a spreadsheet cell.
 */
export const ANALYSIS_EXPORT_ID_LIMIT = 100;

/** Space-separated ids (no commas, so no quoting), capped with a trailer. */
export function exportIdList(ids: readonly number[]): string {
  const shown = ids.slice(0, ANALYSIS_EXPORT_ID_LIMIT).join(" ");
  return ids.length > ANALYSIS_EXPORT_ID_LIMIT
    ? `${shown} …(+${ids.length - ANALYSIS_EXPORT_ID_LIMIT} more)`
    : shown;
}

/** One component vector as a single cell: scalars plain, vectors as tuples. */
function tup(values: number[]): string {
  return values.length === 1 ? String(values[0]) : `(${values.map(String).join(",")})`;
}

const BANDS: QualityBand[] = ["good", "acceptable", "bad", "unacceptable"];

/** One row per metric: aggregates, band counts + shares, thresholds, bad ids. */
export function qualityToCsv(report: QualityReport): string {
  const header = [
    "metric", "unit", "min", "mean", "max", "count", "failed",
    ...BANDS,
    ...BANDS.map((b) => `pct_${b}`),
    "threshold_1", "threshold_2", "threshold_3",
    "bad_entity_ids",
  ].join(",");
  const lines = [header];
  for (const m of report.metrics) lines.push(qualityRow(m));
  return lines.join("\n") + "\n";
}

function qualityRow(m: MetricResult): string {
  return [
    csvField(m.label),
    csvField(m.unit ?? ""),
    String(m.min),
    String(m.mean),
    String(m.max),
    String(m.count),
    String(m.failed),
    ...BANDS.map((b) => String(m.bands[b])),
    ...BANDS.map((b) => String(m.bandPct[b])),
    ...m.thresholds.map(String),
    csvField(exportIdList(m.badEntityIds)),
  ].join(",");
}

function boxRow(field: string, s: BoxStats, smallIds: string, bigIds: string): string {
  return [
    field,
    String(s.count),
    String(s.min),
    String(s.q1),
    String(s.median),
    String(s.q3),
    String(s.max),
    String(s.mean),
    String(s.std),
    String(s.iqr),
    String(s.whiskerLo),
    String(s.whiskerHi),
    csvField(smallIds),
    csvField(bigIds),
  ].join(",");
}

/** Two rows — nodal stats, then element stats with the outlier id lists. */
export function meshSizeToCsv(result: MeshSizeResult): string {
  const header = [
    "field", "count", "min", "q1", "median", "q3", "max", "mean", "std", "iqr",
    "whisker_lo", "whisker_hi", "small_ids", "big_ids",
  ].join(",");
  return [
    header,
    boxRow("nodal", result.nodalStats, "", ""),
    boxRow(
      "element",
      result.elementStats,
      exportIdList(result.smallElementIds),
      exportIdList(result.bigElementIds)
    ),
  ].join("\n") + "\n";
}

function integralRow(
  variable: string,
  components: number,
  label: string,
  t: IntegralTotals
): string {
  return [
    csvField(variable),
    String(components),
    csvField(label),
    csvField(tup(t.total)),
    csvField(tup(t.mean)),
    csvField(tup(t.measure)),
    String(t.numCells),
    String(t.numSkipped),
  ].join(",");
}

/** One row per variable for the whole mesh, plus one row per named region. */
export function integralsToCsv(integrals: FieldIntegral[]): string {
  const lines = ["variable,components,region,total,mean,measure,cells,skipped"];
  for (const it of integrals) {
    lines.push(integralRow(it.variable, it.components, "whole mesh", it.domain));
    for (const g of it.regions) lines.push(integralRow(it.variable, it.components, g.name, g));
  }
  return lines.join("\n") + "\n";
}
