// Harness smoke check for the reopenable view state (roadmap item 3): layout,
// field choice, layer visibility and camera bookmarks are posted to the sidecar
// as a `view`, a reopened `viewLayers` message restores them without echoing a
// save, vanished fields/layers degrade to defaults with a toast, and none of it
// posts an edit. Run after `npm run compile`, `npm run build:tests` and:
//   HARNESS_SCENE=panefields node scripts/screenshots/build-harness.mjs
//   NODE_PATH=<dir with playwright-core>/node_modules node scripts/screenshots/check-view-state.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const harnessDir = path.resolve(process.cwd(), "out/screenshot-harness");

function chromiumOf() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const base of [path.join(process.env.HOME ?? "~", ".cache", "ms-playwright"), "/opt/pw-browsers"]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

const browser = await chromium.launch({
  executablePath: chromiumOf(),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const fail = (m) => { throw new Error(m); };

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(800);
  return page;
}
const sent = (page, type) => page.evaluate((t) => (window.SENT_MESSAGES ?? []).filter((m) => m.type === t), type);
const hostSends = (page, msg) => page.evaluate((m) => window.postMessage(m, "*"), msg);

try {
  // ---- 1. Author a view -------------------------------------------------
  const a = await openPage();
  // Before the host's first `viewLayers` reply nothing may be saved.
  await a.click('#toolbar button[data-action="viewMenu"]');
  await a.click('#view-popup [data-action="layout:1x2"]');
  await a.keyboard.press("Escape");
  await a.waitForTimeout(800);
  if ((await sent(a, "viewLayersSave")).length) fail("saved before the sidecar was loaded");
  await a.click('#toolbar button[data-action="viewMenu"]');
  await a.click('#view-popup [data-action="layout:1x1"]');
  await a.keyboard.press("Escape");
  await a.waitForTimeout(500);

  // The host answers with no sidecar: opening a mesh must not write one.
  await hostSends(a, { type: "viewLayers", layers: [] });
  await a.waitForTimeout(900);
  if ((await sent(a, "viewLayersSave")).length) fail("opening a mesh wrote a sidecar");

  await a.click('#toolbar button[data-action="viewMenu"]');
  await a.click('#view-popup [data-action="layout:1x2"]');
  await a.keyboard.press("Escape");
  await a.waitForTimeout(300);
  await a.click('#toolbar button[data-action="field"]');
  await a.waitForTimeout(400);
  const variable = await a.$eval("#field-panel select", (sel) => {
    const o = [...sel.options].find((x) => x.textContent.startsWith("PRESSURE ("));
    return o?.value ?? "";
  });
  if (!variable) fail("no PRESSURE option in the field panel");
  await a.selectOption("#field-panel select", variable);
  await a.waitForTimeout(400);
  // Untick the first block layer in the outline.
  const hiddenLayer = await a.evaluate(() => {
    const row = document.querySelector("#outline .outline-row input[type=checkbox]:checked")?.closest(".outline-row");
    row?.querySelector("input[type=checkbox]")?.click();
    return row?.querySelector(".outline-label")?.textContent ?? "";
  });
  // Save a camera bookmark.
  await a.click('#toolbar button[data-action="advanced"]');
  await a.click('#advanced-popup [data-action="bookmarks"]');
  await a.fill("#bookmarks-panel input", "front-check");
  await a.click("#bookmarks-panel .field-range-reset");
  await a.waitForTimeout(900);

  // Open an analysis panel: its open state joins the same save, never an edit.
  await a.click('#toolbar button[data-action="quality"]');
  await a.waitForTimeout(900);

  if ((await sent(a, "applyOp")).length) fail("view changes posted an applyOp");
  const saves = await sent(a, "viewLayersSave");
  if (!saves.length) fail("no viewLayersSave after user changes");
  const last = saves.at(-1);
  if (last.layers !== undefined) fail("a view save must not carry layers (the host keeps them)");
  if (!last.view?.panels?.includes("quality")) fail(`open panels not saved: ${JSON.stringify(last.view?.panels)}`);
  const v = last.view;
  if (v.paneLayout !== "1x2") fail(`paneLayout not saved: ${JSON.stringify(v.paneLayout)}`);
  if (v.panes.length !== 2) fail(`expected 2 saved panes, got ${v.panes.length}`);
  if (v.panes[0].field.selectedKey !== variable) fail(`field not saved: ${v.panes[0].field.selectedKey}`);
  if (v.fieldPanel !== true) fail("field panel open state not saved");
  if (!v.bookmarks.some((b) => b.name === "front-check")) fail("bookmark not saved");
  if (!Object.values(v.layerVisibility).includes(false)) fail(`no hidden layer saved (unticked "${hiddenLayer}")`);
  if (!v.panes[0].camera) fail("pane camera not saved");
  await a.close();

  // ---- 2. Reopen with the saved view ------------------------------------
  const b = await openPage();
  await hostSends(b, { type: "viewLayers", layers: [], view: v });
  await b.waitForTimeout(1200);
  if ((await b.$$("#pane-chrome .pane-box")).length !== 2) fail("layout not restored");
  if (!(await b.$eval("#field-panel", (el) => getComputedStyle(el).display !== "none"))) fail("field panel not reopened");
  if (!(await b.$eval("#quality-panel", (el) => getComputedStyle(el).display !== "none"))) fail("quality panel not reopened");
  if ((await b.$eval("#field-panel select", (el) => el.value)) !== variable) fail("restored field differs");
  const unchecked = await b.evaluate(() => [...document.querySelectorAll("#outline .outline-row input[type=checkbox]")].filter((c) => !c.checked).length);
  if (unchecked < 1) fail("layer visibility not restored");
  // Restoring is not an edit and must not echo a save.
  if ((await sent(b, "viewLayersSave")).length) fail("restore echoed a viewLayersSave");
  if ((await sent(b, "applyOp")).length) fail("restore posted an applyOp");
  // The restored bookmark is listed.
  await b.click('#toolbar button[data-action="advanced"]');
  await b.click('#advanced-popup [data-action="bookmarks"]');
  if (!(await b.$eval("#bookmarks-panel", (el) => el.textContent.includes("front-check")))) fail("bookmark not restored");
  // A later change saves again (the baseline was the restored state).
  await b.click('#toolbar button[data-action="viewMenu"]');
  await b.click('#view-popup [data-action="layout:2x2"]');
  await b.keyboard.press("Escape");
  await b.waitForTimeout(900);
  const after = await sent(b, "viewLayersSave");
  if (after.at(-1)?.view?.paneLayout !== "2x2") fail("a change after the restore was not saved");
  if (b.errors.length) fail(`page errors: ${b.errors.join("; ")}`);
  await b.close();

  // ---- 3. A view naming things the mesh does not have -------------------
  const c = await openPage();
  const stale = JSON.parse(JSON.stringify(v));
  stale.panes[0].field.selectedKey = "Nodal:NO_SUCH_FIELD";
  stale.layerVisibility = { "block:Elements:NoSuchBlock": false };
  stale.layerOpacity = {};
  await hostSends(c, { type: "viewLayers", layers: [], view: stale });
  await c.waitForTimeout(700);
  const toastText = await c.$eval("#message", (el) => el.textContent);
  const selected = await c.$eval("#field-panel select", (el) => el.value);
  if (!/not in this mesh/.test(toastText)) fail(`no report of the vanished field: ${JSON.stringify(toastText)}`);
  if (!/no longer match a layer/.test(toastText)) fail(`no report of the vanished layer: ${JSON.stringify(toastText)}`);
  if (selected === "Nodal:NO_SUCH_FIELD" || !selected) fail(`a vanished field was applied (selected "${selected}")`);
  if (c.errors.length) fail(`page errors: ${c.errors.join("; ")}`);
  await c.close();

  console.log("check-view-state: OK");
} catch (e) {
  console.error("check-view-state FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
