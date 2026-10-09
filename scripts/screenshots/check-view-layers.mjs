// Harness smoke check for View Layers (roadmap item 4): the sidebar section
// creates layers from blocks/parts, renames inline, reorders, toggles
// visibility, locks (blocking rename/delete/promote), recolours, deletes, and
// promotes through createSubModelPartFromSelection — every mutation posting a
// viewLayersSave that never touches the mesh history. Run like the other
// checks (after `npm run compile` + build-harness):
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-view-layers.mjs
import path from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright-core");

const harnessDir = path.resolve(process.cwd(), "out/screenshot-harness");

function chromiumOf() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const fs = require("node:fs");
  const base = path.join(process.env.HOME ?? "~", ".cache", "ms-playwright");
  for (const c of [
    "chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
    "chromium_headless_shell-1234/chrome-linux/headless_shell",
    "chromium-1243/chrome-linux64/chrome",
  ]) {
    const p = path.join(base, c);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const require = createRequire(import.meta.url);
const browser = await chromium.launch({
  executablePath: chromiumOf(),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

async function saves() {
  return page.evaluate(() => (window.SENT_MESSAGES ?? []).filter((m) => m.type === "viewLayersSave"));
}

async function lastApplyOp() {
  return page.evaluate(() => {
    const msgs = (window.SENT_MESSAGES ?? []).filter((m) => m.type === "applyOp");
    return msgs[msgs.length - 1];
  });
}

try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(800);

  // 1. The section exists with view-only copy, distinct from Layers.
  const hint = await page.$eval("#view-layers-hint", (el) => el.textContent ?? "");
  if (!hint.includes("View-only") || !hint.includes("never")) throw new Error(`view-layers hint missing view-only copy: "${hint}"`);
  const layersHeader = await page.$eval('.sb-section[data-section="layers"] .panel-title', (el) => el.textContent ?? "");
  const viewHeader = await page.$eval('.sb-section[data-section="view-layers"] .panel-title', (el) => el.textContent ?? "");
  if (layersHeader === viewHeader) throw new Error("Layers and View Layers sections share a title");
  console.log("ok: distinct View Layers section with view-only copy");

  // 2. Create from the first block.
  await page.fill("#vl-name", "Walls");
  await page.click('#view-layers details.vl-pick summary');
  const blockCb = await page.$(".vl-block-cb");
  if (!blockCb) throw new Error("no block checkbox to snapshot");
  await blockCb.check();
  await page.click('#view-layers .panel-btn:has-text("Add view layer")');
  await page.waitForTimeout(400);
  if ((await page.$$("#view-layers .vl-row")).length !== 1) throw new Error("create did not add a row");
  let posted = await saves();
  if (posted.length !== 1 || posted[0].layers.length !== 1 || posted[0].layers[0].name !== "Walls") {
    throw new Error("create did not post a viewLayersSave with the layer");
  }
  console.log("ok: create posts viewLayersSave");

  // 3. Rename inline via double-click.
  await page.dblclick("#view-layers .vl-name");
  await page.fill("#view-layers .vl-rename", "Side walls");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  if ((await page.$eval("#view-layers .vl-name", (el) => el.textContent ?? "")) !== "Side walls") {
    throw new Error("rename did not land");
  }
  posted = await saves();
  if (posted[posted.length - 1].layers[0].name !== "Side walls") throw new Error("rename did not save");
  console.log("ok: rename saves");

  // 4. Hide + recolour are view-only (no applyOp, but a save).
  const appliesBefore = await page.evaluate(() => (window.SENT_MESSAGES ?? []).filter((m) => m.type === "applyOp").length);
  await page.click('#view-layers .vl-row input[type="checkbox"]');
  await page.waitForTimeout(300);
  posted = await saves();
  if (posted[posted.length - 1].layers[0].visible !== false) throw new Error("hide did not save visible=false");
  await page.$eval("#view-layers .vl-swatch", (el) => { (el).value = "#00ff00"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(300);
  posted = await saves();
  if (posted[posted.length - 1].layers[0].color.join(",") === "1,0,0") throw new Error("recolour did not save");
  const appliesAfterViewOnly = await page.evaluate(() => (window.SENT_MESSAGES ?? []).filter((m) => m.type === "applyOp").length);
  if (appliesAfterViewOnly !== appliesBefore) throw new Error("show/hide/recolour posted an applyOp — view-only violation");
  console.log("ok: show/hide/recolour save without an applyOp");

  // 5. Lock blocks rename/delete/promote (buttons disabled).
  await page.click('#view-layers .vl-row .panel-icon-btn[title^="Lock"]');
  await page.waitForTimeout(300);
  const delDisabled = await page.$eval('#view-layers .vl-row .panel-icon-btn[title^="Delete view layer"]', (b) => b.disabled);
  const promoteDisabled = await page.$eval('#view-layers .vl-row .panel-btn:has-text("Promote")', (b) => b.disabled);
  if (!delDisabled || !promoteDisabled) throw new Error("lock did not disable delete/promote");
  console.log("ok: lock disables rename/delete/promote");

  // 6. Unlock, add a second layer, reorder.
  await page.click('#view-layers .vl-row .panel-icon-btn[title^="Unlock"]');
  await page.waitForTimeout(200);
  await page.fill("#vl-name", "Second");
  await page.click('#view-layers details.vl-pick summary');
  await page.check(".vl-block-cb");
  await page.click('#view-layers .panel-btn:has-text("Add view layer")');
  await page.waitForTimeout(300);
  if ((await page.$$("#view-layers .vl-row")).length !== 2) throw new Error("second create failed");
  await page.click('#view-layers .vl-row:nth-child(2) .panel-icon-btn[title$="up"]');
  await page.waitForTimeout(300);
  posted = await saves();
  if (posted[posted.length - 1].layers[0].name !== "Second") throw new Error("reorder did not move the row");
  console.log("ok: reorder saves the new order");

  // 7. Promote posts the existing undoable op with explicit ids.
  await page.click('#view-layers .vl-row:first-child .panel-btn:has-text("Promote")');
  await page.waitForTimeout(400);
  const op = await lastApplyOp();
  if (!op || op.op !== "createSubModelPartFromSelection" || !Array.isArray(op.elements)) {
    throw new Error("promote did not post createSubModelPartFromSelection with id arrays");
  }
  console.log("ok: promote posts createSubModelPartFromSelection with", op.elements.length, "elements");

  // 8. Delete removes the row and saves, never an applyOp.
  const appliesBeforeDelete = await page.evaluate(() => (window.SENT_MESSAGES ?? []).filter((m) => m.type === "applyOp").length);
  await page.click('#view-layers .vl-row:first-child .panel-icon-btn[title^="Delete view layer"]');
  await page.waitForTimeout(300);
  if ((await page.$$("#view-layers .vl-row")).length !== 1) throw new Error("delete did not remove the row");
  const appliesAfterDelete = await page.evaluate(() => (window.SENT_MESSAGES ?? []).filter((m) => m.type === "applyOp").length);
  if (appliesAfterDelete !== appliesBeforeDelete) throw new Error("delete posted an applyOp — members must survive");
  console.log("ok: delete saves without an applyOp");

  if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join(" | ")}`);
  console.log("PASS");
} catch (e) {
  console.error("FAIL:", e?.message ?? e);
  if (pageErrors.length) console.error("page errors:", pageErrors.join(" | "));
  process.exitCode = 1;
} finally {
  await browser.close();
}
