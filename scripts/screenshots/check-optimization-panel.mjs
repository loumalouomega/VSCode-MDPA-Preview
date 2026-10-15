// Chromium smoke check for the Optimization progress panel
// (webview/optimizationPanel.ts + its main.ts wiring).
//
// The panel draws whatever the host posts as `optimizationProgress`; the host
// half is unit-tested (optimizationProgressHost.test.ts) but the panel needs a
// DOM. This script drives the REAL webview bundle in the screenshot harness,
// opens the panel from the Advanced menu, answers it the way the host would
// (a `message` event built from the committed summary fixture through the same
// parser the host uses), and asserts the formulation, verdict, both charts,
// the constraint legend, the table and the messages each button posts.
//
// Setup and run (playwright is deliberately not a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-optimization-panel.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolvePlaywright() {
  for (const c of ["playwright-core", path.join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright-core not found — see the header comment.");
}

const { parseOptimizationSummary, summarizeOptimization, optimizationCaseInfo, optimizationFormulation } = require(
  path.join(ROOT, "out", "problemtype", "optimization", "summaryLog.js")
);
const text = fs.readFileSync(path.join(ROOT, "src", "test", "fixtures", "optimization", "gradient_projection_cut.csv"), "utf8");
const parsed = parseOptimizationSummary(text);
const info = optimizationCaseInfo({
  algorithm_settings: {
    type: "algorithm_gradient_projection",
    settings: { conv_settings: { max_iter: 10 } },
    controls: ["thickness_control"],
    objective: { response_expression: "mass", type: "minimization" },
    constraints: [{ response_expression: "strain_energy", type: "<=" }],
  },
});
const progress = {
  type: "optimizationProgress",
  available: true,
  caseName: "shell",
  formulation: optimizationFormulation(info),
  designFields: true,
  summary: summarizeOptimization(parsed, info, "running"),
  columns: parsed.columns,
  rows: parsed.rows,
  totalRows: parsed.rows.length,
  warnings: parsed.warnings,
};

execFileSync("node", [path.join(ROOT, "scripts", "screenshots", "build-harness.mjs")], { stdio: "pipe" });
const { chromium } = resolvePlaywright();
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(3500);
const sent = () => page.evaluate(() => (window.SENT_MESSAGES ?? []).map((m) => m.type));

await page.click('#toolbar button[data-action="advanced"]');
await page.click('#advanced-popup [data-action="optimizationProgress"]');
await page.waitForTimeout(150);
assert.equal(await page.evaluate(() => document.getElementById("optimization-panel").style.display), "");
assert.ok((await sent()).includes("optimizationProgressRequest"), "opening asks the host");
assert.match(await page.evaluate(() => document.getElementById("optimization-panel").innerText), /Reading the optimization summary/);

await page.evaluate((m) => window.postMessage(m, "*"), progress);
await page.waitForTimeout(300);
const view = await page.evaluate(() => {
  const el = document.getElementById("optimization-panel");
  return {
    title: el.querySelector(".meshsize-title")?.textContent,
    formulation: el.querySelector(".opt-formulation")?.textContent,
    verdict: el.querySelector(".opt-verdict")?.textContent,
    charts: el.querySelectorAll("canvas.opt-chart").length,
    chartWidths: [...el.querySelectorAll("canvas.opt-chart")].map((c) => c.width),
    legend: [...el.querySelectorAll(".opt-legend span > span:last-child")].map((s) => s.textContent),
    header: [...el.querySelectorAll(".opt-table th")].map((t) => t.textContent),
    firstRow: [...(el.querySelector(".opt-table tr:nth-child(2)")?.querySelectorAll("td") ?? [])].map((t) => t.textContent),
    warnings: [...el.querySelectorAll(".opt-warning")].map((w) => w.textContent),
  };
});
assert.equal(view.title, "Optimization — shell");
assert.match(view.formulation, /minimize mass subject to strain_energy <= reference · controls: thickness_control · gradient projection/);
assert.match(view.verdict, /iter 3\/10 · objective −3\.4% · 1\/1 constraints met · running/);
assert.equal(view.charts, 2, "objective and constraint charts");
assert.ok(view.chartWidths.every((w) => w > 0), "the charts were drawn");
assert.deepEqual(view.legend, ["strain_energy <= ✓"]);
assert.deepEqual(view.header, ["STEP", "mass:value", "strain_energy:value", "strain_energy:std_value"]);
assert.equal(view.firstRow[0], "2", "newest step first");
assert.match(view.warnings.join(" "), /last row was cut short/);

for (const [label, type] of [["Open in Plots", "optimizationPlot"], ["Design fields", "optimizationDesignFields"], ["Export CSV", "menuExportAnalysis"]]) {
  await page.evaluate((l) => [...document.querySelectorAll("#optimization-panel .panel-btn")].find((b) => b.textContent === l).click(), label);
  assert.ok((await sent()).includes(type), `${label} posts ${type}`);
}
const csv = await page.evaluate(() => window.SENT_MESSAGES.filter((m) => m.type === "menuExportAnalysis").pop());
assert.equal(csv.suffix, "optimization-summary");
assert.match(csv.csv, /^STEP,mass:value,strain_energy:value,strain_energy:std_value\n0,5887\.5/);

// Opening another left-dock panel dismisses this one; the explicit close stops following.
await page.click('#toolbar button[data-action="advanced"]');
await page.click('#advanced-popup [data-action="integrals"]');
await page.waitForTimeout(150);
assert.equal(await page.evaluate(() => document.getElementById("optimization-panel").style.display), "none");
await page.click('#toolbar button[data-action="advanced"]');
await page.click('#advanced-popup [data-action="optimizationProgress"]');
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(ROOT, "out", "screenshot-harness", "check-optimization-panel.png") });
await page.click("#optimization-panel .meshsize-close");
assert.ok((await sent()).includes("optimizationProgressStop"), "closing stops following");

// --- A host-pushed selection (Kratos Runs ▸ Show HROM elements) -----------------------------
await page.evaluate(() => window.postMessage({ type: "selectionSeed", name: "HROM", kinds: { Elements: [3, 1, 2, 2, 999999999], Conditions: [] } }, "*"));
await page.waitForTimeout(400);
const selection = await page.evaluate(() => ({
  visible: document.getElementById("selection-panel")?.style.display !== "none",
  text: document.getElementById("selection-panel")?.innerText ?? "",
}));
assert.ok(selection.visible, "the selection panel opens on a pushed set");
assert.match(selection.text, /HROM/);
const saved = await page.evaluate(() => window.SENT_MESSAGES.filter((m) => m.type === "viewLayersSave" && m.view?.selections).pop()?.view.selections);
if (saved) {
  const hrom = saved.find((s) => s.name === "HROM");
  assert.deepEqual(hrom.ids?.Elements ?? hrom.kinds?.Elements, [1, 2, 3], "deduplicated, sorted, and the id the mesh lacks is pruned");
}

assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
await browser.close();
console.log("check-optimization-panel: OK");
