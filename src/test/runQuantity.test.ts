/** A per-run quantity (roadmap item 25): one row per run, parameters as columns. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { runQuantity, runQuantityToCsv } from "../problemtype/runQuantity";
import { caseCompare, caseRunQuantity } from "../mcp/tools";
import { numericParameterPaths, runQuantityPlotRecipe } from "../problemtype/runQuantityPlot";
import { collectPlot } from "../parser/plot/sources";
import { validatePlotRecipe } from "../parser/plot/recipe";
import type { MonitorDefinition } from "../problemtype/monitors";

const hash = (v: string): string => createHash("sha256").update(v).digest("hex");
const monitor: MonitorDefinition = { id: "p4", name: "Pressure n4", source: { type: "history", kind: "Nodal", entityId: 4, variable: "PRESSURE" } };

function makeRun(t: { after: (fn: () => void) => void }, frames: string[], load: number, state = "succeeded"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-quantity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "beam.mdpa"), "Begin Nodes\nEnd Nodes\n");
  fs.mkdirSync(path.join(dir, "vtk_output"));
  for (const f of frames) fs.copyFileSync(path.resolve(__dirname, "../../example/VTK", f), path.join(dir, "vtk_output", f));
  fs.writeFileSync(path.join(dir, ".kkss-execution.json"), JSON.stringify({ version: 1, requestId: `req-${load}`, ownerId: "study", state, runDirectory: dir, meshPath: path.join(dir, "beam.mdpa"), createdAt: 1, updatedAt: 2, artifacts: [] }));
  const settings = { version: 1, problemtypeId: "structural", values: { problem: { endTime: 1 } }, assignments: [{ conditionId: "load", smpPath: "Top", values: { modulus: load } }], materials: [], output: {} };
  fs.writeFileSync(path.join(dir, "kkss-preparation-v1.json"), JSON.stringify({
    version: 1, producer: { name: "vscode-mdpa.case-generator", source: "builtin", scriptRevision: hash("m") }, problemtype: "structural",
    sourceMesh: { name: "beam.mdpa", revision: "1".repeat(64) }, solverMesh: { name: "beam.mdpa", revision: "1".repeat(64) },
    primaryDocument: "ProjectParameters.json", driverScript: "MainKratos.py", settings, settingsRevision: hash(JSON.stringify(settings)),
    effectiveParameters: {}, units: { state: "undeclared", reason: "none" }, findings: [], inputs: [{ name: "MainKratos.py", revision: hash("m") }, { name: "ProjectParameters.json", revision: hash("p") }],
  }));
  return dir;
}

test("a three-run sweep yields one row per run whose parameter columns are the varied settings", async (t) => {
  const a = makeRun(t, ["Main_0_2.vtk", "Main_0_4.vtk", "Main_0_6.vtk"], 100);
  const b = makeRun(t, ["Main_0_2.vtk", "Main_0_4.vtk"], 200);
  const c = makeRun(t, ["Main_0_2.vtk"], 300);
  const q = await runQuantity([a, b, c], monitor);
  assert.equal(q.rows.length, 3);
  assert.deepEqual(q.parameterColumns, ["assignments"]);
  assert.deepEqual(q.rows.map((r) => Number((r.values![0] as number).toFixed(3))), [6.948, 3.032, 0.716]);
  assert.deepEqual(q.rows.map((r) => r.frames), [3, 2, 1]);
  assert.deepEqual(q.rows.map((r) => (r.parameters.assignments as { values: { modulus: number } }[])[0].values.modulus), [100, 200, 300]);
  const csv = runQuantityToCsv(q).split("\n");
  assert.equal(csv.length, 5);
  assert.match(csv[0], /^run,assignments,/);
});

test("a run that is not finished, or has no receipt, is a row with a reason", async (t) => {
  const live = makeRun(t, ["Main_0_2.vtk"], 1, "running");
  const none = fs.mkdtempSync(path.join(os.tmpdir(), "run-quantity-none-"));
  t.after(() => fs.rmSync(none, { recursive: true, force: true }));
  const q = await runQuantity([live, none], monitor);
  assert.equal(q.rows[0].values, null);
  assert.match(q.rows[0].reason!, /running/);
  assert.match(q.rows[1].reason!, /receipt/);
});

test("case_compare takes a quantity and reports one row per side", async (t) => {
  const a = makeRun(t, ["Main_0_2.vtk", "Main_0_4.vtk"], 100);
  const b = makeRun(t, ["Main_0_2.vtk"], 200);
  const r = (await caseCompare({ left: a, right: b, quantity: monitor })) as { quantity: { rows: { frames: number }[] } };
  assert.deepEqual(r.quantity.rows.map((x) => x.frames), [2, 1]);
  const plain = (await caseCompare({ left: a, right: b })) as { quantity?: unknown };
  assert.equal(plain.quantity, undefined);
  await assert.rejects(caseCompare({ left: a, right: b, quantity: { nope: 1 } }), /quantity:/);
});

test("a three-run sweep draws one point per run against its recorded parameter (roadmap item 30)", async (t) => {
  const a = makeRun(t, ["Main_0_2.vtk", "Main_0_4.vtk", "Main_0_6.vtk"], 300);
  const b = makeRun(t, ["Main_0_2.vtk", "Main_0_4.vtk"], 100);
  const c = makeRun(t, ["Main_0_2.vtk"], 200);
  const q = await runQuantity([a, b, c], monitor);
  const path = "assignments.0.values.modulus";
  assert.deepEqual(numericParameterPaths(q).filter((p) => p === path), [path]);
  const { recipe, parameter } = runQuantityPlotRecipe(q, path, "Pressure vs modulus");
  assert.equal(parameter, path);
  const dataset = await collectPlot(validatePlotRecipe(recipe));
  assert.equal(dataset.series.length, 1);
  assert.deepEqual(dataset.series[0].points.map((p) => p.x), [100, 200, 300], "sorted by the parameter");
  assert.equal(dataset.series[0].points.filter((p) => p.y !== null).length, 3);
  assert.throws(() => runQuantityPlotRecipe(q, "problem.nope", "t"), /not a numeric parameter/);
});

test("a run with no value is a gap on the curve, never zero", async (t) => {
  const live = makeRun(t, ["Main_0_2.vtk"], 100, "running");
  const done = makeRun(t, ["Main_0_2.vtk", "Main_0_4.vtk"], 200);
  const q = await runQuantity([live, done], monitor);
  const { recipe, notes } = runQuantityPlotRecipe(q, "assignments.0.values.modulus", "t");
  assert.ok(notes.some((n) => /no evaluated value/.test(n)));
  const dataset = await collectPlot(validatePlotRecipe(recipe));
  assert.deepEqual(dataset.series[0].points.map((p) => p.y === null), [true, false]);
});

test("case_run_quantity returns the plot recipe when asked", async (t) => {
  const a = makeRun(t, ["Main_0_2.vtk"], 100);
  const b = makeRun(t, ["Main_0_2.vtk", "Main_0_4.vtk"], 200);
  const r = (await caseRunQuantity({ runs: [a, b], monitor, plotParameter: "auto" })) as { plot: { parameter: string; recipe: { series: unknown[] } } };
  assert.equal(r.plot.parameter, "assignments.0.values.modulus");
  assert.equal(r.plot.recipe.series.length, 1);
  const none = (await caseRunQuantity({ runs: [a, b], monitor })) as { plot?: unknown };
  assert.equal(none.plot, undefined);
});
