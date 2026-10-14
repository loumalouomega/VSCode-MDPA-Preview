// Captures a real `tableRelationship` plot preset for
// doc/guide/plot-presets.md: the recipe is built by the actual
// `buildPlotPreset`, evaluated by the real `evaluatePlot`, and rendered by
// the real plots bundle — the same pipeline the viewer and `plot_preset`
// share. A gap in the table stays a gap on the chart.
//
// Setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/opencode/pw && cd /tmp/opencode/pw && npm i playwright-core
// Then from the repo root:
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/opencode/pw/node_modules node scripts/screenshots/capture-plot-presets.mjs
//
// Output: doc/public/screenshots/plot-presets.png (1400×950, dark theme,
// matching the other plot screenshots).
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");

const { plotHtml } = require(path.join(root, "out/parser/plot/html.js"));
const { evaluatePlot, displayPlot } = require(path.join(root, "out/parser/plot/numerics.js"));
const { parsePlotTable } = require(path.join(root, "out/parser/plot/importTable.js"));
const { buildPlotPreset } = require(path.join(root, "out/parser/plot/presets.js"));

// A tensile-test table with one missing measurement: the preset must draw
// the gap, never bridge it.
const csv = "Displacement [mm],Load [N]\n0,0\n0.5,2.1\n1.0,4.3\n1.5,NA\n2.0,8.2\n2.5,10.1\n3.0,12.4\n";
const table = parsePlotTable(csv);
const recipe = buildPlotPreset("tableRelationship", {
  path: "tensile.csv",
  x: "c0",
  y: "c1",
  xLabel: "Displacement [mm]",
  yLabel: "Load [N]",
});
const dataset = displayPlot(evaluatePlot(recipe, { table }));
assert.ok(dataset.series.length === 1, "preset must yield one series");
assert.ok(
  dataset.series[0].points.some((p) => p.y === null),
  "the NA row must survive as a gap"
);

const dir = "/tmp/opencode/plot-presets-shot";
await fs.mkdir(dir, { recursive: true });
const html = plotHtml(
  `file://${root}/media/plots.js`,
  `file://${root}/media/plotly/plotly.min.js`,
  `file://${root}/media/design-system.css`,
  `file://${root}/media/plots.css`,
  "plot-presets-nonce",
  "file:"
);
await fs.writeFile(path.join(dir, "index.html"), html);

const launchOpts = { args: ["--no-sandbox"] };
if (process.env.PLAYWRIGHT_EXE) launchOpts.executablePath = process.env.PLAYWRIGHT_EXE;
if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(launchOpts);
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.exposeFunction("__plotHost", async (msg) => {
    if (msg.type === "plotReady") return { type: "plotRecipe", recipe };
    if (msg.type === "plotPreview")
      return {
        type: "plotSourcePreview",
        requestId: msg.requestId,
        source: msg.source,
        columns: table.columns,
        rows: table.rows.slice(0, 12),
        rowCount: table.rows.length,
        diagnostics: [],
      };
    if (msg.type === "plotEvaluate")
      return { type: "plotResult", requestId: msg.requestId, dataset };
    return null;
  });
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({
      postMessage: (msg) =>
        window.__plotHost(msg).then((reply) => {
          if (reply) window.dispatchEvent(new MessageEvent("message", { data: reply }));
        }),
      getState: () => undefined,
      setState: () => {},
    });
  });
  await page.goto(`file://${dir}/index.html`);
  await page.waitForFunction(() => document.querySelector("#plot-chart")?.data?.length === 1);
  await page.waitForFunction(
    () =>
      document.querySelector("#plot-status").textContent.includes("full-resolution points") &&
      document.querySelector("#plot-chart").getAttribute("aria-busy") !== "true"
  );
  await page.waitForTimeout(400);
  const out = path.join(root, "doc/public/screenshots/plot-presets.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  assert.equal(errors.length, 0, errors.join("\n"));
} finally {
  await browser.close();
}
