/**
 * The Inspect panel's Evaluation table: every pick appends one row holding
 * the frame label it was taken at, the entity kind/id, the nearest node's
 * coordinates and every field value in its display unit.
 *
 * Pure (no vscode/DOM), bundled into the webview and Node-tested. Rows are
 * snapshots: they keep their frame label and their numbers, so scrubbing the
 * timeline afterwards changes nothing in the table. Values are stored already
 * divided by the display scale (`displayed = raw / scale`, see
 * `fieldDimensions.ts`) with the unit label next to them; the stored samples
 * of the model are never touched.
 */

import { csvField } from "./dataTable";

export interface EvaluationFieldInput {
  variable: string;
  value: number | readonly number[];
  /** Display unit label, when the field's dimensions are known. */
  unit?: string;
  /** Divisor for the display unit (`displayed = raw / scale`); default 1. */
  scale?: number;
}

export interface EvaluationPick {
  /** Timeline step label; undefined for a mesh with no timeline. */
  frame?: string;
  /** Entity kind ("Element", "Condition", "Geometry") or "Node" for a bare node pick. */
  kind: string;
  id: number;
  /** The nearest node, when the pick resolved one. */
  nodeId?: number;
  coords?: readonly [number, number, number];
  fields: readonly EvaluationFieldInput[];
}

export interface EvaluationValue {
  variable: string;
  unit?: string;
  /** Already in the display unit. */
  values: number[];
}

export interface EvaluationRow {
  frame: string;
  kind: string;
  id: number;
  nodeId?: number;
  coords?: [number, number, number];
  values: EvaluationValue[];
}

/** Rows kept at most; the oldest are dropped past it. */
export const EVALUATION_MAX_ROWS = 500;

export function buildEvaluationRow(pick: EvaluationPick): EvaluationRow {
  const values: EvaluationValue[] = [];
  for (const f of pick.fields) {
    const scale = f.scale !== undefined && f.scale > 0 ? f.scale : 1;
    const raw = typeof f.value === "number" ? [f.value] : Array.from(f.value);
    values.push({ variable: f.variable, unit: f.unit, values: raw.map((v) => v / scale) });
  }
  return {
    frame: pick.frame ?? "",
    kind: pick.kind,
    id: pick.id,
    nodeId: pick.nodeId,
    coords: pick.coords ? [pick.coords[0], pick.coords[1], pick.coords[2]] : undefined,
    values,
  };
}

/** Appends a row, dropping the oldest beyond `EVALUATION_MAX_ROWS`. Returns a new array. */
export function appendEvaluationRow(rows: readonly EvaluationRow[], row: EvaluationRow): EvaluationRow[] {
  const next = [...rows, row];
  return next.length > EVALUATION_MAX_ROWS ? next.slice(next.length - EVALUATION_MAX_ROWS) : next;
}

const AXES = ["X", "Y", "Z"];

function columnNames(variable: string, unit: string | undefined, width: number): string[] {
  const suffix = unit ? ` [${unit}]` : "";
  if (width === 1) return [`${variable}${suffix}`];
  return Array.from({ length: width }, (_, i) => `${variable}_${width <= 3 ? AXES[i] : i}${suffix}`);
}

export interface EvaluationColumns {
  /** Header cells, fixed columns first. */
  header: string[];
  /** Keys of the value columns, in header order after the fixed ones. */
  keys: string[];
}

const FIXED = ["frame", "kind", "id", "node", "x", "y", "z"];

/**
 * Column set over all rows, by first appearance. A variable shown in two
 * different units gets two columns, so one column never mixes units.
 */
export function evaluationColumns(rows: readonly EvaluationRow[]): EvaluationColumns {
  const header = [...FIXED];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const v of r.values) {
      columnNames(v.variable, v.unit, v.values.length).forEach((n) => {
        if (seen.has(n)) return;
        seen.add(n);
        header.push(n);
        keys.push(n);
      });
    }
  }
  return { header, keys };
}

function rowCells(row: EvaluationRow, keys: readonly string[]): string[] {
  const byKey = new Map<string, number>();
  for (const v of row.values) {
    columnNames(v.variable, v.unit, v.values.length).forEach((n, i) => byKey.set(n, v.values[i]));
  }
  const cells = [
    row.frame,
    row.kind,
    String(row.id),
    row.nodeId === undefined ? "" : String(row.nodeId),
    ...(row.coords ? row.coords.map(String) : ["", "", ""]),
  ];
  for (const k of keys) {
    const v = byKey.get(k);
    cells.push(v === undefined ? "" : String(v));
  }
  return cells;
}

/** The table as a 2D string grid (header first); the panel renders it and Copy joins it. */
export function evaluationGrid(rows: readonly EvaluationRow[]): string[][] {
  const { header, keys } = evaluationColumns(rows);
  return [header, ...rows.map((r) => rowCells(r, keys))];
}

/** CSV, raw file precision (`String(v)`), CRLF rows like the other analysis exports. */
export function evaluationToCsv(rows: readonly EvaluationRow[]): string {
  return evaluationGrid(rows).map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** Tab-separated text for the clipboard (pastes into a spreadsheet). */
export function evaluationToTsv(rows: readonly EvaluationRow[]): string {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ");
  return evaluationGrid(rows).map((r) => r.map(clean).join("\t")).join("\n") + "\n";
}
