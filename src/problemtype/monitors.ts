/**
 * monitors.ts — saved POST-RUN monitors (roadmap item 8). Pure: no vscode, no
 * fs, no wasm, so the whole rulebook is Node-testable (the `convergence.ts`
 * arrangement); `monitorsFile.ts` is the `node:fs` half.
 *
 * A monitor is a saved, named, portable definition of a quantity the plotting
 * library can already sample frame by frame: a point value (`history`, one
 * entity of one field) or a regional quantity (`region`, e.g. a boundary mean
 * or a flux). It carries NO result path — it is evaluated against whatever
 * saved frames the owning case currently has — and no numerics of its own, so
 * a monitor and the equivalent plot recipe cannot disagree.
 *
 * Decisions that are claims, and so stated here:
 * - Evaluation reads SAVED frames. It is not a live solver monitor: values
 *   exist only for the output cadence the solver wrote.
 * - `stride` thins the saved frames after the fact (every Nth, always keeping
 *   the first and last). It is a post-run sampling interval, independent of the
 *   solver's output frequency, and never interpolates between frames.
 * - A value that cannot be computed (field, entity, region or frame missing) is
 *   `null`, a gap — never 0.
 * - `unit` is a label only. Nothing is converted, and a monitor with no unit
 *   (declared or read from the file) says "unit undeclared" rather than
 *   implying one.
 */

import { REGION_OPERATIONS } from "../parser/plot/types";
import type { PlotRecipe, PlotSeriesSpec, PlotSource, PlotTable, RegionOperation } from "../parser/plot/types";
import type { SeriesStep } from "../parser/fieldSeries";
import type { FieldBlockKind } from "../parser/types";
import { csvField } from "../parser/dataTable";

export const MONITORS_VERSION = 1;
/** More monitors than this make a sidecar nobody can review; the rest are refused by name. */
export const MONITORS_MAX = 64;
/** Largest accepted stride; beyond this a case has no useful samples left. */
export const MONITOR_MAX_STRIDE = 100000;

const KINDS: readonly FieldBlockKind[] = ["Nodal", "Elemental", "Conditional"];
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export type MonitorSource =
  | { type: "history"; kind: FieldBlockKind; entityId: number; variable: string }
  /**
   * A NODAL field interpolated at fixed coordinates. Unlike a `history`
   * monitor it names a place, not an entity id, so it survives remeshing; a
   * frame where the point is outside the mesh (or any corner has no value) is
   * a gap.
   */
  | { type: "point"; variable: string; coordinates: [number, number, number] }
  | {
      type: "region";
      kind: FieldBlockKind;
      variable: string;
      operation: RegionOperation;
      submodelpart?: string;
      component?: number | "magnitude";
      orientation?: "outward" | "winding";
      referencePoint?: [number, number, number];
      thickness?: number;
      pressureOffset?: number;
      pressureDensity?: number;
    };

export interface MonitorDefinition {
  /** Stable key (`[A-Za-z0-9_.-]`, at most 64 characters); also the plot source id. */
  id: string;
  name: string;
  source: MonitorSource;
  /** Evaluate every Nth saved frame (first and last always kept). Default 1. */
  stride?: number;
  /** A label for the value columns when the result file declares none. Never converted. */
  unit?: string;
  note?: string;
}

export interface ParsedMonitors {
  monitors: MonitorDefinition[];
  warnings: string[];
  /** False when the text was not a monitors document at all (a writer must not replace it). */
  readable: boolean;
  /** True for a document written by a newer version: parsed as empty, never to be overwritten. */
  newerVersion: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finiteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined;

/**
 * Validates one monitor entry. Exported so MCP `case_monitors set` and the
 * sidecar reader share one authority; returns the reason when refused.
 */
export function validateMonitor(raw: unknown): { monitor?: MonitorDefinition; problem?: string } {
  if (!isObject(raw)) return { problem: "A monitor must be an object." };
  const id = typeof raw.id === "string" ? raw.id : undefined;
  if (!id || !ID_PATTERN.test(id)) return { problem: "A monitor needs an id of 1–64 letters, digits, '_', '.' or '-'." };
  const src = raw.source;
  if (!isObject(src)) return { problem: `Monitor ${id}: source is missing.` };
  const variable = text(src.variable, 128);
  if (!variable) return { problem: `Monitor ${id}: source.variable is required.` };
  const kind = (src.type === "point" ? "Nodal" : src.kind) as FieldBlockKind;
  if (!KINDS.includes(kind)) return { problem: `Monitor ${id}: source.kind must be one of ${KINDS.join(", ")}.` };

  let source: MonitorSource;
  if (src.type === "point") {
    const c = src.coordinates;
    if (!Array.isArray(c) || c.length !== 3 || !c.every(finiteNumber)) {
      return { problem: `Monitor ${id}: a coordinate monitor needs source.coordinates as three finite numbers.` };
    }
    source = { type: "point", variable, coordinates: [c[0], c[1], c[2]] };
  } else if (src.type === "history") {
    if (!Number.isInteger(src.entityId) || (src.entityId as number) < 0) {
      return { problem: `Monitor ${id}: a point monitor needs an integer source.entityId.` };
    }
    source = { type: "history", kind, entityId: src.entityId as number, variable };
  } else if (src.type === "region") {
    const operation = src.operation as RegionOperation;
    if (!REGION_OPERATIONS.includes(operation)) {
      return { problem: `Monitor ${id}: source.operation must be one of ${REGION_OPERATIONS.join(", ")}.` };
    }
    const region: MonitorSource & { type: "region" } = { type: "region", kind, variable, operation };
    if (src.submodelpart !== undefined) {
      const part = text(src.submodelpart, 512);
      if (!part) return { problem: `Monitor ${id}: source.submodelpart must be a non-empty path.` };
      region.submodelpart = part;
    }
    if (src.component !== undefined) {
      if (src.component === "magnitude" || (Number.isInteger(src.component) && (src.component as number) >= 0 && (src.component as number) < 32)) {
        region.component = src.component as number | "magnitude";
      } else return { problem: `Monitor ${id}: source.component must be "magnitude" or a component index.` };
    }
    if (src.orientation !== undefined) {
      if (src.orientation !== "outward" && src.orientation !== "winding") {
        return { problem: `Monitor ${id}: source.orientation must be "outward" or "winding".` };
      }
      region.orientation = src.orientation;
    }
    if (src.referencePoint !== undefined) {
      const p = src.referencePoint;
      if (!Array.isArray(p) || p.length !== 3 || !p.every(finiteNumber)) {
        return { problem: `Monitor ${id}: source.referencePoint must be three finite numbers.` };
      }
      region.referencePoint = [p[0], p[1], p[2]];
    } else if (operation === "reactionMoment" || operation === "pressureMoment") {
      return { problem: `Monitor ${id}: ${operation} needs source.referencePoint (the moment origin is never assumed).` };
    }
    for (const key of ["thickness", "pressureOffset", "pressureDensity"] as const) {
      if (src[key] === undefined) continue;
      if (!finiteNumber(src[key]) || (key !== "pressureOffset" && (src[key] as number) <= 0)) {
        return { problem: `Monitor ${id}: source.${key} must be a finite ${key === "pressureOffset" ? "number" : "positive number"}.` };
      }
      region[key] = src[key] as number;
    }
    source = region;
  } else {
    return { problem: `Monitor ${id}: source.type must be "history", "region" or "point".` };
  }

  const monitor: MonitorDefinition = { id, name: text(raw.name, 120) ?? id, source };
  if (raw.stride !== undefined) {
    if (!Number.isInteger(raw.stride) || (raw.stride as number) < 1 || (raw.stride as number) > MONITOR_MAX_STRIDE) {
      return { problem: `Monitor ${id}: stride must be an integer from 1 to ${MONITOR_MAX_STRIDE}.` };
    }
    if ((raw.stride as number) > 1) monitor.stride = raw.stride as number;
  }
  if (raw.unit !== undefined) {
    const unit = text(raw.unit, 32);
    if (!unit) return { problem: `Monitor ${id}: unit must be a short non-empty label.` };
    monitor.unit = unit;
  }
  if (raw.note !== undefined) {
    const note = text(raw.note, 500);
    if (note) monitor.note = note;
  }
  return { monitor };
}

/**
 * Tolerant read of `<stem>.kratosmonitors.json`: a bad entry is dropped with a
 * warning and the rest survive, a duplicate id keeps the first, an unreadable
 * document is empty-and-unreadable, and a newer version is empty and flagged so
 * a writer never downgrades it.
 */
export function parseMonitorsJson(input: string): ParsedMonitors {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(input);
  } catch (err) {
    return { monitors: [], warnings: [`The monitors file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`], readable: false, newerVersion: false };
  }
  if (!isObject(doc) || !Array.isArray(doc.monitors)) {
    return { monitors: [], warnings: ["The monitors file has no \"monitors\" list."], readable: false, newerVersion: false };
  }
  if (typeof doc.version === "number" && doc.version > MONITORS_VERSION) {
    return {
      monitors: [],
      warnings: [`The monitors file was written by a newer version (${doc.version}); it is ignored and will not be overwritten.`],
      readable: true,
      newerVersion: true,
    };
  }
  const monitors: MonitorDefinition[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of doc.monitors.entries()) {
    if (monitors.length >= MONITORS_MAX) {
      warnings.push(`Only the first ${MONITORS_MAX} monitors are used; ${doc.monitors.length - i} more were ignored.`);
      break;
    }
    const { monitor, problem } = validateMonitor(raw);
    if (!monitor) {
      warnings.push(`Monitor ${i + 1} ignored: ${problem}`);
      continue;
    }
    if (seen.has(monitor.id)) {
      warnings.push(`Monitor "${monitor.id}" is defined twice; the first definition is kept.`);
      continue;
    }
    seen.add(monitor.id);
    monitors.push(monitor);
  }
  return { monitors, warnings, readable: true, newerVersion: false };
}

export function serializeMonitors(monitors: readonly MonitorDefinition[]): string {
  return `${JSON.stringify({ version: MONITORS_VERSION, monitors }, null, 2)}\n`;
}

/**
 * A fresh, valid id and a readable name for a point monitor saved from the
 * viewer (`<variable>_<kind letter><entity id>`), suffixed `_2`… against the
 * ids already in the case so saving never silently replaces another monitor.
 */
export function suggestMonitor(
  spec: { kind: FieldBlockKind; entityId: number; variable: string },
  existing: readonly Pick<MonitorDefinition, "id">[]
): { id: string; name: string } {
  const base = `${spec.variable.replace(/[^A-Za-z0-9_.-]/g, "_")}_${spec.kind[0]}${spec.entityId}`.slice(0, 60);
  const taken = new Set(existing.map((m) => m.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  const noun = spec.kind === "Nodal" ? "node" : spec.kind === "Elemental" ? "element" : "condition";
  return { id, name: `${spec.variable} at ${noun} ${spec.entityId}` };
}

/** Adds or replaces (by id) one definition; the order of existing monitors is kept. */
export function upsertMonitor(monitors: readonly MonitorDefinition[], monitor: MonitorDefinition): MonitorDefinition[] {
  const at = monitors.findIndex((m) => m.id === monitor.id);
  if (at < 0) {
    if (monitors.length >= MONITORS_MAX) throw new Error(`A case holds at most ${MONITORS_MAX} monitors.`);
    return [...monitors, monitor];
  }
  return monitors.map((m, i) => (i === at ? monitor : m));
}

/** True for monitors the plot library samples itself (everything but coordinate points). */
export const isPlotMonitor = (d: MonitorDefinition): d is MonitorDefinition & { source: Exclude<MonitorSource, { type: "point" }> } =>
  d.source.type !== "point";

/** The plot-library sources for the `history`/`region` monitors of `defs`, bound to one result file. */
export function monitorSources(defs: readonly MonitorDefinition[], resultPath: string): Extract<PlotSource, { type: "history" | "region" }>[] {
  return defs.filter(isPlotMonitor).map((d) => {
    const s = d.source;
    return s.type === "history"
      ? { id: d.id, type: "history" as const, path: resultPath, kind: s.kind, entityId: s.entityId, variable: s.variable }
      : { id: d.id, path: resultPath, scope: "history" as const, ...s };
  }) as Extract<PlotSource, { type: "history" | "region" }>[];
}

/**
 * Every Nth step, always keeping the first and the last (the last is the
 * "current value" of a monitor, so thinning must never lose it).
 */
export function strideSteps<T>(steps: readonly T[], stride: number | undefined): T[] {
  const n = Math.max(1, Math.floor(stride ?? 1));
  if (n === 1 || steps.length <= 2) return [...steps];
  const out: T[] = [];
  for (let i = 0; i < steps.length; i += n) out.push(steps[i]);
  if (out[out.length - 1] !== steps[steps.length - 1]) out.push(steps[steps.length - 1]);
  return out;
}

/** Groups definitions by stride so each distinct stride parses its frames once. */
export function groupByStride(defs: readonly MonitorDefinition[]): Map<number, MonitorDefinition[]> {
  const groups = new Map<number, MonitorDefinition[]>();
  for (const d of defs) {
    const stride = d.stride ?? 1;
    groups.set(stride, [...(groups.get(stride) ?? []), d]);
  }
  return groups;
}

export type MonitorStepLike = Pick<SeriesStep, "label" | "frameIndex">;

export interface MonitorSummary {
  id: string;
  name: string;
  /** The declared/read unit, else the definition's label; absent means undeclared. */
  unit?: string;
  columns: string[];
  frames: number;
  /** Most recent frame with at least one finite value; null when there is none. */
  last: { time: number | string | null; frame: number; values: (number | null)[] } | null;
  /** Frames where no value could be computed. */
  gaps: number;
  partial: boolean;
  diagnostics: string[];
}

const EXTRA_COLUMNS = new Set(["covered", "measure"]);
const MAX_DIAGNOSTICS = 20;

/** The value columns of a monitor table (everything after time/frame except region coverage). */
export function valueColumnIndexes(table: PlotTable): number[] {
  const out: number[] = [];
  for (let c = 2; c < table.columns.length; c++) if (!EXTRA_COLUMNS.has(table.columns[c].id)) out.push(c);
  return out;
}

export function summarizeMonitor(table: PlotTable, def: MonitorDefinition): MonitorSummary {
  const cols = valueColumnIndexes(table);
  const unit = cols.map((c) => table.columns[c].unit).find((u) => u) ?? def.unit;
  let last: MonitorSummary["last"] = null;
  let gaps = 0;
  for (const row of table.rows) {
    const values = cols.map((c) => (typeof row[c] === "number" && Number.isFinite(row[c] as number) ? (row[c] as number) : null));
    if (values.every((v) => v === null)) { gaps++; continue; }
    last = { time: (row[0] as number | string | null) ?? null, frame: row[1] as number, values };
  }
  return {
    id: def.id,
    name: def.name,
    ...(unit ? { unit } : {}),
    columns: cols.map((c) => table.columns[c].label),
    frames: table.rows.length,
    last,
    gaps,
    partial: !!table.partial,
    diagnostics: table.diagnostics.slice(0, MAX_DIAGNOSTICS),
  };
}

const sci = (v: number): string => (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5) ? v.toExponential(2) : String(Number(v.toPrecision(4))));

/** The one-line label for the Kratos Runs tree. Decisions live here, not in the view. */
export function monitorRowText(summaries: readonly MonitorSummary[], saved: number): string {
  if (saved === 0) return "Monitors — none saved";
  if (summaries.length === 0) return `Monitors — ${saved} saved`;
  const first = summaries[0];
  const v = first.last?.values.find((x) => x !== null);
  const tail = v !== undefined && v !== null ? ` · ${first.name} ${sci(v)}${first.unit ? ` ${first.unit}` : ""}` : "";
  return `Monitors — ${saved} saved${tail}`;
}

export interface MonitorResult {
  def: MonitorDefinition;
  table: PlotTable;
}

/**
 * Raw numbers, one row per saved frame present in any monitor (the union, by
 * frame index). A monitor thinned by its stride, or a gap, is blank — never 0.
 * Headers carry `[unit]`, or `[unit undeclared]` when nothing declares one.
 */
export function monitorsToCsv(results: readonly MonitorResult[]): string {
  const frames = new Map<number, number | string | null>();
  for (const { table } of results) for (const row of table.rows) if (!frames.has(row[1] as number)) frames.set(row[1] as number, (row[0] as number | string | null) ?? null);
  const order = [...frames.keys()].sort((a, b) => a - b);
  const header = ["frame", "time"];
  const lookups: { cols: number[]; byFrame: Map<number, (number | string | null)[]> }[] = [];
  for (const { def, table } of results) {
    const cols = valueColumnIndexes(table);
    for (const c of cols) {
      const unit = table.columns[c].unit ?? def.unit;
      header.push(csvField(`${def.name}: ${table.columns[c].label} [${unit ?? "unit undeclared"}]`));
    }
    lookups.push({ cols, byFrame: new Map(table.rows.map((r) => [r[1] as number, r as (number | string | null)[]])) });
  }
  const lines = [header.join(",")];
  for (const frame of order) {
    const cells = [String(frame), String(frames.get(frame) ?? "")];
    for (const { cols, byFrame } of lookups) {
      const row = byFrame.get(frame);
      for (const c of cols) {
        const v = row?.[c];
        cells.push(typeof v === "number" && Number.isFinite(v) ? String(v) : "");
      }
    }
    lines.push(cells.join(","));
  }
  return lines.join("\n") + "\n";
}

export interface MonitorPlot {
  recipe: PlotRecipe;
  notes: string[];
}

/**
 * The monitors as a scientific-plot recipe: one inline table per monitor, one
 * series per value column against the frame index. The frame index is the x
 * axis on purpose — filename steps are not physical time, and nothing here
 * maps them to any.
 */
export function monitorPlotRecipe(results: readonly MonitorResult[], title: string): MonitorPlot {
  const notes: string[] = [];
  const sources: PlotSource[] = [];
  const series: PlotSeriesSpec[] = [];
  for (const { def, table } of results) {
    const cols = valueColumnIndexes(table);
    if (cols.length === 0 || table.rows.length === 0) {
      notes.push(`${def.name}: no frames could be evaluated, so there is nothing to draw.`);
      continue;
    }
    const unit = cols.map((c) => table.columns[c].unit).find((u) => u) ?? def.unit;
    const trimmed: PlotTable = {
      columns: [table.columns[1], ...cols.map((c) => ({ ...table.columns[c], ...(unit && !table.columns[c].unit ? { unit } : {}) }))],
      rows: table.rows.map((r) => [r[1], ...cols.map((c) => r[c])]),
      diagnostics: [],
    };
    sources.push({ id: def.id, type: "inline", table: trimmed });
    for (const [k, c] of cols.entries()) {
      series.push({
        id: `${def.id}-${k}`,
        source: def.id,
        name: cols.length > 1 ? `${def.name}: ${table.columns[c].label}` : def.name,
        x: trimmed.columns[0].id,
        y: trimmed.columns[k + 1].id,
      });
    }
  }
  if (series.length === 0) notes.push("None of the monitors produced a value, so the chart is empty.");
  return {
    notes,
    recipe: {
      version: 1,
      sources,
      series,
      presentation: { family: "line", title, xLabel: "Frame index", lineMode: "lines+markers", panels: 1 },
    },
  };
}
