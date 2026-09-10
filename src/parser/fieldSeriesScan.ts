/**
 * The time-series SCAN: walking a mesh path's time steps and sampling one
 * entity at each. Separated from the pure `fieldSeries.ts` because it reads
 * files (`node:fs` via `parseMeshFile`), the same shape as `meshFileParser.ts`
 * — so the VTK editor provider and the MCP server run the identical scan while
 * the webview imports neither.
 *
 * Why the scan lives on the host at all: the webview holds exactly ONE frame,
 * and nothing anywhere caches a parsed frame. The alternative was walking the
 * timeline through `vtkRequestFrame`, which re-parses, re-applies the edit
 * history, rebuilds the whole VTK scene and flickers the viewport once per
 * step, to read one number.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { componentColumnNames } from "./dataTable";
import {
  FieldSample,
  FieldSeries,
  FieldSeriesSpec,
  SampleMiss,
  SeriesStep,
  sampleFieldAt,
} from "./fieldSeries";
import { TIMELINE_EXTENSIONS, VTK_XML_EXTENSIONS, meshExtname, timelineKindFor } from "./meshFormats";
import type { PackStep } from "./meshio";
import { parseMeshFile, readMeshTimeSteps } from "./meshFileParser";
import { fileFor, findGroupForFile, groupVtkFiles, VtkFileGroup } from "./vtkFileGroup";

export interface CollectOptions {
  onProgress?(done: number, total: number, label: string): void;
  signal?: AbortSignal;
}

/**
 * Walks the steps in order, samples one entity, and drops each model before
 * loading the next — peak memory is one model, the same as the timeline today.
 *
 * `parseMeshFile` takes no `AbortSignal`, so cancellation is checked BETWEEN
 * steps and returns the partial series rather than discarding it: half a
 * hundred-step scan is still worth plotting.
 */
export async function collectFieldSeries(
  steps: SeriesStep[],
  spec: FieldSeriesSpec,
  opts: CollectOptions = {}
): Promise<FieldSeries> {
  const series: FieldSeries = {
    kind: spec.kind,
    variable: spec.variable,
    entityId: spec.entityId,
    components: 0,
    componentNames: [],
    labels: [],
    frameIndices: [],
    values: [],
    present: 0,
    missingField: 0,
    missingId: 0,
    errors: [],
    cancelled: false,
  };
  let fingerprint: { nodeCount: number; cellCount: number } | undefined;

  for (let i = 0; i < steps.length; i++) {
    if (opts.signal?.aborted) {
      series.cancelled = true;
      break;
    }
    const step = steps[i];
    series.labels.push(step.label);
    series.frameIndices.push(step.frameIndex);
    opts.onProgress?.(i, steps.length, step.label);

    let sample: FieldSample | SampleMiss;
    try {
      sample = sampleFieldAt(await step.load(), spec);
    } catch (err) {
      series.errors.push({
        label: step.label,
        message: err instanceof Error ? err.message : String(err),
      });
      series.values.push(null);
      continue;
    }

    if (sample === "no-field") {
      series.missingField++;
      series.values.push(null);
      continue;
    }
    if (sample === "no-id") {
      series.missingId++;
      series.values.push(null);
      continue;
    }

    if (series.components === 0) {
      series.components = sample.components;
      series.componentNames = componentColumnNames(spec.variable, sample.components);
    }
    if (!fingerprint) {
      fingerprint = { nodeCount: sample.nodeCount, cellCount: sample.cellCount };
    } else if (
      series.topologyChangedAt === undefined &&
      (sample.nodeCount !== fingerprint.nodeCount || sample.cellCount !== fingerprint.cellCount)
    ) {
      // The only mode that could lie silently: the id still resolves, but it
      // need not be the same entity any more.
      series.topologyChangedAt = i;
    }
    // A step whose width disagrees with the first is a gap rather than a
    // ragged row — the chart draws one line per component and cannot show a
    // fourth for one step only.
    if (sample.components !== series.components) {
      series.errors.push({
        label: step.label,
        message: `${spec.variable} has ${sample.components} components here, ${series.components} elsewhere.`,
      });
      series.values.push(null);
      continue;
    }
    series.values.push(sample.values);
    series.present++;
  }

  opts.onProgress?.(series.labels.length, steps.length, "");
  return series;
}

// ---- step sources -----------------------------------------------------------

/**
 * Steps of a filename-grouped series (`<prefix>_<rank>_<step>.vtk`).
 *
 * The caller passes its OWN snapshot of the group: the VTK provider's
 * `currentGroup` is reassigned by a watcher-driven `discover()` on a 500 ms
 * debounce, so re-deriving it here would let a solver writing new steps swap
 * the list out from under a running scan.
 *
 * Deliberately does not merge subpart files the way `postFrame` does: that
 * costs one extra full parse per subpart per step and contributes only to
 * `subModelParts`, which a field sample never reads.
 */
export function stepsFromGroup(group: VtkFileGroup, dir: string, rank: number): SeriesStep[] {
  return pathsFromGroup(group, dir, rank).map(({ label, fsPath, frameIndex }) => ({
    label,
    frameIndex,
    load: () => parseMeshFile(fsPath),
  }));
}

/** One step file of a filename-grouped series, resolved to an absolute path. */
export interface SeriesFile {
  /** The step label from the filename grammar (`Main_0_2.vtk` -> `"2"`). */
  label: string;
  fsPath: string;
  /**
   * Position in the group's OWN step list, which is what `vtkRequestFrame`
   * names — so a step this rank has no file for leaves a gap here rather than
   * shifting every later frame index by one.
   */
  frameIndex: number;
}

/** Shared UI/MCP pack input: preserve VTK's direct transcode and use the
 * preview reader for the other formats (including companion-file meshes). */
export function packStepsFromFiles(files: SeriesFile[], beforeRead?: () => void): PackStep[] {
  return files.map((f, i) => ({
    name: path.basename(f.fsPath),
    time: Number.isFinite(Number(f.label)) ? Number(f.label) : i,
    read: async () => {
      beforeRead?.();
      const ext = meshExtname(f.fsPath);
      return ext === ".vtk" || (VTK_XML_EXTENSIONS as readonly string[]).includes(ext)
        ? fs.promises.readFile(f.fsPath)
        : parseMeshFile(f.fsPath);
    },
  }));
}

/**
 * The ordered, absolute step-file paths of a filename-grouped series.
 *
 * `VtkFileGroup` is deliberately path-free — it holds basenames and the caller
 * supplies the directory — so joining the two was open-coded at every call
 * site, and `stepsFromGroup` computed exactly this list only to capture it in a
 * closure and throw it away. Anything that needs the FILES rather than parsed
 * models (packing a series into one file) had nothing to call.
 */
export function pathsFromGroup(group: VtkFileGroup, dir: string, rank: number): SeriesFile[] {
  const out: SeriesFile[] = [];
  for (let i = 0; i < group.steps.length; i++) {
    const label = group.steps[i];
    const file = fileFor(group, group.rootPrefix, rank, label);
    if (!file) continue;
    out.push({ label, fsPath: path.join(dir, file), frameIndex: i });
  }
  return out;
}

/** Steps of a single file that carries its own time series (Exodus, GiD). */
export function stepsFromInFile(fsPath: string, timeValues: number[]): SeriesStep[] {
  return timeValues.map((t, i) => ({
    label: String(t),
    frameIndex: i,
    load: () => parseMeshFile(fsPath, undefined, { timeStep: i }),
  }));
}

export type SeriesSource = "files" | "inFile" | "single";

/**
 * The step FILES of a filename-grouped series, in order.
 *
 * Deliberately answers only for `"filename"` series: a format that carries its
 * own steps (Exodus, GiD, a packed XDMF) is ALREADY one file, so there is
 * nothing for a caller that wants to combine files to do with it. Returns `[]`
 * for those and for a lone static file, and the caller says so in its own
 * words rather than this guessing at one.
 */
export async function discoverSeriesFiles(fsPath: string): Promise<SeriesFile[]> {
  const abs = path.resolve(fsPath);
  const dir = path.dirname(abs);
  if (timelineKindFor(abs) !== "filename") return [];
  const files = await fs.promises.readdir(dir);
  const found = findGroupForFile(groupVtkFiles(files, TIMELINE_EXTENSIONS), path.basename(abs));
  if (!found || found.group.steps.length < 2) return [];
  return pathsFromGroup(found.group, dir, found.rank);
}

/**
 * The step files of the largest series in a DIRECTORY — the shape the run
 * manager has, which knows a `vtk_output/` folder rather than one file in it.
 * Group selection matches `latestResultFile`: most steps wins, ties by prefix.
 */
export async function seriesFilesInDir(dir: string): Promise<SeriesFile[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const groups = groupVtkFiles(names, TIMELINE_EXTENSIONS).filter((g) => g.steps.length > 1);
  if (groups.length === 0) return [];
  const best = groups.reduce((a, b) =>
    b.steps.length > a.steps.length || (b.steps.length === a.steps.length && b.rootPrefix < a.rootPrefix)
      ? b
      : a
  );
  return pathsFromGroup(best, dir, best.ranks[0] ?? 0);
}

/**
 * Discovers a path's time steps the way the VTK provider's `discover()` does,
 * for callers with no provider state (the MCP server).
 *
 * Both now branch on the shared `timelineKindFor`, so "the way `discover()`
 * does" is enforced rather than merely asserted — the two drifted once, when
 * the provider spelled the same question with `path.extname` and lost every
 * GiD `.post.*` timeline while this function kept them.
 *
 * In-file is checked FIRST, matching that function's own order: a single-step
 * Exodus remains a single static view rather than claiming a timeline of one.
 */
export async function discoverSeriesSteps(
  fsPath: string
): Promise<{ steps: SeriesStep[]; source: SeriesSource }> {
  const abs = path.resolve(fsPath);
  const dir = path.dirname(abs);
  const fileName = path.basename(abs);
  const kind = timelineKindFor(abs);

  if (kind === "in-file") {
    const timeValues = await readMeshTimeSteps(abs);
    if (timeValues.length > 1) {
      return { steps: stepsFromInFile(abs, timeValues), source: "inFile" };
    }
  }

  if (kind === "filename") {
    const files = await fs.promises.readdir(dir);
    const found = findGroupForFile(groupVtkFiles(files, TIMELINE_EXTENSIONS), fileName);
    if (found && found.group.steps.length > 1) {
      return { steps: stepsFromGroup(found.group, dir, found.rank), source: "files" };
    }
  }

  // Not a series at all — one step, so the caller gets one honest point rather
  // than an error it has to special-case.
  return {
    steps: [{ label: "", frameIndex: 0, load: () => parseMeshFile(abs) }],
    source: "single",
  };
}
