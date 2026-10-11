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
import type { SeriesStep } from "../parser/fieldSeries";
import type { PlotExecution, PlotTable } from "../parser/plot/types";
import { monitorsFilePath, runFilePath } from "./caseFile";
import {
  MonitorDefinition,
  MonitorResult,
  MonitorSummary,
  ParsedMonitors,
  groupByStride,
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
}

export interface MonitorEvaluation {
  meshPath: string;
  available: boolean;
  /** Why nothing was evaluated, when `available` is false. */
  reason?: string;
  resultFile?: string;
  /** A label from the latest-run sidecar. NOT a verified ownership binding. */
  runId?: string;
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

/**
 * Evaluates `defs` over already-discovered steps, each distinct stride parsing
 * its frames once. Split out so the numerics are testable with in-memory steps
 * (`SeriesStep.load` is the only thing the extraction touches).
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
    const tables = await collectPlotHistorySteps(monitorSources(group, resultFile), strideSteps(steps, stride), inFile, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.progress ? { progress: opts.progress } : {}),
    });
    for (const def of group) byId.set(def.id, { def, table: tables[def.id] as PlotTable });
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

  const discovered = discoverOutputs(path.dirname(abs));
  const resultFile = discovered.results[0];
  if (!resultFile) {
    return { ...base, available: false, reason: "The case has no saved result files yet (no output has been written, or it is outside the configured output folders).", notes };
  }
  const { status, runId } = latestRun(abs);
  const { steps: all, source } = await discoverSeriesSteps(resultFile);
  let steps = all;
  // A run that did not finish may have a truncated final step (the VTK writer is not atomic).
  const partial = status !== undefined && status !== "finished";
  if (partial && source === "files" && steps.length > 1) {
    steps = steps.slice(0, -1);
    notes.push(`The run is ${status}, so its newest saved frame was left out (it may be incomplete).`);
  }
  notes.push("Values come from the case's current saved outputs; this is not a verified binding to one run.");

  const results = await monitorTables(selected, steps, source === "inFile", resultFile, opts);
  return {
    ...base,
    available: true,
    resultFile,
    ...(runId ? { runId } : {}),
    ...(status ? { runStatus: status } : {}),
    partial,
    savedFrames: steps.length,
    results,
    summaries: results.map((r) => summarizeMonitor(r.table, r.def)),
    notes,
  };
}
