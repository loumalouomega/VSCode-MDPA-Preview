/**
 * The JSON-able description of a multi-file series scan (roadmap item 2) and
 * the in-process runner that executes it. No vscode and no worker imports, so
 * the scan worker (src/seriesScanWorker.ts), the host fallback and the tests
 * all run the identical code.
 *
 * Why a description instead of `SeriesStep[]`: a step holds a `load()` closure,
 * which cannot cross a thread. The worker rebuilds the steps from this plain
 * data with the same `stepsFromGroup` / `stepsFromInFile` the host used.
 */

import * as path from "node:path";

import type { FieldSeries, FieldSeriesSpec, SeriesStep } from "./parser/fieldSeries";
import { collectFieldSeries, stepsFromGroup, stepsFromInFile } from "./parser/fieldSeriesScan";
import { flowBalanceSeries } from "./parser/flowBalance";
import type { FlowBalanceSpec, FlowSeries } from "./parser/flowBalance";
import { parseMdpaFile } from "./parser/mdpaParser";
import { fileFor, VtkFileGroup } from "./parser/vtkFileGroup";

/** A `VtkFileGroup` with its `Map` replaced by entries, so it structured-clones as plain data. */
export type SerializedGroup = Omit<VtkFileGroup, "fileMap"> & { fileMap: [string, string][] };

export const serializeGroup = (g: VtkFileGroup): SerializedGroup => ({ ...g, fileMap: [...g.fileMap.entries()] });
export const deserializeGroup = (g: SerializedGroup): VtkFileGroup => ({ ...g, fileMap: new Map(g.fileMap) });

export type SeriesScanSource =
  /** A filename-grouped series. `mdpa` selects the MDPA provider's loader (no subpart merge). */
  | { kind: "group"; group: SerializedGroup; dir: string; rank: number; mdpa?: boolean }
  /** One file carrying its own steps (Exodus, GiD, MED, XDMF, ...). */
  | { kind: "inFile"; fsPath: string; times: number[] };

export type SeriesScan =
  | { kind: "field"; spec: FieldSeriesSpec }
  | { kind: "flow"; spec: FlowBalanceSpec };

export type SeriesScanResult = FieldSeries | FlowSeries;

export interface SeriesScanOptions {
  /** Cooperative cancel: the scan stops between steps and resolves the partial series. */
  signal?: AbortSignal;
  /**
   * Hard stop (panel disposed): the worker is terminated at once, without
   * waiting for the step in progress, and the scan rejects. Ignored in-process,
   * where `signal` is the only stop there is.
   */
  kill?: AbortSignal;
  onProgress?(done: number, total: number, label: string): void;
}

/** The scan's steps, rebuilt from plain data. */
export function stepsForSource(source: SeriesScanSource): SeriesStep[] {
  if (source.kind === "inFile") return stepsFromInFile(source.fsPath, source.times);
  const group = deserializeGroup(source.group);
  if (!source.mdpa) return stepsFromGroup(group, source.dir, source.rank);
  return group.steps.map((step, i) => ({
    label: step,
    frameIndex: i,
    load: async () => {
      const file = fileFor(group, group.rootPrefix, source.rank, step);
      if (!file) throw new Error(`Step "${step}" has no file for this rank.`);
      return parseMdpaFile(path.join(source.dir, file));
    },
  }));
}

/** Runs a scan in this thread. The worker calls it; so do tests and the resampled-timeline fallback. */
export function runSeriesScan(
  steps: SeriesStep[],
  scan: SeriesScan,
  opts: SeriesScanOptions = {}
): Promise<SeriesScanResult> {
  return scan.kind === "field"
    ? collectFieldSeries(steps, scan.spec, opts)
    : flowBalanceSeries(steps, scan.spec, opts);
}
