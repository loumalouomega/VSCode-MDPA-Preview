import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { sectionComparisonPreset, tableRelationshipPreset, checkThreshold, buildPlotPreset, PLOT_PRESETS } from "../parser/plot/presets";
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
