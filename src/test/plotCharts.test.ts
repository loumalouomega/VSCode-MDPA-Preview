import assert from "node:assert/strict";
import test from "node:test";
import { parsePlotTable } from "../parser/plot/importTable";
import { emptyPlotRecipe, PLOT_CAPABILITIES, validatePlotRecipe } from "../parser/plot/recipe";
import { evaluatePlot, displayPlot } from "../parser/plot/numerics";
import { plotFigure } from "../parser/plot/figure";
import { plotCsvRows, plotManifest } from "../parser/plot/export";
import { plotDataset } from "../mcp/tools";
import { PLOT_FAMILIES, type PlotFamily, type PlotRecipe, type PlotSeriesSpec, type PlotTable } from "../parser/plot/types";

const theme = { fg: "#ccc", bg: "#111", font: "sans-serif", palette: ["#123456", "#654321"] };
function recipe(table: PlotTable, family: PlotFamily, spec: Partial<PlotSeriesSpec> = {}): PlotRecipe {
  return { ...emptyPlotRecipe({ id: "a", type: "inline", table }), series: [{ id: "s", source: "a", name: "Samples", x: "c0", y: "c1", ...spec }], presentation: { family, title: "Charts", panels: 1 } };
}
const weights = () => parsePlotTable("Category,Weight [N]\nA,1\nA,2\nB,3\nEmpty,NA\nZero,0\n");

test("all twelve families and presentation mappings round-trip without changing legacy recipes", () => {
  assert.equal(PLOT_FAMILIES.length, 12);
  for (const family of PLOT_FAMILIES) {
    const r = recipe(weights(), family, { size: "c1", sizeMax: 48, statistic: "sum" });
    r.presentation.lineMode = "lines"; r.presentation.barMode = "stack"; r.presentation.barOrientation = "h";
    assert.deepEqual(validatePlotRecipe(JSON.parse(JSON.stringify(r))), r);
    assert.ok(PLOT_CAPABILITIES.families.includes(family));
  }
  const legacy = recipe(weights(), "line"); assert.deepEqual(validatePlotRecipe(legacy), legacy);
  for (const bad of [{ lineMode: "spline" }, { barMode: "auto" }, { barOrientation: "diagonal" }]) assert.throws(() => validatePlotRecipe({ ...legacy, presentation: { ...legacy.presentation, ...bad } }));
  for (const sizeMax of [0, 3, 101, Infinity]) assert.throws(() => validatePlotRecipe({ ...legacy, series: [{ ...legacy.series[0], sizeMax }] }), /diameter/);
});
test("pie weights and shares are host-computed; empty categories stay gaps and originals stay intact", () => {
  const t = weights(), r = recipe(t, "pie", { statistic: "sum" }), d = evaluatePlot(r, { a: t });
  assert.equal(d.partial, false); assert.deepEqual(d.series[0].points.map(p => p.y), [3, 3, null, 0]);
  assert.deepEqual(d.series[0].points.map(p => p.share), [.5, .5, null, 0]); assert.equal(d.series[0].categoryTotal, 6);
  assert.equal(d.series[0].original.length, 5); assert.equal(d.series[0].original[0].y, 1);
  assert.match(d.series[0].diagnostics.join(" "), /not an exclusive physical partition/);
  const figure = plotFigure(displayPlot(d), theme); assert.deepEqual(figure.traces[0].values, [3, 3]); assert.equal(figure.traces[0].sort, false); assert.equal(figure.layout.xaxis, undefined);
  assert.deepEqual(figure.traces[0].text, ["50.0%", "50.0%"]); assert.equal(figure.layout.legend.itemclick, false); assert.equal(figure.layout.legend.itemdoubleclick, false);
  assert.deepEqual(plotFigure(d, { ...theme, palette: ["#eeeeee", "#222222"] }).traces[0].insidetextfont.color, [theme.bg, theme.fg]);
  assert.match([...plotCsvRows(d)][0], /size,size_unit,share/); assert.equal((plotManifest(d) as any).series[0].categoryTotal, 6);
});
test("circular charts require an explicit statistic, reject negative/zero/overflow weights and log axes", () => {
  const t = weights(); assert.match(evaluatePlot(recipe(t, "pie"), { a: t }).diagnostics.join(" "), /explicit category statistic/);
  for (const csv of ["A,-1\nB,2", "A,0\nB,0", "A,1e308\nA,1e308"]) {
    const t = parsePlotTable(`Category,Weight\n${csv}\n`), d = evaluatePlot(recipe(t, "doughnut", { statistic: "sum" }), { a: t });
    assert.equal(d.partial, true); assert.equal(d.series.length, 0); assert.match(d.diagnostics.join(" "), /negative|positive total/);
  }
  const r = recipe(t, "pie", { statistic: "count" }); r.presentation.yScale = "log";
  assert.match(evaluatePlot(r, { a: t }).diagnostics.join(" "), /no log axes/);
  const partial = recipe(t, "pie"); partial.series.push({ ...partial.series[0], id: "valid", name: "Finite count", statistic: "count" });
  const retained = evaluatePlot(partial, { a: t }); assert.equal(retained.partial, true); assert.deepEqual(retained.series.map(s => s.id), ["valid"], "An invalid series must not exclude an available series through its unfinished unit mapping");
});
test("category statistics, filters and supplied conversions are explicit and numerically stable", () => {
  const t = weights();
  for (const [statistic, expected] of [["sum", 3], ["count", 2], ["mean", 1.5], ["min", 1], ["max", 2]] as const) {
    const d = evaluatePlot(recipe(t, "pie", { statistic }), { a: t }); assert.equal(d.series[0].points[0].y, expected);
    assert.equal(d.series[0].yColumn.unit, statistic === "count" ? "1" : "N");
  }
  const huge = parsePlotTable("Category,Weight\nA,1e308\nA,1e308\n"); assert.equal(evaluatePlot(recipe(huge, "pie", { statistic: "mean" }), { a: huge }).series[0].points[0].y, 1e308);
  const negatives = parsePlotTable("Category,Weight [N]\nA,-1\nB,2\n");
  assert.equal(evaluatePlot(recipe(negatives, "pie", { statistic: "count" }), { a: negatives }).series[0].categoryTotal, 2);
  const r = recipe(negatives, "pie", { statistic: "sum", filter: { column: "c1", min: 0 }, transforms: [{ op: "convert", factor: .001, unit: "kN" }] });
  const d = evaluatePlot(r, { a: negatives }); assert.equal(d.series[0].points[0].y, .002); assert.equal(d.series[0].yColumn.unit, "kN");
});
test("categorical aggregation does not invent an entity identity or propagate uncertainty", () => {
  const t = parsePlotTable("Category,Y [N],Error [N]\nA,1,0.1\nA,2,0.2\nB,3,0.3\n");
  t.origins = t.rows.map((_, rowIndex) => ({ source: "a", entityKind: "Nodes", entityId: rowIndex + 1 }));
  const d = evaluatePlot(recipe(t, "pie", { statistic: "sum", uncertainty: { column: "c2", meaning: "supplied" } }), { a: t });
  assert.equal(d.series[0].points[0].origin, undefined); assert.equal(d.series[0].points[1].origin?.entityId, 3);
  assert.equal(d.series[0].points[0].error, undefined); assert.equal(d.series[0].original[0].error, .1);
  assert.match(d.series[0].diagnostics.join(" "), /not propagated/);
});
test("pie delivery never samples categories or changes shares; category budgets refuse truncation", () => {
  const t = weights(); t.rows = Array.from({ length: 800 }, (_, i) => [`C${i}`, i + 1]);
  const d = evaluatePlot(recipe(t, "doughnut", { statistic: "sum" }), { a: t }); assert.equal(displayPlot(d, 20).series[0].points.length, 800);
  t.rows = Array.from({ length: 1001 }, (_, i) => [`C${i}`, 1]); assert.match(evaluatePlot(recipe(t, "pie", { statistic: "sum" }), { a: t }).diagnostics.join(" "), /1000 categories/);
});
test("multiple doughnuts have separate non-overlapping domains and incompatible units are refused", () => {
  const t = weights(), r = recipe(t, "doughnut", { statistic: "sum" }); r.series.push({ ...r.series[0], id: "other", name: "Other" });
  const d = evaluatePlot(r, { a: t }), figure = plotFigure(d, theme);
  assert.equal(figure.traces.length, 2); assert.equal(figure.traces[0].hole, .55); assert.ok(figure.traces[0].domain.x[1] < figure.traces[1].domain.x[0]);
  r.series[1].transforms = [{ op: "convert", factor: .001, unit: "kN" }]; assert.match(evaluatePlot(r, { a: t }).diagnostics.join(" "), /convert explicitly/);
  r.presentation.panels = 2; r.series[1].panel = 1; assert.equal(evaluatePlot(r, { a: t }).partial, false);
});
test("bubble sizes need an explicit numeric mapping, retain original negatives and use full-resolution area scale", () => {
  const t = parsePlotTable("X [s],Y [N],Size [mm],Text\n0,1,4,A\n1,3,-2,B\n2,5,NA,C\n3,7,0,D\n4,9,16,E\n");
  assert.match(evaluatePlot(recipe(t, "bubble"), { a: t }).diagnostics.join(" "), /explicit supplied size/);
  assert.match(evaluatePlot(recipe(t, "bubble", { size: "c3" }), { a: t }).diagnostics.join(" "), /numeric column/);
  const d = evaluatePlot(recipe(t, "bubble", { size: "c2", sizeMax: 40 }), { a: t }), s = d.series[0];
  assert.deepEqual(s.points.map(p => p.size), [4, -2, null, 0, 16]); assert.equal(s.original[1].size, -2); assert.equal(s.sizeMaximum, 16); assert.equal(s.sizeColumn?.unit, "mm");
  assert.match(s.diagnostics.join(" "), /3 missing, negative or zero/);
  const trace = plotFigure(d, theme).traces[0]; assert.equal(trace.mode, "markers"); assert.equal(trace.marker.sizemode, "area"); assert.equal(trace.marker.sizeref, 32 / 1600); assert.deepEqual(trace.marker.size, [4, 0, 0, 0, 16]);
  assert.equal((plotManifest(d) as any).series[0].size.unit, "mm");
});
test("line, pure scatter, step and area styles preserve values, full peaks and missing intervals", () => {
  const t = parsePlotTable("X [s],Y [N]\n0,1\n1,3\n2,NA\n3,2\n4,4\n");
  for (const family of ["line", "step", "area", "scatter"] as const) {
    const r = recipe(t, family), d = evaluatePlot(r, { a: t }); assert.deepEqual(d.series[0].points.map(p => p.y), [1, 3, null, 2, 4]); assert.equal(d.series[0].peak?.y, 4);
    const f = plotFigure(d, theme);
    if (family === "line") { assert.equal(f.traces[0].mode, "lines+markers"); r.presentation.lineMode = "lines"; assert.equal(plotFigure(evaluatePlot(r, { a: t }), theme).traces[0].mode, "lines"); }
    if (family === "scatter") assert.equal(f.traces[0].mode, "markers");
    if (family === "step") assert.equal(f.traces[0].line.shape, "hv");
    if (family === "area") { assert.equal(f.traces.length, 2); assert.deepEqual(f.traces.map(t => t.x), [[0, 1], [3, 4]]); assert.ok(f.traces.every(t => t.fill === "tozeroy")); assert.equal(f.traces[1].showlegend, false); }
  }
});
test("bubble display selection retains size maxima without changing full statistics or CSV", () => {
  const t = parsePlotTable("X,Y,Size\n0,0,1\n1,0,1\n2,0,1\n"); t.rows = Array.from({ length: 1000 }, (_, i) => [i, 1, i === 503 ? 10000 : 1]);
  const d = evaluatePlot(recipe(t, "bubble", { size: "c2" }), { a: t }), display = displayPlot(d, 50);
  assert.ok(display.series[0].points.length <= 50); assert.ok(display.series[0].points.some(p => p.size === 10000)); assert.equal(display.series[0].sizeMaximum, 10000);
  assert.deepEqual(display.series[0].statistics, d.series[0].statistics); assert.equal([...plotCsvRows(d)].length, 2001);
});
test("horizontal signed stacks swap axes, scales and values but never change supplied statistics", () => {
  const t = weights(), r = recipe(t, "bar", { statistic: "sum" }); r.presentation.barMode = "stack"; r.presentation.barOrientation = "h"; r.presentation.yScale = "log"; r.presentation.yRange = [1, 10];
  const d = evaluatePlot(r, { a: t }), f = plotFigure(d, theme); assert.deepEqual(f.traces[0].x, [3, 3, null, null]); assert.deepEqual(f.traces[0].y, ["A", "B", "Empty", "Zero"]);
  assert.equal(f.traces[0].orientation, "h"); assert.equal(f.layout.barmode, "relative"); assert.equal(f.layout.xaxis.type, "log"); assert.deepEqual(f.layout.xaxis.range, [0, 1]); assert.equal(f.layout.yaxis.type, "category");
  assert.match(d.series[0].diagnostics.join(" "), /not proof of disjoint regions/);
});
test("MCP returns the same circular aggregation, shares and bubble mapping as the UI worker", async () => {
  const t = weights(), r = recipe(t, "pie", { statistic: "sum" }), result = await plotDataset({ recipe: r, limit: 100 }) as any;
  assert.equal(result.series[0].categoryTotal, 6); assert.deepEqual(result.series[0].points.map((p: any) => p.share), [.5, .5, null, 0]);
  const b = parsePlotTable("X,Y,Size\n0,1,4\n1,2,9\n"), bubble = await plotDataset({ recipe: recipe(b, "bubble", { size: "c2" }), limit: 100 }) as any;
  assert.equal(bubble.series[0].sizeMaximum, 9); assert.deepEqual(bubble.series[0].points.map((p: any) => p.size), [4, 9]);
});
