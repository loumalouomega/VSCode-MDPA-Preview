import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { parsePvdIndex, pvdStepFiles, pvdTimeValues } from "../parser/pvdIndex";
import { mergeChildDatasets } from "../parser/vtkMultiblock";
import { parseMeshFile } from "../parser/meshFileParser";

const FIXTURE_DIR = path.resolve(__dirname, "../../src/test/fixtures/pvd");
const FIXTURE = path.join(FIXTURE_DIR, "two-step.pvd");

test("parsePvdIndex reads a real two-step file written by sequenceToTimeseries", () => {
  const buf = fs.readFileSync(FIXTURE);
  const entries = parsePvdIndex(buf);
  assert.deepEqual(entries, [
    { timestep: 0, part: 0, file: "two-step/two-step_0000.vtu" },
    { timestep: 1, part: 0, file: "two-step/two-step_0001.vtu" },
  ]);
});

test("parsePvdIndex skips a DataSet with no file attribute", () => {
  const xml = Buffer.from(
    '<VTKFile type="Collection"><Collection>' +
      '<DataSet timestep="0" part="0" file="a.vtu"/>' +
      '<DataSet timestep="1" part="0"/>' + // no file
      "</Collection></VTKFile>"
  );
  assert.deepEqual(parsePvdIndex(xml), [{ timestep: 0, part: 0, file: "a.vtu" }]);
});

test("parsePvdIndex defaults part to 0 and treats a non-numeric timestep as absent", () => {
  const xml = Buffer.from(
    '<VTKFile type="Collection"><Collection>' +
      '<DataSet timestep="not-a-number" file="a.vtu"/>' +
      '<DataSet timestep="2" part="1" file="b.vtu"/>' +
      "</Collection></VTKFile>"
  );
  assert.deepEqual(parsePvdIndex(xml), [
    { timestep: undefined, part: 0, file: "a.vtu" },
    { timestep: 2, part: 1, file: "b.vtu" },
  ]);
});

test("pvdTimeValues returns the distinct declared times, ascending, ignoring undeclared ones", () => {
  const entries = [
    { timestep: 1, part: 0, file: "a" },
    { timestep: 0, part: 0, file: "b" },
    { timestep: 1, part: 1, file: "c" }, // same time, second part — not a new distinct value
    { timestep: undefined, part: 0, file: "d" },
  ];
  assert.deepEqual(pvdTimeValues(entries), [0, 1]);
});

test("pvdStepFiles groups every part sharing one declared time, sorted by part", () => {
  const entries = [
    { timestep: 0, part: 1, file: "a1" },
    { timestep: 0, part: 0, file: "a0" },
    { timestep: 1, part: 0, file: "b0" },
  ];
  assert.deepEqual(pvdStepFiles(entries, 0), [
    { timestep: 0, part: 0, file: "a0" },
    { timestep: 0, part: 1, file: "a1" },
  ]);
  assert.deepEqual(pvdStepFiles(entries, 1), [{ timestep: 1, part: 0, file: "b0" }]);
});

test("pvdStepFiles falls back to file order for a collection where nothing declares a time", () => {
  const entries = [
    { timestep: undefined, part: 0, file: "a" },
    { timestep: undefined, part: 0, file: "b" },
  ];
  assert.deepEqual(pvdStepFiles(entries, 0), [{ timestep: undefined, part: 0, file: "a" }]);
  assert.deepEqual(pvdStepFiles(entries, 1), [{ timestep: undefined, part: 0, file: "b" }]);
});

test("pvdStepFiles throws naming the step count, for both the time-keyed and file-order cases", () => {
  const timed = [{ timestep: 0, part: 0, file: "a" }];
  assert.throws(() => pvdStepFiles(timed, 5), /Step 5 out of range \(1 available\)/);
  assert.throws(() => pvdStepFiles(timed, -1), /Step -1 out of range/);
  const untimed = [{ timestep: undefined, part: 0, file: "a" }];
  assert.throws(() => pvdStepFiles(untimed, 1), /Step 1 out of range \(1 available\)/);
});

test("mergeChildDatasets (shared with .vtm) merges a real pvd step's pieces, offsetting nodes/entities", async () => {
  const buf = fs.readFileSync(FIXTURE);
  const entries = parsePvdIndex(buf);
  const step0 = pvdStepFiles(entries, 0);
  const diagnostics: { line: number; message: string }[] = [];
  const merged = await mergeChildDatasets(
    step0.map((e, i) => ({ path: `Part_${i}`, file: e.file })),
    FIXTURE_DIR,
    (p) => parseMeshFile(p),
    diagnostics
  );
  assert.equal(diagnostics.length, 0);
  assert.equal(merged.coords.length / 3, 3); // one triangle's 3 points
  assert.equal(merged.blocks.length, 1);
  const temp = merged.fields.find((f) => f.variable === "TEMP");
  assert.deepEqual(Array.from(temp!.values), [10, 20, 30]);
});

test("mergeChildDatasets rejects a piece path escaping the base directory (shared guard, roadmap item 3)", async () => {
  const diagnostics: { line: number; message: string }[] = [];
  const merged = await mergeChildDatasets(
    [{ path: "Evil", file: "../../etc/passwd" }],
    FIXTURE_DIR,
    (p) => parseMeshFile(p),
    diagnostics
  );
  assert.equal(merged.blocks.length, 0);
  assert.ok(diagnostics.some((d) => /outside the base directory/.test(d.message)));
});
