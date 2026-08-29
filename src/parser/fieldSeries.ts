/**
 * Field time series: one entity's value for one variable across every step of
 * a time series — the "what was it three steps ago" counterpart of the Data
 * table's "what is it here".
 *
 * PURE: no vscode, no DOM and no `node:*`, because the webview imports
 * `seriesToCsv` to hand a finished series to the host for saving. The scan
 * itself reads files and therefore lives next door in `fieldSeriesScan.ts`;
 * the split line is exactly "does the webview need it".
 *
 * Three rules that are load-bearing rather than incidental:
 *
 *  - A gap is `null`, never `undefined`: `JSON.stringify` DROPS an undefined
 *    array element, which would shift every later step by one on the MCP path.
 *  - "no value here" is split into `missingField` and `missingId`, because
 *    "this variable is not written at this step" and "this id does not exist
 *    at this step" are different problems with different fixes.
 *  - A step that fails to parse is recorded and skipped, never fatal: a
 *    half-written file from a running solver is the normal case, and one bad
 *    file must not lose the other ninety-nine.
 */

import { componentColumnNames, csvField } from "./dataTable";
import { FieldBlockKind, MdpaModel } from "./types";

export interface FieldSeriesSpec {
  kind: FieldBlockKind;
  variable: string;
  entityId: number;
}

/** Why a step produced no value. Never merged into one count — see the header. */
export type SampleMiss = "no-field" | "no-id";

export interface FieldSample {
  components: number;
  values: number[];
  /** Size fingerprint, so a mesh that changes shape mid-series is detectable. */
  nodeCount: number;
  cellCount: number;
}

/** One step of a timeline, and how to get its model. */
export interface SeriesStep {
  /** The timeline's own label for this step — the chart's x tick. */
  label: string;
  /** Index into the timeline, so a click on the chart can request that frame. */
  frameIndex: number;
  load(): Promise<MdpaModel>;
}

export interface FieldSeries {
  kind: FieldBlockKind;
  variable: string;
  entityId: number;
  /** Components of the first successful sample; 0 when nothing was found. */
  components: number;
  componentNames: string[];
  labels: string[];
  frameIndices: number[];
  /** One entry per step. `null` is a gap — see the header on why not undefined. */
  values: (number[] | null)[];
  present: number;
  missingField: number;
  missingId: number;
  errors: { label: string; message: string }[];
  /** First step whose node/cell counts differ from the first sample's. */
  topologyChangedAt?: number;
  cancelled: boolean;
}

function cellCount(model: MdpaModel): number {
  let n = 0;
  for (const b of model.blocks) n += b.count;
  return n;
}

/**
 * One step's value for one entity.
 *
 * The first `FieldData` matching kind+variable wins, and an id is looked up
 * with a plain `indexOf` — one lookup per step, so the id→index Map that
 * `fieldData.ts` builds for a whole-mesh render would be pure overhead here.
 */
export function sampleFieldAt(model: MdpaModel, spec: FieldSeriesSpec): FieldSample | SampleMiss {
  const field = model.fields.find((f) => f.kind === spec.kind && f.variable === spec.variable);
  if (!field) return "no-field";
  const row = field.ids.indexOf(spec.entityId);
  if (row < 0) return "no-id";
  const c = Math.max(1, field.components);
  const values: number[] = [];
  for (let k = 0; k < c; k++) values.push(field.values[row * c + k]);
  return { components: c, values, nodeCount: model.nodeCount, cellCount: cellCount(model) };
}

// ---- CSV --------------------------------------------------------------------

/**
 * The series as CSV: one row per step, one column per component. Reuses
 * `dataTable.ts`'s escaping rather than growing a second RFC4180 writer.
 *
 * A gap is an empty cell, matching the table's rule that an absent value is
 * never a fabricated 0.
 */
export function seriesToCsv(series: FieldSeries): string {
  const names = series.componentNames.length > 0 ? series.componentNames : [series.variable];
  const header = ["step", "frame", ...names].map(csvField).join(",");
  const lines = [header];
  for (let i = 0; i < series.labels.length; i++) {
    const v = series.values[i];
    const cells = [csvField(series.labels[i]), String(series.frameIndices[i])];
    for (let c = 0; c < names.length; c++) cells.push(v ? String(v[c]) : "");
    lines.push(cells.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
