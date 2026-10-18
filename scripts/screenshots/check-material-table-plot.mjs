// Chromium smoke check for the Materials form's table PLOT: the chart beside
// the grid of a temperature-dependent viscosity table, whose points drag-edit
// the table.
//
// `webview/problemtype.ts` and `webview/materialTablePlot.ts` need a DOM, so the
// node tests cover only the geometry (`materialTablePlot.test.ts`). What can
// fail silently in the real UI is the wiring: a pointer that never reaches the
// chart, a drag that moves the marker but not the grid, a grid edit that does
// not redraw, or a `ptState` that carries stale text. This script drives the REAL
// webview bundle in the screenshot harness with real pointer and key events and
// asserts on the grid, the chart and the exact `ptState` recorded on
// `window.SENT_MESSAGES`.
//
// What it pins down:
//   - one marker per drawable row, axes titled with the table's variables;
//   - dragging a marker rewrites the grid inputs AND the saved case text, keeps
//     the input column increasing even when dragged past a neighbour, and leaves
//     the focus on the marker;
//   - typing in the grid moves the marker;
//   - double-click on empty space adds a row in input order; a duplicate input is
//     refused with a readout;
//   - arrow keys nudge a focused marker and Delete removes it;
//   - the "preview tables" link posts `ptPreviewTables` (the host opens the Plots workspace);
//   - a malformed row stays in the grid but is not drawn, and fewer than two
//     drawable rows shows the hint instead of an empty frame.
//
// Setup and run (playwright is deliberately not a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-material-table-plot.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
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

const lastTable = async () =>
  page.evaluate(() => {
    const all = (window.SENT_MESSAGES ?? []).filter((m) => m.type === "ptState");
    const state = all.length > 0 ? all[all.length - 1].state : undefined;
    const mat = state?.materials?.find((m) => /temperature_dependent/.test(m.lawId));
    return mat?.values?.TEMPERATURE_TABLE;
  });
const gridRows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("#pt-materials .pt-table-grid > .pt-table-row")].map((r) => {
      const [a, b] = r.querySelectorAll("input");
      return [a.value, b.value];
    })
  );
/** Brings the chart into view first: the sidebar scrolls, and real mouse events need on-screen coordinates. */
const reveal = () => page.evaluate(() => document.querySelector("#pt-materials .pt-tplot-svg")?.scrollIntoView({ block: "center" }));
const markers = async () => {
  await reveal();
  return page.evaluate(() =>
    [...document.querySelectorAll("#pt-materials .pt-tplot-point")].map((c) => {
      const box = c.getBoundingClientRect();
      return { index: Number(c.getAttribute("data-index")), x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })
  );
};
const readout = () => page.evaluate(() => document.querySelector("#pt-materials .pt-tplot-readout")?.textContent ?? "");
const svgBox = async () => {
  await reveal();
  return page.evaluate(() => {
  const r = document.querySelector("#pt-materials .pt-tplot-svg").getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
};
const increasing = (rows) => rows.every((r, i) => i === 0 || Number(r[0]) > Number(rows[i - 1][0]));

// --- add a temperature-dependent viscosity material to the Fluid case --------------------------------
await page.evaluate(() => {
  const sel = document.getElementById("pt-select");
  sel.value = "fluid";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(250);
await page.evaluate(() => {
  const host = document.getElementById("pt-materials");
  const what = host.querySelector(".pt-add-what");
  const opt = [...what.options].find((o) => /temperature_dependent/.test(o.value));
  if (!opt) throw new Error(`no temperature-dependent law among ${[...what.options].map((o) => o.value)}`);
  what.value = opt.value;
  what.dispatchEvent(new Event("change", { bubbles: true }));
  host.querySelector(".pt-add-row .edit-apply").click();
});
await page.waitForTimeout(250);

const title = await page.evaluate(() => [...document.querySelectorAll("#pt-materials .pt-tplot-title")].map((t) => t.textContent));
assert.deepEqual(title, ["TEMPERATURE", "DYNAMIC_VISCOSITY"], "the axes are titled with the table's variables");
assert.equal((await markers()).length, 2, "the default table has two drawable rows");
assert.deepEqual(await gridRows(), [["293.15", "1e-3"], ["373.15", "2.8e-4"]]);

// --- the Materials form offers the plot in the Plots workspace: one message to the host --------------------------------
await page.evaluate(() => {
  const link = [...document.querySelectorAll("#pt-materials .pt-preset-tools .pt-preset-link")].find((b) => /preview tables/.test(b.textContent));
  if (!link) throw new Error("no 'preview tables' link on the Materials form");
  link.click();
});
assert.equal(
  await page.evaluate(() => (window.SENT_MESSAGES ?? []).filter((m) => m.type === "ptPreviewTables").length),
  1,
  "the link posts ptPreviewTables"
);

// --- drag the first marker: grid, chart and ptState all follow ------------------------------------------
const before = await markers();
const box = await svgBox();
await page.mouse.move(before[0].x, before[0].y);
await page.mouse.down();
await page.mouse.move(before[0].x + 25, before[0].y + 20, { steps: 6 });
// While the button is down the axes are frozen, so the marker tracks the pointer exactly.
const underPointer = (await markers())[0];
assert.ok(
  Math.abs(underPointer.x - (before[0].x + 25)) < 4 && Math.abs(underPointer.y - (before[0].y + 20)) < 4,
  `the marker is under the pointer: ${JSON.stringify(underPointer)} (started ${JSON.stringify(before[0])})`
);
await page.mouse.up();
await page.waitForTimeout(100);
let rows = await gridRows();
assert.notDeepEqual(rows[0], ["293.15", "1e-3"], "the grid followed the drag");
assert.deepEqual(rows[1], ["373.15", "2.8e-4"], "the other row is untouched");
assert.ok(Number(rows[0][0]) > 293.15 && Number(rows[0][1]) < 1e-3, `moved right and down: ${rows[0]}`);
assert.equal(await lastTable(), rows.map((r) => r.join(",")).join("; "), "the saved case text equals the grid");
const after = await markers();
assert.equal(
  await page.evaluate(() => document.activeElement?.classList.contains("pt-tplot-point")),
  true,
  "focus stays on the dragged marker"
);

// --- dragging past the neighbour cannot reorder the input column --------------------------------------------
await page.mouse.move(after[0].x, after[0].y);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 4, after[0].y, { steps: 8 });
await page.mouse.up();
rows = await gridRows();
assert.ok(increasing(rows), `the input column stays increasing: ${JSON.stringify(rows)}`);
assert.ok(Number(rows[0][0]) < Number(rows[1][0]), "first stays below second");

// --- typing in the grid moves the marker ----------------------------------------------------------------------
await page.fill("#pt-materials .pt-table-grid > .pt-table-row:nth-of-type(2) input >> nth=1", "1e-5");
await page.waitForTimeout(100);
const [m0, m1] = await markers();
assert.ok(m1.y > m0.y, "an output far below the first one sits lower on the chart (the axes follow the data)");
assert.match(await lastTable(), /373\.15,1e-5$/);

// --- double-click adds a row in input order; a duplicate input is refused ------------------------------------------
const pts = await markers();
const between = { x: (pts[0].x + pts[1].x) / 2, y: Math.min(pts[0].y, pts[1].y) - 25 };
await page.mouse.dblclick(between.x, Math.max(between.y, box.y + 12));
await page.waitForTimeout(100);
rows = await gridRows();
assert.equal(rows.length, 3, `a row was added: ${JSON.stringify(rows)}`);
assert.ok(increasing(rows), "the new row is between its neighbours");
assert.equal((await markers()).length, 3);

// --- arrow keys nudge, Delete removes ---------------------------------------------------------------------------
await page.focus("#pt-materials .pt-tplot-point[data-index='1']");
const nudgedFrom = Number((await gridRows())[1][0]);
await page.keyboard.press("ArrowRight");
const nudgedTo = Number((await gridRows())[1][0]);
assert.ok(nudgedTo > nudgedFrom, `ArrowRight raised the input: ${nudgedFrom} -> ${nudgedTo}`);
await page.keyboard.press("Shift+ArrowRight");
assert.ok(Number((await gridRows())[1][0]) - nudgedTo > nudgedTo - nudgedFrom, "Shift takes a larger step");
await page.keyboard.press("ArrowUp");
assert.ok(/DYNAMIC_VISCOSITY = /.test(await readout()), "the readout names the values");
await page.keyboard.press("Delete");
await page.waitForTimeout(100);
assert.equal((await gridRows()).length, 2, "Delete removed the row");
assert.equal((await markers()).length, 2);
assert.equal((await lastTable()).split(";").length, 2, "the case text lost the row too");

// --- a malformed row stays editable but is not drawn; one valid point shows the hint --------------------------------
await page.fill("#pt-materials .pt-table-grid > .pt-table-row:nth-of-type(2) input >> nth=0", "hot");
await page.waitForTimeout(100);
assert.equal((await markers()).length, 0, "a malformed row is not drawn, and one point is not a curve");
assert.equal(await page.evaluate(() => document.querySelector("#pt-materials .pt-tplot-hint")?.hidden), false, "the hint is shown");
assert.equal((await gridRows()).length, 2, "the malformed row is still in the grid");
await page.fill("#pt-materials .pt-table-grid > .pt-table-row:nth-of-type(2) input >> nth=0", "400");
await page.waitForTimeout(100);
assert.equal((await markers()).length, 2, "fixing the row brings the curve back");

await page
  .locator("#pt-materials .pt-assign")
  .first()
  .screenshot({ path: process.env.TABLE_PLOT_SHOT ?? path.join(ROOT, "out", "material-table-plot.png") });
await browser.close();
assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
console.log("material table plot: OK");
