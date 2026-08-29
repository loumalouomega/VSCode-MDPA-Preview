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
import {
  IN_FILE_TIMELINE_EXTENSIONS,
  TIMELINE_EXTENSIONS,
  meshExtname,
} from "./meshFormats";
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
  const steps: SeriesStep[] = [];
  for (let i = 0; i < group.steps.length; i++) {
    const label = group.steps[i];
    const file = fileFor(group, group.rootPrefix, rank, label);
    if (!file) continue;
    const full = path.join(dir, file);
    steps.push({ label, frameIndex: i, load: () => parseMeshFile(full) });
  }
  return steps;
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
 * Discovers a path's time steps the way the VTK provider's `discover()` does,
 * for callers with no provider state (the MCP server).
 *
 * In-file is checked FIRST, matching that function's own order: a single-step
 * Exodus falls through to the filename grammar rather than claiming a timeline
 * of one.
 */
export async function discoverSeriesSteps(
  fsPath: string
): Promise<{ steps: SeriesStep[]; source: SeriesSource }> {
  const abs = path.resolve(fsPath);
  const dir = path.dirname(abs);
  const fileName = path.basename(abs);
  const ext = meshExtname(abs);

  if (IN_FILE_TIMELINE_EXTENSIONS.includes(ext)) {
    const timeValues = await readMeshTimeSteps(abs);
    if (timeValues.length > 1) {
      return { steps: stepsFromInFile(abs, timeValues), source: "inFile" };
    }
  }

  if (TIMELINE_EXTENSIONS.includes(ext)) {
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

