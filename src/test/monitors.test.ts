/**
 * monitors.ts / monitorsFile.ts — saved post-run monitors (roadmap item 8).
 *
 * The numerics are the plotting library's, so these tests check what the
 * monitor layer adds: the tolerant sidecar, the stride, gaps staying gaps, the
 * CSV and plot hand-off, and — over real files — that an analytic quantity and
 * the committed Kratos series come out right and that one case's monitors never
 * reach another.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { monitorsFilePath } from "../problemtype/caseFile";
import {
  MONITORS_MAX,
  MonitorDefinition,
  groupByStride,
  monitorPlotRecipe,
  monitorRowText,
  monitorsToCsv,
  parseMonitorsJson,
  serializeMonitors,
  strideSteps,
  needsReferencePoint,
  parseXyz,
  regionOperationsFor,
  suggestMonitor,
  suggestPointMonitor,
  suggestRegionMonitor,
  summarizeMonitor,
  upsertMonitor,
  validateMonitor,
} from "../problemtype/monitors";
import { evaluateMonitors, monitorTables, readMonitors, writeMonitors } from "../problemtype/monitorsFile";
import { SeriesStep } from "../parser/fieldSeries";
import { collectPlot } from "../parser/plot/sources";
import { validatePlotRecipe } from "../parser/plot/recipe";
import type { MdpaModel } from "../parser/types";
import { flowDuct } from "./fixtures/shapes";

const point: MonitorDefinition = { id: "p4", name: "Pressure n4", source: { type: "history", kind: "Nodal", entityId: 4, variable: "PRESSURE" } };

// --- the sidecar -----------------------------------------------------------

test("a valid document round-trips and optional keys stay optional", () => {
  const defs: MonitorDefinition[] = [
    point,
    { id: "q", name: "Outlet flux", source: { type: "region", kind: "Nodal", variable: "VELOCITY", operation: "flux", submodelpart: "Outlet" }, stride: 3, unit: "m^3/s", note: "check" },
  ];
  const parsed = parseMonitorsJson(serializeMonitors(defs));
  assert.deepEqual(parsed.monitors, defs);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.readable, true);
  assert.equal(parsed.newerVersion, false);
});

test("a bad entry is dropped with a reason and the others survive", () => {
  const text = JSON.stringify({
    version: 1,
    monitors: [
      point,
      { id: "bad id!", source: point.source },
      { id: "noOp", source: { type: "region", kind: "Nodal", variable: "V", operation: "median" } },
      { id: "p4", name: "dup", source: point.source },
      { id: "m", source: { type: "region", kind: "Nodal", variable: "F", operation: "reactionMoment" } },
      { id: "s", source: point.source, stride: 0 },
      "nope",
    ],
  });
  const parsed = parseMonitorsJson(text);
  assert.deepEqual(parsed.monitors.map((m) => m.id), ["p4"]);
  assert.equal(parsed.warnings.length, 6);
  assert.match(parsed.warnings.join("\n"), /defined twice/);
  assert.match(parsed.warnings.join("\n"), /referencePoint/, "a moment origin is never assumed");
});

test("garbage is unreadable and a newer version is ignored but flagged", () => {
  assert.equal(parseMonitorsJson("{nope").readable, false);
  assert.equal(parseMonitorsJson("{}").readable, false);
  const newer = parseMonitorsJson(JSON.stringify({ version: 2, monitors: [point] }));
  assert.equal(newer.newerVersion, true);
  assert.deepEqual(newer.monitors, []);
});

test("a case holds a bounded number of monitors", () => {
  const many = Array.from({ length: MONITORS_MAX + 3 }, (_, i) => ({ ...point, id: `m${i}` }));
  assert.equal(parseMonitorsJson(serializeMonitors(many)).monitors.length, MONITORS_MAX);
  assert.throws(() => upsertMonitor(many.slice(0, MONITORS_MAX), { ...point, id: "extra" }), /at most/);
  assert.equal(upsertMonitor(many.slice(0, 2), { ...point, id: "m1", name: "renamed" })[1].name, "renamed");
});

test("validateMonitor names the field it refuses", () => {
  assert.match(validateMonitor({ id: "a", source: { type: "history", kind: "Bogus", variable: "T", entityId: 1 } }).problem!, /kind/);
  assert.match(validateMonitor({ id: "a", source: { type: "history", kind: "Nodal", variable: "T" } }).problem!, /entityId/);
  assert.match(validateMonitor({ id: "a", source: { type: "region", kind: "Nodal", variable: "T", operation: "mean", thickness: -1 } }).problem!, /thickness/);
  assert.equal(validateMonitor({ id: "a", source: { type: "history", kind: "Nodal", variable: "T", entityId: 1 }, stride: 1 }).monitor!.stride, undefined);
});

test("the sidecar is keyed by the mesh stem, so cases in one folder stay apart", () => {
  assert.notEqual(monitorsFilePath("/c/a.mdpa"), monitorsFilePath("/c/b.mdpa"));
  assert.equal(path.basename(monitorsFilePath("/c/case.post.msh")), "case.kratosmonitors.json");
});

test("a monitor saved from the viewer gets a fresh valid id and never replaces another", () => {
  const first = suggestMonitor({ kind: "Nodal", entityId: 4, variable: "PRESSURE" }, []);
  assert.deepEqual(first, { id: "PRESSURE_N4", name: "PRESSURE at node 4" });
  assert.equal(suggestMonitor({ kind: "Nodal", entityId: 4, variable: "PRESSURE" }, [{ id: "PRESSURE_N4" }, { id: "PRESSURE_N4_2" }]).id, "PRESSURE_N4_3");
  assert.equal(suggestMonitor({ kind: "Conditional", entityId: 9, variable: "A B" }, []).id, "A_B_C9");
  for (const spec of [{ kind: "Elemental" as const, entityId: 1, variable: "x".repeat(200) }, { kind: "Nodal" as const, entityId: 0, variable: "ü" }]) {
    const { id, name } = suggestMonitor(spec, []);
    assert.ok(validateMonitor({ id, name, source: { type: "history", kind: spec.kind, entityId: spec.entityId, variable: spec.variable.slice(0, 128) } }).monitor, id);
  }
});

test("point and region monitors saved from the viewer validate and never collide", () => {
  const point = suggestPointMonitor({ variable: "TEMP", coordinates: [1, 2.123456789, 0] }, []);
  assert.deepEqual(point, { id: "TEMP_pt", name: "TEMP at (1, 2.12346, 0)" });
  assert.equal(suggestPointMonitor({ variable: "TEMP", coordinates: [0, 0, 0] }, [{ id: "TEMP_pt" }]).id, "TEMP_pt_2");
  assert.ok(validateMonitor({ ...point, source: { type: "point", variable: "TEMP", coordinates: [1, 2, 0] } }).monitor);

  const region = suggestRegionMonitor({ operation: "boundaryMean", variable: "PRESSURE", submodelpart: "Outer/Outlet" }, []);
  assert.equal(region.id, "boundaryMean_PRESSURE_Outer_Outlet");
  assert.equal(suggestRegionMonitor({ operation: "mean", variable: "T" }, []).name, "mean T in mesh");
  assert.equal(suggestRegionMonitor({ operation: "mean", variable: "T" }, [{ id: "mean_T_mesh" }]).id, "mean_T_mesh_2");
  assert.ok(validateMonitor({ ...region, source: { type: "region", kind: "Nodal", variable: "PRESSURE", operation: "boundaryMean", submodelpart: "Outer/Outlet" } }).monitor);
  const long = suggestRegionMonitor({ operation: "reactionMoment", variable: "V".repeat(100), submodelpart: "P".repeat(100) }, []);
  assert.ok(/^[A-Za-z0-9_.-]{1,64}$/.test(long.id));
});

test("reference points are parsed strictly and moments require one", () => {
  assert.deepEqual(parseXyz("1, 2 ,3"), [1, 2, 3]);
  assert.deepEqual(parseXyz("(0.5 -1 2e1)"), [0.5, -1, 20]);
  for (const bad of ["", "1,2", "1,2,3,4", "a,b,c", "1,2,NaN"]) assert.equal(parseXyz(bad), undefined, bad);
  assert.ok(needsReferencePoint("reactionMoment") && needsReferencePoint("pressureMoment") && !needsReferencePoint("mean"));
  assert.equal(validateMonitor({ id: "m", source: { type: "region", kind: "Nodal", variable: "R", operation: "reactionMoment" } }).monitor, undefined);
});

test("region operations offered follow the field width", () => {
  assert.ok(regionOperationsFor(1).includes("pressureForce") && !regionOperationsFor(1).includes("flux"));
  assert.ok(regionOperationsFor(3).includes("flux") && regionOperationsFor(3).includes("reactionMoment") && !regionOperationsFor(3).includes("pressureForce"));
  assert.deepEqual(regionOperationsFor(9).includes("flux"), false);
});

// --- stride ----------------------------------------------------------------

test("stride keeps the first and the last frame and never invents one", () => {
  const steps = [0, 1, 2, 3, 4, 5, 6];
  assert.deepEqual(strideSteps(steps, 1), steps);
  assert.deepEqual(strideSteps(steps, 3), [0, 3, 6]);
  assert.deepEqual(strideSteps(steps, 4), [0, 4, 6]);
  assert.deepEqual(strideSteps([0, 1], 5), [0, 1]);
  assert.deepEqual([...groupByStride([point, { ...point, id: "b", stride: 2 }, { ...point, id: "c", stride: 2 }]).keys()], [1, 2]);
});

// --- numerics over in-memory frames ----------------------------------------

/** Step i carries u = (i+1) * (1, 0, 0), so the Outlet flux is exactly i+1 and the Inlet's -(i+1). */
function ductSteps(n: number, broken: number[] = []): SeriesStep[] {
  return Array.from({ length: n }, (_, i) => ({
    label: String(i * 2),
    frameIndex: i,
    load: async (): Promise<MdpaModel> => {
      if (broken.includes(i)) throw new Error("half-written");
      return flowDuct({ velocity: () => [i + 1, 0, 0], pressure: (x) => 10 * (i + 1) + x });
    },
  }));
}

const outlet: MonitorDefinition = { id: "out", name: "Outlet flux", source: { type: "region", kind: "Nodal", variable: "VELOCITY", operation: "flux", submodelpart: "Outlet", component: undefined } };
const inletMean: MonitorDefinition = { id: "pin", name: "Inlet pressure", source: { type: "region", kind: "Nodal", variable: "PRESSURE", operation: "boundaryMean", submodelpart: "Inlet" } };

test("a regional flux monitor reproduces the analytic value at every saved frame", async () => {
  const [r] = await monitorTables([outlet], ductSteps(3), false, "x");
  const s = summarizeMonitor(r.table, r.def);
  assert.equal(s.frames, 3);
  assert.deepEqual(r.table.rows.map((row) => Math.round((row[2] as number) * 1e9) / 1e9), [1, 2, 3]);
  assert.equal(s.last!.frame, 2);
  assert.equal(s.gaps, 0);
});

test("an area-weighted boundary mean matches the analytic pressure", async () => {
  const [r] = await monitorTables([inletMean], ductSteps(2), false, "x");
  // PRESSURE = 10(i+1) + x and the inlet face sits at x = 0.
  assert.deepEqual(r.table.rows.map((row) => Math.round((row[2] as number) * 1e9) / 1e9), [10, 20]);
});

test("a frame that cannot be read, and a field that does not exist, are gaps — never 0", async () => {
  const missing: MonitorDefinition = { id: "nofield", name: "x", source: { type: "history", kind: "Nodal", entityId: 1, variable: "NOPE" } };
  const results = await monitorTables([outlet, missing], ductSteps(3, [1]), false, "x");
  const flux = summarizeMonitor(results[0].table, results[0].def);
  assert.equal(flux.gaps, 1);
  assert.equal(results[0].table.rows[1][2], null);
  const none = summarizeMonitor(results[1].table, results[1].def);
  assert.equal(none.last, null);
  assert.equal(none.gaps, 3);
  assert.match(none.diagnostics.join("\n"), /NOPE/);
  const csv = monitorsToCsv(results).trimEnd().split("\n");
  assert.equal(csv[2].split(",")[2], "", "a gap is blank in the CSV");
});

test("stride thins the saved frames and the CSV leaves the skipped ones blank", async () => {
  const thinned = { ...outlet, id: "out3", name: "Every 3rd", stride: 3 };
  const results = await monitorTables([outlet, thinned], ductSteps(7), false, "x");
  assert.equal(results[0].table.rows.length, 7);
  assert.deepEqual(results[1].table.rows.map((row) => row[1]), [0, 3, 6]);
  const lines = monitorsToCsv(results).trimEnd().split("\n");
  assert.equal(lines.length, 8);
  assert.equal(lines[2].split(",")[3], "", "frame 1 was not sampled by the strided monitor");
  assert.match(lines[0], /\[unit undeclared\]/, "no unit is implied");
});

test("a declared unit label reaches the summary and the CSV header", async () => {
  const [r] = await monitorTables([{ ...outlet, unit: "m^3/s" }], ductSteps(2), false, "x");
  assert.equal(summarizeMonitor(r.table, r.def).unit, "m^3/s");
  assert.match(monitorsToCsv([r]).split("\n")[0], /\[m\^3\/s\]/);
});

test("the plot hand-off is a valid recipe that draws every monitor", async () => {
  const results = await monitorTables([outlet, point], ductSteps(3), false, "x");
  const plot = monitorPlotRecipe(results, "t");
  const recipe = validatePlotRecipe(plot.recipe);
  const data = await collectPlot(recipe);
  assert.equal(data.series.length, results.reduce((n, r) => n + summarizeMonitor(r.table, r.def).columns.length, 0));
  assert.ok(data.series[0].points.length >= 2);
});

test("row text is decided here, not in the view", () => {
  assert.equal(monitorRowText([], 0), "Monitors — none saved");
  assert.equal(monitorRowText([], 2), "Monitors — 2 saved");
  assert.match(
    monitorRowText([{ id: "a", name: "Flux", unit: "kg/s", columns: ["v"], frames: 1, last: { time: 0, frame: 0, values: [1.5] }, gaps: 0, partial: false, diagnostics: [] }], 1),
    /Flux 1\.5 kg\/s/
  );
});

// --- over real files -------------------------------------------------------

const VTK = path.resolve(__dirname, "../../example/VTK");
function caseDir(files = ["Main_0_2.vtk", "Main_0_4.vtk", "Main_0_6.vtk"]): { dir: string; mesh: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monitors-"));
  fs.mkdirSync(path.join(dir, "vtk_output"));
  for (const f of files) fs.copyFileSync(path.join(VTK, f), path.join(dir, "vtk_output", f));
  const mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, "Begin Nodes\nEnd Nodes\n");
  return { dir, mesh };
}

test("monitors persist beside the mesh, evaluate against the committed series and are read-only", async () => {
  const { dir, mesh } = caseDir();
  assert.equal(readMonitors(mesh).exists, false);
  const file = writeMonitors(mesh, [point]);
  assert.equal(path.basename(file), "beam.kratosmonitors.json");
  const before = fs.readFileSync(file, "utf8");
  const ev = await evaluateMonitors(mesh, readMonitors(mesh).parsed.monitors);
  assert.equal(ev.available, true);
  assert.equal(ev.savedFrames, 3);
  assert.deepEqual(ev.results[0].table.rows.map((r) => Number((r[2] as number).toFixed(3))), [0.716, 3.032, 6.948]);
  assert.equal(ev.runStatus, undefined, "no run sidecar, so no status is invented");
  assert.equal(fs.readFileSync(file, "utf8"), before, "evaluate never writes the sidecar");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["beam.kratosmonitors.json", "beam.mdpa", "vtk_output"]);
});

test("a run that did not finish leaves out its newest, possibly truncated frame", async () => {
  const { mesh } = caseDir();
  fs.writeFileSync(
    path.join(path.dirname(mesh), "beam.kratosrun.json"),
    JSON.stringify({ version: 1, runId: "r1", stem: "beam", meshFile: "beam.mdpa", status: "failed", launchMode: "spawn", argv: ["python"], startedAt: 1, endedAt: 2, exitCode: 1, launchedBy: "extension" })
  );
  const ev = await evaluateMonitors(mesh, [point]);
  assert.equal(ev.partial, true);
  assert.equal(ev.runId, "r1");
  assert.equal(ev.savedFrames, 2);
  assert.match(ev.notes.join("\n"), /newest saved frame was left out/);
  assert.match(ev.notes.join("\n"), /not a verified binding/);
});

test("no results, no monitors and an unknown id are reported, never fabricated", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "monitors-"));
  const mesh = path.join(empty, "a.mdpa");
  fs.writeFileSync(mesh, "");
  assert.equal((await evaluateMonitors(mesh, [point])).available, false);
  assert.match((await evaluateMonitors(mesh, [])).reason!, /No monitors/);
  const { mesh: m2 } = caseDir();
  const ev = await evaluateMonitors(m2, [point], { ids: ["ghost"] });
  assert.equal(ev.available, false);
  assert.match(ev.notes.join("\n"), /ghost/);
});

test("a sidecar this version cannot read or a newer version wrote is never overwritten", () => {
  const { mesh } = caseDir();
  const file = monitorsFilePath(mesh);
  fs.writeFileSync(file, JSON.stringify({ version: 2, monitors: [] }));
  assert.throws(() => writeMonitors(mesh, [point]), /left untouched/);
  fs.writeFileSync(file, "{broken");
  assert.throws(() => writeMonitors(mesh, [point]), /left untouched/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("two cases in one folder never share monitors", async () => {
  const { dir, mesh } = caseDir();
  const other = path.join(dir, "other.mdpa");
  fs.writeFileSync(other, "");
  writeMonitors(mesh, [point]);
  assert.equal(readMonitors(other).exists, false);
  assert.deepEqual(readMonitors(other).parsed.monitors, []);
});
