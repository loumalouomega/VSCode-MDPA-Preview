/**
 * The tables of a Kratos materials JSON file as scientific-plot recipes. Pure:
 * no vscode, no fs. The file is read by the caller and handed over as parsed
 * JSON, so the same code serves the Preview Material Tables command, the
 * Materials form's link and the tests.
 *
 * Kratos' layout: `properties[].Material.Tables.<id>` is
 * `{input_variable, output_variable, data: [[in, out], …]}`, and the owning
 * `properties[]` entry names its `model_part_name` and `properties_id`. The same
 * shape the generator writes (`buildMaterials` in `generate.ts`), but any
 * materials file with Tables reads — a hand-written one included.
 *
 * Decisions that are claims, and so stated here:
 * - Tolerant per table: a malformed table or row is skipped with a note, never
 *   fatal, and the notes reach the user. Nothing here edits or rewrites the file.
 * - Tables are grouped by their (input, output) variable pair, because a plot
 *   with mixed axes would be meaningless. One recipe per group.
 * - Columns carry NO unit: a materials file does not declare one, and this
 *   module does not infer one from a variable name (the plot library's rule).
 * - Rows are drawn in file order, not sorted: a table whose inputs do not
 *   increase is a defect in the file Kratos will reject or misread, and the
 *   chart should show it rather than hide it. A note says so.
 */

import type { PlotRecipe, PlotSeriesSpec, PlotSource } from "../parser/plot/types";
import type { CaseState, MaterialLawSpec } from "./types";
import { plotPoints } from "./materialTablePlot";
import { textToRows } from "./materialTables";

/** One table found in a materials file. */
export interface MaterialTable {
  /** Human label: the model part (or properties id) and the table id. */
  label: string;
  modelPart?: string;
  propertiesId?: number;
  tableId: string;
  inputVariable: string;
  outputVariable: string;
  rows: [number, number][];
}

export interface MaterialsTablesRead {
  tables: MaterialTable[];
  notes: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Reads every drawable table of a parsed materials document. */
export function materialsTables(json: unknown): MaterialsTablesRead {
  const tables: MaterialTable[] = [];
  const notes: string[] = [];
  if (!isObject(json) || !Array.isArray(json.properties)) {
    return { tables, notes: ['Not a Kratos materials file: no "properties" list.'] };
  }
  json.properties.forEach((entry: unknown, index: number) => {
    if (!isObject(entry)) {
      notes.push(`properties[${index}] is not an object; skipped.`);
      return;
    }
    const material = entry.Material;
    if (!isObject(material) || material.Tables === undefined) return; // a material without tables is ordinary
    const modelPart = typeof entry.model_part_name === "string" && entry.model_part_name !== "" ? entry.model_part_name : undefined;
    const propertiesId = typeof entry.properties_id === "number" && Number.isFinite(entry.properties_id) ? entry.properties_id : undefined;
    const owner = modelPart ?? (propertiesId !== undefined ? `properties ${propertiesId}` : `properties[${index}]`);
    if (!isObject(material.Tables)) {
      notes.push(`${owner}: "Tables" is not an object; skipped.`);
      return;
    }
    for (const [tableId, raw] of Object.entries(material.Tables)) {
      const where = `${owner} · ${tableId}`;
      if (!isObject(raw)) {
        notes.push(`${where}: not a table object; skipped.`);
        continue;
      }
      const input = raw.input_variable;
      const output = raw.output_variable;
      if (typeof input !== "string" || input === "" || typeof output !== "string" || output === "") {
        notes.push(`${where}: needs input_variable and output_variable names; skipped.`);
        continue;
      }
      if (!Array.isArray(raw.data)) {
        notes.push(`${where}: "data" is not a list of [input, output] pairs; skipped.`);
        continue;
      }
      const rows: [number, number][] = [];
      let dropped = 0;
      for (const pair of raw.data) {
        if (Array.isArray(pair) && pair.length === 2 && pair.every((v) => typeof v === "number" && Number.isFinite(v))) {
          rows.push([pair[0] as number, pair[1] as number]);
        } else {
          dropped++;
        }
      }
      if (dropped > 0) notes.push(`${where}: ${dropped} row(s) are not a pair of finite numbers and are not drawn.`);
      if (rows.length === 0) {
        notes.push(`${where}: no drawable rows; skipped.`);
        continue;
      }
      if (rows.some((r, i) => i > 0 && !(r[0] > rows[i - 1][0]))) {
        notes.push(`${where}: the input column does not strictly increase; Kratos interpolates a table in order, so check this file.`);
      }
      tables.push({ label: where, modelPart, propertiesId, tableId, inputVariable: input, outputVariable: output, rows });
    }
  });
  if (tables.length === 0 && notes.length === 0) notes.push("The file has no material Tables to plot.");
  return { tables, notes };
}

/**
 * The tables of the materials on screen (the case state), before anything is
 * generated. A table being typed is often half-valid, so the rows that parse are
 * drawn and the rest are named in a note instead of refusing the whole table.
 */
export function materialTablesFromCase(laws: readonly MaterialLawSpec[], materials: CaseState["materials"]): MaterialsTablesRead {
  const tables: MaterialTable[] = [];
  const notes: string[] = [];
  for (const m of materials) {
    const law = laws.find((l) => l.id === m.lawId);
    for (const t of law?.tables ?? []) {
      const where = `${m.smpPath} · ${t.id}`;
      const { rows, problems } = textToRows(m.values[t.dataField]);
      const points = plotPoints(rows).map((p): [number, number] => [p.x, p.y]);
      if (problems.length > 0) notes.push(`${where}: ${problems.join("; ")}`);
      if (points.length === 0) continue;
      tables.push({ label: where, modelPart: m.smpPath, tableId: t.id, inputVariable: t.inputVariable, outputVariable: t.outputVariable, rows: points });
    }
  }
  if (tables.length === 0 && notes.length === 0) notes.push("No material in this case has a table to plot.");
  return { tables, notes };
}

/** One chart: every table that shares a variable pair. */
export interface MaterialsPlot {
  title: string;
  recipe: PlotRecipe;
  notes: string[];
}

/** More tables than the plot recipe takes sources for (32); the rest fold into a note. */
export const MATERIALS_MAX_TABLES_PER_PLOT = 32;

/** One recipe per (input, output) variable pair, one line per table. */
export function materialsPlotRecipes(read: MaterialsTablesRead, fileLabel: string): MaterialsPlot[] {
  const groups = new Map<string, MaterialTable[]>();
  for (const t of read.tables) {
    const key = `${t.inputVariable}\u0000${t.outputVariable}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const plots: MaterialsPlot[] = [];
  for (const members of groups.values()) {
    const { inputVariable, outputVariable } = members[0];
    const notes = [...read.notes];
    const shown = members.slice(0, MATERIALS_MAX_TABLES_PER_PLOT);
    if (members.length > shown.length) notes.push(`${members.length} tables share ${outputVariable} against ${inputVariable}; the first ${shown.length} are drawn.`);
    const sources: PlotSource[] = shown.map((t, i) => ({
      id: `t${i}`,
      type: "inline",
      table: {
        columns: [
          { id: "x", label: inputVariable, type: "number" },
          { id: "y", label: outputVariable, type: "number" },
        ],
        rows: t.rows.map((r) => [r[0], r[1]]),
        diagnostics: [],
      },
    }));
    const series: PlotSeriesSpec[] = shown.map((t, i) => ({ id: `s${i}`, source: `t${i}`, name: t.label, x: "x", y: "y" }));
    const title = `${outputVariable} vs ${inputVariable} — ${fileLabel}`;
    plots.push({
      title,
      notes,
      recipe: {
        version: 1,
        sources,
        series,
        presentation: { family: "line", title, xLabel: inputVariable, yLabel: outputVariable, lineMode: "lines+markers", panels: 1 },
      },
    });
  }
  return plots;
}
