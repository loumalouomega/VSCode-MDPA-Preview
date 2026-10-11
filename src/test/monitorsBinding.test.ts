/**
 * Coordinate monitors, verified-run binding and case discovery for saved
 * monitors (roadmap item 8). The numerics of history/region monitors are the
 * plot library's and are covered in monitors.test.ts.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { SeriesStep } from "../parser/fieldSeries";
import { bindPlotRun } from "../parser/plot/runs";
import { plotHash } from "../parser/plot/revision";
import type { MdpaModel } from "../parser/types";
import { MonitorDefinition, monitorsToCsv, summarizeMonitor, validateMonitor } from "../problemtype/monitors";
import { evaluateMonitors, findMonitorCases, monitorTables } from "../problemtype/monitorsFile";
import { EXECUTION_FILE, type ExecutionReceipt } from "../problemtype/runReceipt";
import { caseMonitors } from "../mcp/tools";
import { flowDuct } from "./fixtures/shapes";

const at = (x: number, y: number, z: number): MonitorDefinition => ({ id: "pt", name: "Probe", source: { type: "point", variable: "PRESSURE", coordinates: [x, y, z] } });

function ductSteps(n: number, broken: number[] = []): SeriesStep[] {
  return Array.from({ length: n }, (_, i) => ({
    label: String(i),
    frameIndex: i,
    load: async (): Promise<MdpaModel> => {
      if (broken.includes(i)) throw new Error("half-written");
      return flowDuct({ pressure: (x) => 10 * (i + 1) + x });
    },
  }));
}

test("a coordinate monitor interpolates the field at a place and validates its input", () => {
  assert.equal(validateMonitor({ id: "a", source: { type: "point", variable: "P", coordinates: [0, 1, 2] } }).monitor!.source.type, "point");
  assert.match(validateMonitor({ id: "a", source: { type: "point", variable: "P", coordinates: [0, 1] } }).problem!, /coordinates/);
  assert.match(validateMonitor({ id: "a", source: { type: "point", variable: "P", coordinates: [0, 1, NaN] } }).problem!, /finite/);
});

test("a linear field is reproduced at an interior point, frame by frame", async () => {
  const [r] = await monitorTables([at(0.5, 0.5, 0.5)], ductSteps(3), false, "x");
  assert.deepEqual(r.table.rows.map((row) => Math.round((row[2] as number) * 1e6) / 1e6), [10.5, 20.5, 30.5]);
  assert.equal(r.table.columns[2].label, "PRESSURE");
  const s = summarizeMonitor(r.table, r.def);
  assert.equal(s.last!.frame, 2);
  assert.equal(s.gaps, 0);
});

test("a point outside the mesh and an unreadable frame are gaps with a reason, never 0", async () => {
  const [outside] = await monitorTables([at(9, 9, 9)], ductSteps(2), false, "x");
  assert.equal(summarizeMonitor(outside.table, outside.def).last, null);
  assert.match(outside.table.diagnostics.join("\n"), /outside the mesh/);
  const [broken] = await monitorTables([at(0.5, 0.5, 0.5)], ductSteps(3, [0]), false, "x");
  assert.equal(broken.table.rows[0][2], null, "a frame that failed before the width was known is a gap");
  assert.equal(broken.table.rows.every((row) => row.length === broken.table.columns.length), true);
  assert.equal(summarizeMonitor(broken.table, broken.def).gaps, 1);
  assert.match(broken.table.diagnostics.join("\n"), /half-written/);
  assert.equal(monitorsToCsv([broken]).trimEnd().split("\n")[1].split(",")[2], "");
});

test("coordinate and plot-library monitors share one parse per frame", async () => {
  let loads = 0;
  const steps = ductSteps(3).map((s) => ({ ...s, load: async () => { loads++; return s.load(); } }));
  const flux: MonitorDefinition = { id: "f", name: "Flux", source: { type: "region", kind: "Nodal", variable: "VELOCITY", operation: "flux", submodelpart: "Outlet" } };
  const results = await monitorTables([at(0.5, 0.5, 0.5), { ...flux, source: { ...flux.source, variable: "PRESSURE", operation: "boundaryMean", submodelpart: "Inlet" } as never }], steps, false, "x");
  assert.equal(loads, 3);
  assert.deepEqual(results.map((r) => r.table.rows.length), [3, 3]);
  assert.deepEqual(results[1].table.rows.map((row) => Math.round((row[2] as number) * 1e6) / 1e6), [10, 20, 30]);
});

// --- verified run binding --------------------------------------------------

const vtk = (value: number) =>
  `# vtk DataFile Version 3.0\nBound\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 3 float\n0 0 0\n1 0 0\n0 1 0\nCELLS 1 4\n3 0 1 2\nCELL_TYPES 1\n5\nPOINT_DATA 3\nSCALARS PRESSURE float 1\nLOOKUP_TABLE default\n${value}\n${value + 1}\n${value + 2}\n`;

async function boundRun() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-run-"));
  const mesh = path.join(directory, "input.mdpa");
  const recordPath = path.join(directory, EXECUTION_FILE);
  const files = [path.join(directory, "Main_0_0.vtk"), path.join(directory, "Main_0_1.vtk")];
  await fs.writeFile(mesh, "Begin Nodes\n1 0 0 0\nEnd Nodes\n");
  for (const [i, f] of files.entries()) await fs.writeFile(f, vtk(i * 3 + 1));
  const receipt: ExecutionReceipt = {
    version: 1, ownerId: "study-a", requestId: "request-a", jobId: "run-a", state: "succeeded", runDirectory: directory, meshPath: mesh, createdAt: 1, updatedAt: 2,
    artifacts: [{ role: "mesh", path: mesh, revision: plotHash(await fs.readFile(mesh)) }, ...(await Promise.all(files.map(async (f) => ({ role: "result", path: f, revision: plotHash(await fs.readFile(f)) }))))],
  };
  await fs.writeFile(recordPath, JSON.stringify(receipt));
  return { directory, mesh, files, recordPath, run: await bindPlotRun(recordPath, files[0]), dispose: () => fs.rm(directory, { recursive: true, force: true }) };
}

const node1: MonitorDefinition = { id: "n1", name: "Node 1", source: { type: "history", kind: "Nodal", entityId: 1, variable: "PRESSURE" } };

test("a bound evaluation verifies the run, reports it, and refuses a changed run", async () => {
  const f = await boundRun();
  try {
    const ev = await evaluateMonitors(f.mesh, [node1], { run: f.run, resultFile: f.files[0] });
    assert.equal(ev.available, true);
    assert.deepEqual(ev.verifiedRun, { runId: "run-a", ownerId: "study-a", requestId: "request-a", sourceRevision: f.run.sourceRevision });
    assert.deepEqual(ev.results[0].table.rows.map((r) => r[2]), [1, 4]);
    assert.equal(ev.partial, false);
    assert.match(ev.notes.join("\n"), /verified before and after/);
    await fs.writeFile(f.files[1], vtk(50));
    await assert.rejects(evaluateMonitors(f.mesh, [node1], { run: f.run, resultFile: f.files[0] }), /stale|changed|revision/i);
    await assert.rejects(evaluateMonitors(f.mesh, [node1], { run: f.run }), /resultFile/);
  } finally { await f.dispose(); }
});

test("an unbound evaluation never claims a verified run", async () => {
  const f = await boundRun();
  try {
    await fs.mkdir(path.join(f.directory, "vtk_output"));
    await fs.copyFile(f.files[0], path.join(f.directory, "vtk_output", "Main_0_0.vtk"));
    await fs.copyFile(f.files[1], path.join(f.directory, "vtk_output", "Main_0_1.vtk"));
    const ev = await evaluateMonitors(f.mesh, [node1]);
    assert.equal(ev.verifiedRun, undefined);
    assert.match(ev.notes.join("\n"), /not a verified binding/);
  } finally { await f.dispose(); }
});

test("case_monitors passes a binding through and refuses the half-specified forms", async () => {
  const f = await boundRun();
  try {
    await caseMonitors({ meshPath: f.mesh, action: "set", monitor: node1 });
    const ev = (await caseMonitors({ meshPath: f.mesh, action: "evaluate", run: f.run, resultPath: f.files[0] })) as { verifiedRun: { runId: string }; monitors: { rows: { values: number[] }[] }[] };
    assert.equal(ev.verifiedRun.runId, "run-a");
    assert.deepEqual(ev.monitors[0].rows.map((r) => r.values[0]), [1, 4]);
    await assert.rejects(caseMonitors({ meshPath: f.mesh, action: "evaluate", run: f.run }), /resultPath/);
    await assert.rejects(caseMonitors({ meshPath: f.mesh, action: "evaluate", resultPath: f.files[0] }), /only used with a bound run/);
  } finally { await f.dispose(); }
});

// --- finding the case a result belongs to ----------------------------------

test("a result file finds its case from sidecars, nearest folder first, and never guesses", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-case-"));
  try {
    await fs.mkdir(path.join(dir, "vtk_output"));
    const result = path.join(dir, "vtk_output", "beam_0_1.vtk");
    await fs.writeFile(result, "");
    assert.deepEqual(findMonitorCases(result), [], "no sidecar, no case");
    await fs.writeFile(path.join(dir, "beam.kratoscase.json"), "{}");
    await fs.writeFile(path.join(dir, "other.kratosmonitors.json"), "{}");
    const found = findMonitorCases(result).map((c) => c.stem).sort();
    assert.deepEqual(found, ["beam", "other"], "two cases are offered, not one guessed");
    await fs.writeFile(path.join(dir, "vtk_output", "inner.kratoscase.json"), "{}");
    assert.deepEqual(findMonitorCases(result).map((c) => c.stem), ["inner"], "the nearest folder wins");
    await fs.writeFile(path.join(dir, "beam.kratosrun.json"), JSON.stringify({ version: 1, runId: "r", stem: "beam", meshFile: path.join(dir, "beam.med"), status: "finished", launchMode: "spawn", argv: [], startedAt: 1, launchedBy: "extension" }));
    await fs.rm(path.join(dir, "vtk_output", "inner.kratoscase.json"));
    assert.equal(findMonitorCases(result).find((c) => c.stem === "beam")!.meshPath, path.join(dir, "beam.med"), "a recorded mesh path wins over the stem-derived one");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
