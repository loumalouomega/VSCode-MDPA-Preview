import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { volumeTotalPreset, sectionDifference, sectionComparisonPreset, tableRelationshipPreset, checkThreshold, buildPlotPreset, PLOT_PRESETS } from "../parser/plot/presets";
import { validatePlotRecipe, PLOT_CAPABILITIES } from "../parser/plot/recipe";
import { sampleRegion } from "../parser/plot/region";
import { collectPlot } from "../parser/plot/sources";
import { plotPreset } from "../mcp/tools";
import { removeScratchDir } from "./scratchCleanup";
import { flowDuct } from "./fixtures/shapes";
import type { PlotRegionSource } from "../parser/plot/types";

test("section comparison builds one history region curve per section and survives a round trip", () => {
  const r = sectionComparisonPreset({ path: "case.vtu", variable: "PRESSURE", sections: ["Inlet", "Outlet"], times: [0, 1], timeUnit: "s" });
  assert.equal(r.sources.length, 2);
  assert.deepEqual(r.sources.map(s => s.type === "region" && s.scope), ["history", "history"]);
  assert.deepEqual(r.sources.map(s => s.type === "region" && s.submodelpart), ["Inlet", "Outlet"]);
  assert.deepEqual(validatePlotRecipe(JSON.parse(JSON.stringify(r))), r);
  assert.throws(() => sectionComparisonPreset({ path: "c", variable: "P", sections: ["Inlet"] }), /at least two/);
  assert.throws(() => sectionComparisonPreset({ path: "c", variable: "P", sections: ["A", "A"] }), /distinct/);
});

test("the section sources read the known boundary means of a linear pressure duct", () => {
  const model = flowDuct({ pressure: x => 100 - 10 * x });
  const r = sectionComparisonPreset({ path: "d.mdpa", variable: "PRESSURE", sections: ["Inlet", "Outlet"] });
  const means = r.sources.map(s => sampleRegion(model, { ...(s as PlotRegionSource), scope: "current" }).values[0]);
  assert.ok(Math.abs(means[0]! - 100) < 1e-9 && Math.abs(means[1]! - 80) < 1e-9, String(means));
});

test("threshold check: equality passes, violations are measured, gaps are neither pass nor fail", () => {
  const pts = [1, 2, 3, null, 5].map((y, i) => ({ x: i, y }));
  const above = checkThreshold({ id: "s", points: pts }, 3, "above");
  assert.deepEqual([above.checked, above.gaps, above.exceedances, above.worstMargin, above.ok], [4, 1, 1, 2, false]);
  assert.deepEqual(above.first, { x: 4, y: 5 });
  const eq = checkThreshold({ id: "s", points: pts }, 5, "above");
  assert.equal(eq.exceedances, 0); assert.equal(eq.ok, true); assert.equal(eq.gaps, 1);
  const below = checkThreshold({ id: "s", points: pts }, 2, "below");
  assert.equal(below.exceedances, 1); assert.equal(below.worstMargin, 1); assert.deepEqual(below.worst, { x: 0, y: 1 });
  assert.throws(() => checkThreshold({ id: "s", points: pts }, NaN, "above"), /finite/);
});

test("table relationship plots supplied columns end to end, MCP builds the same recipe and checks a limit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plot-preset-"));
  try {
    const file = path.join(dir, "lp.csv");
    await fs.writeFile(file, "disp,load\n0,0\n1,10\n2,25\n3,\n");
    const params = { path: file, x: "c0", y: "c1", units: { c0: "m", c1: "N" } };
    const recipe = tableRelationshipPreset(params);
    const data = await collectPlot(recipe);
    assert.equal(data.series[0].xColumn.unit, "m");
    assert.deepEqual(data.series[0].points.map(p => [p.x, p.y]), [[0, 0], [1, 10], [2, 25], [3, null]]);
    assert.equal(data.series[0].yColumn.unit, "N");
    const out = await plotPreset({ preset: "tableRelationship", params, threshold: { limit: 20, direction: "above" } }) as any;
    assert.deepEqual(out.recipe, recipe);
    assert.equal(out.threshold[0].exceedances, 1);
    assert.equal(out.threshold[0].gaps, 1);
    const plain = await plotPreset({ preset: "tableRelationship", params }) as any;
    assert.equal(plain.series, undefined);
    assert.throws(() => tableRelationshipPreset({ path: file, x: "c0", y: "c0" }), /different/);
  } finally { await removeScratchDir(dir); }
});

test("presets are advertised and unknown ids are refused", () => {
  assert.deepEqual(PLOT_CAPABILITIES.presets.map(p => p.id), PLOT_PRESETS.map(p => p.id));
  assert.throws(() => buildPlotPreset("nope", {}), /Unknown plot preset/);
});

const ductWith = (values: number[], ids = [1, 2]) => {
  const m = flowDuct();
  m.fields.push({ kind: "Elemental", variable: "DENS", components: 1, ids: Int32Array.from(ids), values: Float64Array.from(values) });
  return m;
};
const total = (m: ReturnType<typeof flowDuct>, extra: Partial<PlotRegionSource> = {}) =>
  sampleRegion(m, { id: "t", type: "region", path: "d.mdpa", kind: "Elemental", variable: "DENS", scope: "current", operation: "measureIntegral", ...extra });

test("measureIntegral weights an Elemental field by element volume and reports coverage", () => {
  const r = total(ductWith([2, 3]));
  assert.ok(Math.abs(r.values[0]! - 5) < 1e-9 && Math.abs(r.measure - 2) < 1e-9);
  assert.deepEqual([r.covered, r.partial], [2, false]);
  const gap = total(ductWith([2], [1]));
  assert.ok(Math.abs(gap.values[0]! - 2) < 1e-9 && Math.abs(gap.measure - 1) < 1e-9);
  assert.deepEqual([gap.covered, gap.partial], [1, true]);
  assert.ok(gap.diagnostics.some(d => /no value and are excluded, never counted as zero/.test(d)));
  assert.equal(gap.columns[0].unit, undefined);
  const withUnits = ductWith([2, 3]); withUnits.source = { units: { coords: "m", fields: { DENS: "kg/m³" } } } as any;
  assert.match(total(withUnits).columns[0].unit ?? "", /m³/);
});

test("measureIntegral refuses Nodal and vector fields and boundary parameters", () => {
  assert.throws(() => total(ductWith([1, 1]), { kind: "Nodal" }), /Elemental|No Nodal field/);
  const vec = flowDuct(); vec.fields.push({ kind: "Elemental", variable: "DENS", components: 3, ids: Int32Array.from([1, 2]), values: new Float64Array(6) });
  assert.throws(() => total(vec), /scalar Elemental/);
  const r = volumeTotalPreset({ path: "d.mdpa", variable: "DENS" });
  assert.throws(() => validatePlotRecipe({ ...r, sources: [{ ...(r.sources[0] as PlotRegionSource), thickness: 2 }] }), /does not apply/);
  assert.throws(() => validatePlotRecipe({ ...r, sources: [{ ...(r.sources[0] as PlotRegionSource), kind: "Nodal" }] }), /Elemental/);
});

test("volumeTotal preset: current scope is a bar per region, history scope a line over time", () => {
  const cur = volumeTotalPreset({ path: "d.mdpa", variable: "DENS", regions: ["A", "B"] });
  assert.equal(cur.presentation.family, "bar"); assert.equal(cur.sources.length, 2);
  const hist = volumeTotalPreset({ path: "d.mdpa", variable: "DENS", scope: "history", times: [0, 1], timeUnit: "s" });
  assert.equal(hist.presentation.family, "line"); assert.equal(hist.series[0].x, "time");
  assert.deepEqual(validatePlotRecipe(JSON.parse(JSON.stringify(hist))), hist);
  assert.deepEqual(buildPlotPreset("volumeTotal", { path: "d.mdpa", variable: "DENS" }), volumeTotalPreset({ path: "d.mdpa", variable: "DENS" }));
  assert.ok(PLOT_CAPABILITIES.regionOperations.includes("measureIntegral"));
});

test("sectionDifference subtracts at exactly matching x; gaps and unmatched x are gaps; units must agree", () => {
  const mk = (id: string, ys: [number, number | null][], unit?: string) => ({ id, points: ys.map(([x, y]) => ({ x, y })), yColumn: { id: "v0", label: "p", type: "number" as const, ...(unit ? { unit } : {}) } });
  const d = sectionDifference(mk("in", [[0, 10], [1, 9], [2, null], [3, 7]], "Pa"), mk("out", [[0, 4], [1, 5], [2, 1], [4, 2]], "Pa"));
  assert.deepEqual(d.points.map(p => p.y), [6, 4, null, null]);
  assert.deepEqual([d.matched, d.gaps, d.unit], [2, 3, "Pa"]);
  assert.throws(() => sectionDifference(mk("a", [[0, 1]], "Pa"), mk("b", [[0, 1]], "kPa")), /units differ/);
});

test("plot_preset reports requested section differences from evaluated curves", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plot-diff-"));
  try {
    const file = path.join(dir, "t.csv");
    await fs.writeFile(file, "x,a,b\n0,10,4\n1,9,5\n");
    const out = await plotPreset({ preset: "tableRelationship", params: { path: file, x: "c0", y: "c1" }, differences: [{ from: "relation", to: "relation" }] }) as any;
    assert.equal(out.differences[0].matched, 2);
    assert.deepEqual(out.differences[0].points.map((p: any) => p.y), [0, 0]);
  } finally { await removeScratchDir(dir); }
});
