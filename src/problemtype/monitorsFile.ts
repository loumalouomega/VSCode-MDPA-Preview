/**
 * monitorsFile.ts — the `node:fs` half of the saved monitors (roadmap item 8),
 * kept apart from `monitors.ts` so the pure rules stay importable from anywhere
 * (the `convergenceFile.ts` arrangement).
 *
 * Evaluation reads the case's CURRENT saved outputs. It makes no ownership
 * claim: the run id is a label from the latest-run sidecar, not a verified
 * binding (legacy and shared-output ownership is roadmap item 9's, and a
 * monitor must never infer past ownership from a matching path).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { collectPlotHistorySteps } from "../parser/plot/sources";
import { discoverSeriesSteps } from "../parser/fieldSeriesScan";
import { componentColumnNames } from "../parser/dataTable";
import type { SeriesStep } from "../parser/fieldSeries";
import type { MdpaModel } from "../parser/types";
import { sampleNodalFieldAt } from "../parser/meshCompare";
import { verifyPlotRun } from "../parser/plot/runs";
import type { PlotColumn, PlotExecution, PlotRunBinding, PlotTable } from "../parser/plot/types";
import { exponentsForUnitName, fieldUnitLabel } from "../parser/fieldDimensions";
import { monitorsFilePath, runFilePath } from "./caseFile";
import {
  MonitorDefinition,
  MonitorResult,
  MonitorSummary,
  ParsedMonitors,
  groupByStride,
  isPlotMonitor,
  monitorSources,
  parseMonitorsJson,
  serializeMonitors,
  strideSteps,
  summarizeMonitor,
} from "./monitors";
import { discoverOutputs } from "./outputDiscovery";
import { parseRunJson, reconcileStatus } from "./runFile";
import { isPidAlive } from "./runProcess";

export interface MonitorsRead {
  file: string;
  /** False when no monitors file has been written (the ordinary state). */
  exists: boolean;
  parsed: ParsedMonitors;
}

export function readMonitors(meshPath: string): MonitorsRead {
  const file = monitorsFilePath(meshPath);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { file, exists: false, parsed: { monitors: [], warnings: [], readable: true, newerVersion: false } };
    return {
      file,
      exists: true,
      parsed: { monitors: [], warnings: [`The monitors file could not be read: ${err instanceof Error ? err.message : String(err)}`], readable: false, newerVersion: false },
    };
  }
  return { file, exists: true, parsed: parseMonitorsJson(text) };
}

/**
 * Replaces the case's monitors. Refuses to touch a file it could not parse or
 * that a newer version wrote — overwriting would silently discard it — and
 * writes through a temporary file so a crash never leaves half a document.
 */
export function writeMonitors(meshPath: string, monitors: readonly MonitorDefinition[]): string {
  const read = readMonitors(meshPath);
  if (read.exists && (!read.parsed.readable || read.parsed.newerVersion)) {
    throw new Error(`${path.basename(read.file)} is not a monitors file this version can update (${read.parsed.warnings[0] ?? "unreadable"}); it was left untouched.`);
  }
  const tmp = `${read.file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serializeMonitors(monitors));
  fs.renameSync(tmp, read.file);
  return read.file;
}

export interface EvaluateOptions extends Pick<PlotExecution, "signal" | "progress"> {
  /** Evaluate only these monitor ids (default: all). Unknown ids are reported, not ignored. */
  ids?: string[];
  /**
   * Evaluate against a verified isolated run instead of the case folder's
   * current outputs. `resultFile` must then be the bound result file; both are
   * checked before and after the scan, so a changed or substituted run fails
   * rather than being read.
   */
  run?: PlotRunBinding;
  resultFile?: string;
}

export interface MonitorEvaluation {
  meshPath: string;
  available: boolean;
  /** Why nothing was evaluated, when `available` is false. */
  reason?: string;
  resultFile?: string;
  /** A label from the latest-run sidecar. NOT a verified ownership binding unless `verifiedRun` is set. */
  runId?: string;
  /** Present only when the scan was bound to, and verified against, an isolated run's receipt. */
  verifiedRun?: { runId: string; ownerId: string; requestId: string; sourceRevision: string };
  runStatus?: string;
  /** True when the run did not finish, so the newest frame was left out and later frames may be missing. */
  partial: boolean;
  savedFrames: number;
  results: MonitorResult[];
  summaries: MonitorSummary[];
  notes: string[];
}

/** The latest run's reconciled status and id for a case, if a sidecar exists. */
function latestRun(meshPath: string): { status?: string; runId?: string } {
  try {
    const { sidecar } = parseRunJson(fs.readFileSync(runFilePath(meshPath), "utf8"));
    if (!sidecar) return {};
    const alive = sidecar.pid !== undefined ? isPidAlive(sidecar.pid) : undefined;
    return { status: reconcileStatus(sidecar, alive).status, runId: sidecar.runId };
  } catch {
    return {};
  }
}

/** A `point` monitor's table, filled one frame at a time by `sampleCoordinateMonitors`. */
function coordinateTable(inFile: boolean): PlotTable {
  return {
    columns: [
      { id: "time", label: inFile ? "Physical time" : "Step label", type: inFile ? "number" : "text", domain: inFile ? "physicalTime" : "stepLabel" },
      { id: "frame", label: "Frame index", type: "number", domain: "frameIndex" },
    ],
    rows: [],
    diagnostics: ["Value is interpolated at fixed coordinates in the source mesh, not at an entity; display deformation is not applied."],
    partial: false,
  };
}

/**
 * Samples every `point` monitor on one loaded frame. A point outside the mesh,
 * a corner with no value, a missing field or an unreadable mesh is a gap with
 * a diagnostic — never 0.
 */
async function sampleCoordinateMonitors(
  tables: Map<string, PlotTable>,
  defs: readonly MonitorDefinition[],
  model: MdpaModel | undefined,
  step: Pick<SeriesStep, "label" | "frameIndex">,
  inFile: boolean,
  error?: string
): Promise<void> {
  for (const def of defs) {
    if (def.source.type !== "point") continue;
    const table = tables.get(def.id)!;
    const width = table.columns.length - 2;
    const time: number | string = inFile ? Number(step.label) : step.label;
    let values: (number | null)[] | undefined;
    let problem = error;
    try {
      if (!model) throw new Error(problem ?? "frame could not be read");
      const field = model.fields.find((f) => f.kind === "Nodal" && f.variable === def.source.variable);
      if (!field) throw new Error(`No Nodal field "${def.source.variable}".`);
      const [x, y, z] = def.source.coordinates;
      const sample = await sampleNodalFieldAt(model, field, Float64Array.from([x, y, z]));
      if (!sample.covered[0]) throw new Error(`(${x}, ${y}, ${z}) is outside the mesh or touches nodes without a value.`);
      values = Array.from(sample.values.subarray(0, field.components), (v) => (Number.isFinite(v) ? v : null));
      if (width === 0) {
        const unit = model.source?.units?.fields?.[field.variable] ?? fieldUnitLabel(field);
        const dimensions = field.dimensions?.exponents.slice() ?? (unit ? exponentsForUnitName(unit) : undefined);
        for (const [k, label] of componentColumnNames(field.variable, field.components).entries()) {
          const col: PlotColumn = { id: `v${k}`, label, type: "number", ...(unit ? { unit } : {}), ...(dimensions ? { dimensions: [...dimensions] } : {}) };
          table.columns.push(col);
        }
      } else if (values.length !== width) {
        throw new Error("Field width changed; sample retained as a gap.");
      }
    } catch (e) {
      values = undefined;
      problem = e instanceof Error ? e.message : String(e);
      if (table.diagnostics.length < 20) table.diagnostics.push(`${step.label}: ${problem}`);
    }
    table.rows.push([time, step.frameIndex, ...(values ?? new Array(Math.max(width, 1)).fill(null))]);
  }
}

/**
 * Evaluates `defs` over already-discovered steps, each distinct stride parsing
 * its frames once (coordinate monitors are sampled on the very frame the plot
 * library loaded, so they add no parse). Split out so the numerics are testable
 * with in-memory steps (`SeriesStep.load` is the only thing the extraction
 * touches).
 */
export async function monitorTables(
  defs: readonly MonitorDefinition[],
  steps: readonly SeriesStep[],
  inFile: boolean,
  resultFile: string,
  opts: Pick<PlotExecution, "signal" | "progress"> = {}
): Promise<MonitorResult[]> {
  const byId = new Map<string, MonitorResult>();
  for (const [stride, group] of groupByStride(defs)) {
    const coordinate = new Map<string, PlotTable>();
    for (const d of group) if (d.source.type === "point") coordinate.set(d.id, coordinateTable(inFile));
    const plotDefs = group.filter(isPlotMonitor);
    // The tap runs once per loaded frame, whichever extraction drives the loop.
    const tapped: SeriesStep[] = strideSteps(steps, stride).map((step) => ({
      ...step,
      load: async () => {
        let model: MdpaModel | undefined, error: string | undefined;
        try {
          model = await step.load();
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        if (coordinate.size) await sampleCoordinateMonitors(coordinate, group, model, step, inFile, error);
        if (!model) throw new Error(error);
        return model;
      },
    }));
    if (plotDefs.length) {
      const tables = await collectPlotHistorySteps(monitorSources(plotDefs, resultFile), tapped, inFile, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.progress ? { progress: opts.progress } : {}),
      });
      for (const def of plotDefs) byId.set(def.id, { def, table: tables[def.id] as PlotTable });
    } else {
      for (const [i, step] of tapped.entries()) {
        opts.signal?.throwIfAborted();
        opts.progress?.(i, tapped.length, step.label);
        await step.load().catch(() => undefined);
      }
    }
    for (const def of group) if (def.source.type === "point") {
      const table = coordinate.get(def.id)!;
      // Frames that failed before the field width was known hold a single placeholder gap.
      table.rows = table.rows.map((r) => Array.from({ length: table.columns.length }, (_, i) => r[i] ?? null));
      table.partial = table.rows.some((r) => r.slice(2).some((v) => v === null)) || table.columns.length === 2;
      byId.set(def.id, { def, table });
    }
  }
  return defs.map((d) => byId.get(d.id)!);
}

export async function evaluateMonitors(
  meshPath: string,
  defs: readonly MonitorDefinition[],
  opts: EvaluateOptions = {}
): Promise<MonitorEvaluation> {
  const abs = path.resolve(meshPath);
  const notes: string[] = [];
  const base = { meshPath: abs, partial: false, savedFrames: 0, results: [] as MonitorResult[], summaries: [] as MonitorSummary[] };

  let selected = [...defs];
  if (opts.ids) {
    const wanted = new Set(opts.ids);
    selected = selected.filter((d) => wanted.has(d.id));
    for (const id of wanted) if (!selected.some((d) => d.id === id)) notes.push(`No monitor "${id}" is saved for this case.`);
  }
  if (selected.length === 0) {
    return { ...base, available: false, reason: defs.length === 0 ? "No monitors are saved for this case." : "No saved monitor matches.", notes };
  }

  let resultFile: string;
  let steps: SeriesStep[];
  let source: "files" | "inFile" | "single";
  let status: string | undefined;
  let runId: string | undefined;
  let partial = false;
  if (opts.run) {
    if (!opts.resultFile) throw new Error("Evaluating against a bound run needs the bound result file (resultFile).");
    resultFile = path.resolve(opts.resultFile);
    const identity = await verifyPlotRun(opts.run, resultFile, opts.signal);
    steps = identity.steps;
    source = identity.timeline;
    runId = opts.run.runId;
    status = "finished";
    notes.push(`Bound to run ${opts.run.runId}: the receipt and the source/companion content revisions were verified before and after the scan.`);
  } else {
    const discovered = discoverOutputs(path.dirname(abs));
    const first = discovered.results[0];
    if (!first) {
      return { ...base, available: false, reason: "The case has no saved result files yet (no output has been written, or it is outside the configured output folders).", notes };
    }
    resultFile = first;
    ({ status, runId } = latestRun(abs));
    const found = await discoverSeriesSteps(resultFile);
    steps = found.steps;
    source = found.source;
    // A run that did not finish may have a truncated final step (the VTK writer is not atomic).
    partial = status !== undefined && status !== "finished";
    if (partial && source === "files" && steps.length > 1) {
      steps = steps.slice(0, -1);
      notes.push(`The run is ${status}, so its newest saved frame was left out (it may be incomplete).`);
    }
    notes.push("Values come from the case's current saved outputs; this is not a verified binding to one run.");
  }

  const results = await monitorTables(selected, steps, source === "inFile", resultFile, opts);
  if (opts.run) await verifyPlotRun(opts.run, resultFile, opts.signal);
  return {
    ...base,
    available: true,
    resultFile,
    ...(runId ? { runId } : {}),
    ...(opts.run ? { verifiedRun: { runId: opts.run.runId, ownerId: opts.run.ownerId, requestId: opts.run.requestId, sourceRevision: opts.run.sourceRevision } } : {}),
    ...(status ? { runStatus: status } : {}),
    partial,
    savedFrames: steps.length,
    results,
    summaries: results.map((r) => summarizeMonitor(r.table, r.def)),
    notes,
  };
}

export interface MonitorCase {
  /** A path whose stem names the case; the mesh file itself is not guaranteed to exist. */
  meshPath: string;
  dir: string;
  stem: string;
}

const CASE_SIDECARS = /^(.+)\.kratos(?:case|run|monitors)\.json$/;

/**
 * The cases a result file could belong to, found from the sidecars they leave
 * beside their mesh: the result's own folder, then up to two parents (results
 * normally sit in `<case>/vtk_output/`). Never guessed from a matching
 * filename — a case is only offered because it has a sidecar of its own — so
 * the caller can ask the user when there is more than one.
 */
export function findMonitorCases(resultPath: string): MonitorCase[] {
  const found = new Map<string, MonitorCase>();
  let dir = path.dirname(path.resolve(resultPath));
  for (let depth = 0; depth < 3; depth++) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { /* unreadable folder: no cases here */ }
    for (const name of names) {
      const m = CASE_SIDECARS.exec(name);
      if (!m) continue;
      let meshPath = path.join(dir, `${m[1]}.mdpa`);
      if (name.endsWith(".kratosrun.json")) {
        try {
          const recorded = parseRunJson(fs.readFileSync(path.join(dir, name), "utf8")).sidecar?.meshFile;
          if (recorded && path.dirname(path.resolve(recorded)) === dir) meshPath = path.resolve(recorded);
        } catch { /* keep the stem-derived path */ }
      }
      found.set(`${dir}\0${m[1]}`, { meshPath, dir, stem: m[1] });
    }
    if (found.size) break; // the nearest folder holding a case wins
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...found.values()];
}
