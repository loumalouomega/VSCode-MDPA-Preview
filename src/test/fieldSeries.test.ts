/**
 * fieldSeries.ts — one entity's value for one variable across a time series.
 *
 * The collector is driven by fake in-memory step loaders, so the failure modes
 * that matter (a step that throws, a missing id, a missing variable,
 * cancellation) are exercised without any disk at all. The discovery half is
 * tested against real files, including the committed Kratos series in
 * `example/VTK/`.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  FieldSeriesSpec,
  SeriesStep,
  sampleFieldAt,
  seriesToCsv,
} from "../parser/fieldSeries";
import {
  collectFieldSeries,
  discoverSeriesSteps,
  stepsFromInFile,
} from "../parser/fieldSeriesScan";
import { MdpaModel } from "../parser/types";

/** A model with one cell and whichever fields the test needs. */
function model(fields: MdpaModel["fields"], nodeCount = 3): MdpaModel {
  return {
    nodeCount,
    nodeIds: Int32Array.from(Array.from({ length: nodeCount }, (_, i) => i + 1)),
    coords: new Float32Array(nodeCount * 3),
    blocks: [
      {
        kind: "Elements",
        name: "Element2D3N",
        count: 1,
        stride: 3,
        entityIds: Int32Array.from([1]),
        connectivity: Int32Array.from([1, 2, 3]),
      },
    ],
    subModelParts: [],
    meta: [],
    fields,
    diagnostics: [],
    is3D: false,
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
  };
}

function nodal(variable: string, components: number, ids: number[], values: number[]) {
  return {
    kind: "Nodal" as const,
    variable,
    components,
    ids: Int32Array.from(ids),
    values: Float64Array.from(values),
  };
}

const SPEC: FieldSeriesSpec = { kind: "Nodal", variable: "TEMP", entityId: 2 };

/** Steps whose loaders resolve models built in code — no files involved. */
function fakeSteps(models: (MdpaModel | Error)[]): SeriesStep[] {
  return models.map((m, i) => ({
    label: String(i * 2),
    frameIndex: i,
    load: () => (m instanceof Error ? Promise.reject(m) : Promise.resolve(m)),
  }));
}

test("sampleFieldAt reads a scalar, a vector, and names what is missing", () => {
  const m = model([
    nodal("TEMP", 1, [1, 2, 3], [10, 20, 30]),
    nodal("DISP", 3, [1, 2], [0, 0, 0, 4, 5, 6]),
  ]);
  const scalar = sampleFieldAt(m, SPEC);
  assert.deepEqual(scalar, { components: 1, values: [20], nodeCount: 3, cellCount: 1 });
  const vector = sampleFieldAt(m, { kind: "Nodal", variable: "DISP", entityId: 2 });
  assert.deepEqual((vector as { values: number[] }).values, [4, 5, 6]);

  // The two misses are distinguished, because they have different fixes.
  assert.equal(sampleFieldAt(m, { ...SPEC, entityId: 99 }), "no-id");
  assert.equal(sampleFieldAt(m, { ...SPEC, variable: "NOPE" }), "no-field");
  // Right variable, wrong kind: still a missing field, not a wrong value.
  assert.equal(sampleFieldAt(m, { ...SPEC, kind: "Elemental" }), "no-field");
});

test("a clean series keeps step order, labels and frame indices", async () => {
  const series = await collectFieldSeries(
    fakeSteps([
      model([nodal("TEMP", 1, [1, 2], [0, 1])]),
      model([nodal("TEMP", 1, [1, 2], [0, 2])]),
      model([nodal("TEMP", 1, [1, 2], [0, 3])]),
    ]),
    SPEC
  );
  assert.deepEqual(series.values, [[1], [2], [3]]);
  assert.deepEqual(series.labels, ["0", "2", "4"]);
  assert.deepEqual(series.frameIndices, [0, 1, 2]);
  assert.equal(series.present, 3);
  assert.equal(series.components, 1);
  assert.deepEqual(series.componentNames, ["TEMP"]);
  assert.equal(series.cancelled, false);
});

test("a vector series names its components the way the data table does", async () => {
  const series = await collectFieldSeries(
    fakeSteps([model([nodal("DISP", 3, [2], [1, 2, 3])])]),
    { kind: "Nodal", variable: "DISP", entityId: 2 }
  );
  assert.deepEqual(series.componentNames, ["DISP_X", "DISP_Y", "DISP_Z"]);
  const wide = await collectFieldSeries(
    fakeSteps([model([nodal("H", 9, [2], [0, 1, 2, 3, 4, 5, 6, 7, 8])])]),
    { kind: "Nodal", variable: "H", entityId: 2 }
  );
  assert.equal(wide.componentNames.length, 9, "a 9-component field is not truncated to 3");
});

test("a step that fails to parse is recorded and the scan continues", async () => {
  const series = await collectFieldSeries(
    fakeSteps([
      model([nodal("TEMP", 1, [2], [1])]),
      new Error("truncated file"),
      model([nodal("TEMP", 1, [2], [3])]),
    ]),
    SPEC
  );
  assert.equal(series.errors.length, 1);
  assert.match(series.errors[0].message, /truncated/);
  assert.deepEqual(series.values, [[1], null, [3]]);
  assert.equal(series.present, 2, "the steps after the bad one are still read");
});

test("a missing id and a missing variable are counted apart", async () => {
  const series = await collectFieldSeries(
    fakeSteps([
      model([nodal("TEMP", 1, [2], [1])]),
      model([nodal("TEMP", 1, [1], [9])]), // id 2 absent
      model([nodal("OTHER", 1, [2], [5])]), // variable absent
    ]),
    SPEC
  );
  assert.equal(series.missingId, 1);
  assert.equal(series.missingField, 1);
  assert.equal(series.present, 1);
  assert.deepEqual(series.values, [[1], null, null]);
});

test("cancellation returns the partial series rather than discarding it", async () => {
  const abort = new AbortController();
  const models = [1, 2, 3, 4, 5].map((v) => model([nodal("TEMP", 1, [2], [v])]));
  let seen = 0;
  const series = await collectFieldSeries(fakeSteps(models), SPEC, {
    signal: abort.signal,
    onProgress: () => {
      if (++seen === 3) abort.abort();
    },
  });
  assert.equal(series.cancelled, true);
  // Aborting inside step 3's progress callback cannot unload step 3 — the
  // signal is checked at the top of the next iteration, since parseMeshFile
  // takes no AbortSignal. So three of five steps survive, and none of the two
  // never visited leave a placeholder row behind.
  assert.equal(series.present, 3);
  assert.equal(series.values.length, 3);
  assert.equal(series.labels.length, 3, "labels and values stay aligned");
});

test("a mesh that changes size mid-series is flagged, not silently plotted", async () => {
  const series = await collectFieldSeries(
    fakeSteps([
      model([nodal("TEMP", 1, [2], [1])], 3),
      model([nodal("TEMP", 1, [2], [2])], 3),
      model([nodal("TEMP", 1, [2], [3])], 7),
    ]),
    SPEC
  );
  assert.equal(series.topologyChangedAt, 2);
  assert.equal(series.present, 3, "the values are still collected — the flag is a caveat");
});

test("the series survives a JSON round trip with its gaps in place", async () => {
  const series = await collectFieldSeries(
    fakeSteps([
      model([nodal("TEMP", 1, [2], [1])]),
      model([nodal("TEMP", 1, [1], [9])]),
      model([nodal("TEMP", 1, [2], [3])]),
    ]),
    SPEC
  );
  // undefined would be DROPPED from the array here, shifting every later step.
  const round = JSON.parse(JSON.stringify(series)) as typeof series;
  assert.equal(round.values.length, 3);
  assert.deepEqual(round.values, [[1], null, [3]]);
});

test("seriesToCsv writes a row per step and leaves a gap empty", async () => {
  const series = await collectFieldSeries(
    fakeSteps([
      model([nodal("DISP", 3, [2], [1, 2, 3])]),
      model([nodal("DISP", 3, [1], [0, 0, 0])]),
    ]),
    { kind: "Nodal", variable: "DISP", entityId: 2 }
  );
  const lines = seriesToCsv(series).trimEnd().split("\r\n");
  assert.equal(lines[0], "step,frame,DISP_X,DISP_Y,DISP_Z");
  assert.equal(lines[1], "0,0,1,2,3");
  assert.equal(lines[2], "2,1,,,", "a gap is empty, never 0");
});

test("discoverSeriesSteps finds the committed Kratos .vtk series from one file", async () => {
  const src = path.resolve(__dirname, "../../example/VTK/Main_0_2.vtk");
  const { steps, source } = await discoverSeriesSteps(src);
  assert.equal(source, "files");
  assert.deepEqual(
    steps.map((s) => s.label),
    ["2", "4", "6"]
  );
  // Node 4's PRESSURE really does rise across the three files.
  const series = await collectFieldSeries(steps, {
    kind: "Nodal",
    variable: "PRESSURE",
    entityId: 4,
  });
  assert.equal(series.present, 3);
  const values = series.values.map((v) => (v ? Number(v[0].toFixed(3)) : null));
  assert.deepEqual(values, [0.716, 3.032, 6.948]);
});

test("a file with no series at all yields one honest step, not an error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "series-"));
  const solo = path.join(dir, "static.vtk");
  fs.copyFileSync(path.resolve(__dirname, "../../example/VTK/Main_0_2.vtk"), solo);
  const { steps, source } = await discoverSeriesSteps(solo);
  assert.equal(source, "single");
  assert.equal(steps.length, 1);
});

test("stepsFromInFile addresses one file by time step", () => {
  const steps = stepsFromInFile("/tmp/x.exo", [0, 0.5, 1]);
  assert.deepEqual(
    steps.map((s) => s.label),
    ["0", "0.5", "1"]
  );
  assert.deepEqual(
    steps.map((s) => s.frameIndex),
    [0, 1, 2]
  );
});
