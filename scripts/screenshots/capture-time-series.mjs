// Captures the Inspect ▸ Plot over time screenshot from the webview harness.
// Companion to capture.mjs / capture-data-table.mjs — same setup.
//
// The harness has no extension host, so the scan cannot run inside the page.
// This script therefore computes the series with the REAL fieldSeriesScan
// module against the committed example/VTK/ series and posts it as the host
// would — the numbers in the shot are the ones in the files, not a mock.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   HARNESS_MESH=example/VTK/Main_0_2.vtk node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-time-series.mjs
//
// Output: images/time-series.png (3360×2000 = 1680×1000 @2x, dark theme).
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const { collectFieldSeries, discoverSeriesSteps } = require(
  path.join(ROOT, "out", "parser", "fieldSeriesScan")
);

function resolvePlaywright() {
  for (const candidate of [
    "playwright-core",
    path.join(process.env.NODE_PATH ?? "", "playwright-core"),
  ]) {
    try {
      return require(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error(
    "playwright-core not found — install it and pass NODE_PATH (see the header comment)."
  );
}

async function main() {
  const mesh = path.join(ROOT, "example", "VTK", "Main_0_2.vtk");
  const { steps } = await discoverSeriesSteps(mesh);

  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({
    viewport: { width: 1680, height: 1000 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForTimeout(4000);

  // Collapse the busy sidebar sections so the chart carries the shot.
  await page.evaluate(() => {
    for (const name of ["edit", "mesh-mod", "problemtype"]) {
      document
        .querySelector(`.sb-section[data-section="${name}"] .sb-section-header`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });

  // The timeline the VTK provider would have announced for this series.
  await page.evaluate(
    (labels) =>
      window.postMessage(
        {
          type: "vtkGroup",
          fileName: "Main_0_2.vtk",
          group: { modelPartName: "Main", steps: labels, subParts: [], ranks: [0] },
        },
        "*"
      ),
    steps.map((s) => s.label)
  );
  await page.waitForTimeout(400);

  // Probe the mesh, then open the chart on the node the pick resolved to.
  await page.click('#toolbar button[data-action="inspect"]');
  await page.waitForTimeout(400);
  const box = await page.$eval("#render-root", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  // The camera framing depends on the viewport, so try a few spots rather than
  // assuming the mesh is under any one of them.
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.45, 0.4],
    [0.55, 0.6],
    [0.4, 0.55],
  ]) {
    await page.mouse.click(box.x + box.w * fx, box.y + box.h * fy);
    await page.waitForTimeout(500);
    const hit = await page.evaluate(
      () => document.querySelectorAll("#inspect-panel .inspect-section").length
    );
    if (hit > 0) break;
  }

  const nodeId = await page.evaluate(() => {
    const s = [...document.querySelectorAll("#inspect-panel .inspect-section")]
      .map((e) => e.textContent ?? "")
      .find((t) => t.startsWith("Nearest node"));
    return s ? Number(s.replace(/\D+/g, "")) : undefined;
  });
  if (!nodeId) throw new Error("the pick did not resolve to a node");

  // Open the NODE section's chart (the second of the two buttons).
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("#inspect-panel .inspect-plot-btn")];
    (btns[btns.length - 1] ?? btns[0])?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(400);

  // Select the variable the shot is about, so the picker and the lines agree.
  await page.evaluate(() => {
    const sel = document.querySelector("#series-panel select");
    if (!sel) return;
    sel.value = "DISPLACEMENT";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(300);

  // The real values for that node, read off the real files.
  const series = await collectFieldSeries(steps, {
    kind: "Nodal",
    variable: "DISPLACEMENT",
    entityId: nodeId,
  });
  await page.evaluate((s) => window.postMessage({ type: "fieldSeriesResult", series: s }, "*"), series);
  await page.waitForTimeout(1200);

  // Report what rendered, so a silent failure cannot pass as a shot.
  const state = await page.evaluate(() => {
    const p = document.getElementById("series-panel");
    const c = p?.querySelector("canvas.series-chart");
    let painted = 0;
    if (c) {
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    }
    return {
      title: p?.querySelector(".meshsize-title")?.textContent,
      legend: [...(p?.querySelectorAll(".series-legend-item") ?? [])].map((e) => e.textContent),
      painted,
    };
  });
  console.log(JSON.stringify({ nodeId, present: series.present, ...state }, null, 2));
  if (state.painted < 200) throw new Error(`the chart drew almost nothing (${state.painted} px)`);

  const out = path.join(ROOT, "images", "time-series.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
