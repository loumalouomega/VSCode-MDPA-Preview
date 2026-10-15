import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fieldDistributionPreset, volumeTotalPreset, tensorComponentsPreset, heatFluxBalancePreset, sectionDifference, sectionComparisonPreset, tableRelationshipPreset, checkThreshold, buildPlotPreset, PLOT_PRESETS } from "../parser/plot/presets";
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

test("section comparison converts kinematic pressure to Pa with an explicit density, so a drop is subtractable", () => {
  const model = flowDuct({ pressure: x => 2 - 1.5 * x / 4 });
  const field = model.fields.find(f => f.variable === "PRESSURE")!;
  field.dimensions = { exponents: [0, 2, -2, 0, 0, 0, 0] };
  model.source = { format: "mdpa", units: { fields: { PRESSURE: "m²/s²" } } } as any;
  const mean = (r: ReturnType<typeof sectionComparisonPreset>, i: number) => sampleRegion(model, { ...(r.sources[i] as PlotRegionSource), scope: "current" });
  const plain = sectionComparisonPreset({ path: "d.mdpa", variable: "PRESSURE", sections: ["Inlet", "Outlet"] });
  const dens = sectionComparisonPreset({ path: "d.mdpa", variable: "PRESSURE", sections: ["Inlet", "Outlet"], pressureDensity: 1000 });
  const a = mean(plain, 0).values[0]!, b = mean(plain, 1).values[0]!;
  const pa = mean(dens, 0), pb = mean(dens, 1);
  assert.ok(Math.abs(pa.values[0]! - 1000 * a) < 1e-6 && Math.abs(pb.values[0]! - 1000 * b) < 1e-6);
  assert.equal(pa.columns[0].unit, "Pa");
  assert.deepEqual(pa.columns[0].dimensions, [1, -1, -2, 0, 0, 0, 0]);
  assert.equal(mean(plain, 0).columns[0].unit, "m²/s²");
  const diff = sectionDifference(
    { id: "in", points: [{ x: 0, y: pa.values[0]! }], yColumn: pa.columns[0] } as any,
    { id: "out", points: [{ x: 0, y: pb.values[0]! }], yColumn: pb.columns[0] } as any);
  assert.equal(diff.unit, "Pa");
  assert.ok(Math.abs(diff.points[0].y! - 1000 * (a - b)) < 1e-6);
  assert.throws(() => sectionDifference({ id: "in", points: [], yColumn: pa.columns[0] } as any, { id: "out", points: [], yColumn: mean(plain, 1).columns[0] } as any), /units differ/);
  assert.deepEqual(validatePlotRecipe(JSON.parse(JSON.stringify(dens))), dens);
});

test("pressure density is refused for unknown, already-physical or non-pressure fields and for the wrong operation", () => {
  const model = flowDuct({ pressure: () => 5 });
  const src = (extra: Partial<PlotRegionSource>): PlotRegionSource => ({ id: "s", type: "region", path: "d.mdpa", kind: "Nodal", variable: "PRESSURE", submodelpart: "Inlet", scope: "current", operation: "boundaryMean", pressureDensity: 1000, ...extra } as PlotRegionSource);
  assert.throws(() => sampleRegion(model, src({})), /kinematic pressure/);
  const field = model.fields.find(f => f.variable === "PRESSURE")!;
  field.dimensions = { exponents: [1, -1, -2, 0, 0, 0, 0] };
  assert.throws(() => sampleRegion(model, src({})), /kinematic pressure/);
  field.dimensions = { exponents: [0, 2, -2, 0, 0, 0, 0] };
  model.source = { format: "mdpa", units: { fields: { PRESSURE: "m²/s²" } } } as any;
  assert.throws(() => sampleRegion(model, src({ operation: "boundaryIntegral" })), /pressure loads/);
  assert.throws(() => sampleRegion(model, src({ operation: "max", submodelpart: undefined })), /pressure loads and to mean/);
  assert.throws(() => validatePlotRecipe({ ...emptyRecipeWith(src({ operation: "max" })) }), /Pressure density applies/);
  assert.throws(() => validatePlotRecipe(emptyRecipeWith(src({ pressureDensity: -1 }))), /pressureDensity/);
});
function emptyRecipeWith(source: PlotRegionSource) {
  return { ...sectionComparisonPreset({ path: "d.mdpa", variable: "PRESSURE", sections: ["A", "B"] }), sources: [source], series: [] };
}

test("tensor components preset samples one curve per component index and names them by index only", () => {
  const model = flowDuct();
  const ids = Array.from(model.nodeIds);
  const xOf = (id: number) => model.coords[3 * ids.indexOf(id)];
  const width = 6, values = new Float64Array(ids.length * width);
  ids.forEach((id, i) => { for (let c = 0; c < width; c++) values[i * width + c] = c + xOf(id); });
  model.fields.push({ kind: "Nodal", variable: "STRESS", components: width, ids: Int32Array.from(ids), values } as any);
  const r = tensorComponentsPreset({ path: "d.mdpa", variable: "STRESS", submodelpart: "Outlet", width });
  assert.equal(r.series.length, width);
  assert.ok(r.series.every((s, c) => s.name === `STRESS [${c}] · Outlet`));
  r.sources.forEach((src, c) => {
    const v = sampleRegion(model, { ...(src as PlotRegionSource), scope: "current" }).values[0]!;
    assert.ok(Math.abs(v - (c + 2)) < 1e-9, `${c}: ${v}`);
  });
  assert.deepEqual(validatePlotRecipe(JSON.parse(JSON.stringify(r))), r);
  assert.equal(tensorComponentsPreset({ path: "d", variable: "S", submodelpart: "Inlet", components: [4, 1] }).series.length, 2);
  assert.throws(() => tensorComponentsPreset({ path: "d", variable: "S", submodelpart: "Inlet" }), /component indices/);
  assert.throws(() => tensorComponentsPreset({ path: "d", variable: "S", submodelpart: "Inlet", components: [1, 1] }), /distinct/);
  assert.throws(() => tensorComponentsPreset({ path: "d", variable: "S", submodelpart: "Inlet", width: 10 }), /component indices/);
  assert.throws(() => tensorComponentsPreset({ path: "d", variable: "S", submodelpart: "", width: 3 }), /SubModelPart/);
  const bad = tensorComponentsPreset({ path: "d.mdpa", variable: "STRESS", submodelpart: "Inlet", components: [7] });
  assert.throws(() => sampleRegion(model, { ...(bad.sources[0] as PlotRegionSource), scope: "current" }), /component/);
});

test("heat-flux balance preset reports signed outward flux of a supplied vector field", () => {
  const model = flowDuct({ velocity: () => [2, 0, 0] });
  model.fields.find(f => f.variable === "VELOCITY")!.variable = "HEAT_FLUX";
  const r = heatFluxBalancePreset({ path: "d.mdpa", variable: "HEAT_FLUX", sections: ["Inlet", "Outlet"] });
  assert.equal(r.series.length, 2);
  const [a, b] = r.sources.map(src => sampleRegion(model, { ...(src as PlotRegionSource), scope: "current" }).values[0]!);
  assert.ok(Math.abs(a + 2) < 1e-9 && Math.abs(b - 2) < 1e-9, `${a} ${b}`);
  assert.deepEqual(validatePlotRecipe(JSON.parse(JSON.stringify(r))), r);
  assert.throws(() => heatFluxBalancePreset({ path: "d", variable: "Q", sections: [] }), /at least one/);
  assert.throws(() => heatFluxBalancePreset({ path: "d", variable: "Q", sections: ["A", "A"] }), /distinct/);
  const scalar = flowDuct({ pressure: () => 1 });
  const s0 = heatFluxBalancePreset({ path: "d", variable: "PRESSURE", sections: ["Inlet"] });
  assert.throws(() => sampleRegion(scalar, { ...(s0.sources[0] as PlotRegionSource), scope: "current" }), /vector/);
  assert.deepEqual(buildPlotPreset("heatFluxBalance", { path: "d", variable: "Q", sections: ["Inlet"] }).sources.length, 1);
  assert.ok(PLOT_PRESETS.some(p => p.id === "tensorComponents") && PLOT_CAPABILITIES.presets.some(p => p.id === "heatFluxBalance"));
});

test("field distribution preset histograms a displayed field and counts uncovered rows as gaps", async () => {
  const mdpa = "Begin Properties 1\nEnd Properties\nBegin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\nEnd Nodes\n"
    + "Begin Elements Element3D4N\n1 1 1 2 3 4\nEnd Elements\n"
    + "Begin NodalData PRESSURE\n1 0 1.0\n2 0 2.0\n3 0 3.0\nEnd NodalData\n"
    + "Begin NodalData VELOCITY\n1 0 [3] (3,4,0)\n2 0 [3] (0,0,2)\n3 0 [3] (1,0,0)\n4 0 [3] (0,0,0)\nEnd NodalData\n";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fdist-"));
  try {
    const file = path.join(dir, "m.mdpa");
    await fs.writeFile(file, mdpa);
    const r = buildPlotPreset("fieldDistribution", { path: file, variable: "PRESSURE", kind: "Nodal", bins: 2 });
    assert.equal(r.presentation.family, "histogram");
    assert.equal(r.series[0].bins, 2);
    assert.deepEqual(validatePlotRecipe(JSON.parse(JSON.stringify(r))), r);
    const data = await collectPlot(r);
    const counts = data.series[0].points.map(p => p.y);
    assert.equal(counts.reduce((a, b) => a! + b!, 0), 3, "node 4 has no PRESSURE and is excluded, not counted as 0");
    const mag = fieldDistributionPreset({ path: file, variable: "VELOCITY", kind: "Nodal", components: 3, component: "magnitude", bins: 1 });
    assert.equal(mag.series[0].component, "magnitude");
    assert.equal(mag.series[0].components?.length, 3);
    const m = await collectPlot(mag);
    assert.equal(m.series[0].points.reduce((a, p) => a + (p.y ?? 0), 0), 4);
    assert.throws(() => fieldDistributionPreset({ path: file, variable: "X", kind: "Geometries" as any }), /not Geometries/);
    assert.throws(() => fieldDistributionPreset({ path: file, variable: "X", bins: 0 }), /bins/);
    assert.ok(PLOT_PRESETS.some(p => p.id === "fieldDistribution"));
  } finally { await removeScratchDir(dir); }
});
