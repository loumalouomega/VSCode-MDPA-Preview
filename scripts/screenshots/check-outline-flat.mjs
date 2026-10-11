// Harness smoke check for the View ▸ "Flat SubModelPart list" toggle: nested
// SubModelParts collapse into one flat list labelled with full paths, the
// toggle is view-only (no applyOp, no layer visibility change), turning it
// off restores the tree with the user's checkbox state intact, and the
// setting is posted on viewLayersSave. Run after `npm run compile`,
// `npm run build:tests` and build-harness, with the nested fixture:
//   HARNESS_MESH=src/test/fixtures/mdpa/nested_parts.mdpa node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-outline-flat.mjs
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
      for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
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
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const smpLabels = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("#outline .outline-row")];
    const start = rows.findIndex((r) => r.classList.contains("outline-section") && r.textContent?.includes("SubModelParts"));
    if (start < 0) return [];
    const out = [];
    for (let i = start + 1; i < rows.length; i++) {
      if (rows[i].classList.contains("outline-section")) break;
      out.push({
        label: rows[i].querySelector(".outline-label")?.textContent ?? "",
        pad: rows[i].style.paddingLeft,
        checked: rows[i].querySelector('input[type="checkbox"]')?.checked ?? null,
      });
    }
    return out;
  });
const sent = (type) => page.evaluate((t) => (window.SENT_MESSAGES ?? []).filter((m) => m.type === t), type);
const fail = (m) => { throw new Error(m); };

try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(800);

  // 1. Nested by default.
  const tree = await smpLabels();
  const names = tree.map((r) => r.label);
  if (JSON.stringify(names) !== JSON.stringify(["Domain", "Left", "Inlet", "Right", "Inlet", "Wall"])) fail(`default tree wrong: ${JSON.stringify(names)}`);
  if (new Set(tree.map((r) => r.pad)).size < 3) fail("default tree is not indented to three levels");

  // 2. The user ticks a nested part's checkbox before flattening.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#outline .outline-row")];
    const left = rows.find((r) => r.querySelector(".outline-label")?.textContent === "Left");
    left.querySelector('input[type="checkbox"]').click();
  });
  await page.waitForTimeout(200);
  const before = await smpLabels();
  if (before.find((r) => r.label === "Left")?.checked !== true) fail("could not tick Left");

  // 3. Toggle on via the View menu.
  await page.click('#toolbar button[data-action="viewMenu"]');
  const item = '#view-popup [data-action="flatParts"]';
  await page.click(item);
  await page.waitForTimeout(200);
  const flat = await smpLabels();
  const flatNames = flat.map((r) => r.label);
  const expectFlat = ["Domain", "Domain/Left", "Domain/Left/Inlet", "Domain/Right", "Domain/Right/Inlet", "Wall"];
  if (JSON.stringify(flatNames) !== JSON.stringify(expectFlat)) fail(`flat list wrong: ${JSON.stringify(flatNames)}`);
  if (new Set(flat.map((r) => r.pad)).size !== 1) fail("flat rows are not all at one indent");
  if (new Set(flatNames).size !== flatNames.length) fail("flat labels are ambiguous");
  if (flat.find((r) => r.label === "Domain/Left")?.checked !== true) fail("the ticked layer lost its checkbox state when flattening");
  if (!(await page.$eval(item, (el) => el.classList.contains("active")))) fail("menu item is not marked active");

  // 4. View-only: no edit was posted; the setting went to the sidecar.
  if ((await sent("applyOp")).length) fail("flattening posted an applyOp");
  const saves = await sent("viewLayersSave");
  if (!saves.length || saves.filter((m) => m.outline !== undefined).at(-1)?.outline?.flattenSubModelParts !== true) fail(`viewLayersSave did not carry outline: ${JSON.stringify(saves.at(-1))}`);

  // 5. A host `viewLayers` without an outline key leaves the setting alone.
  await page.evaluate(() => window.postMessage({ type: "viewLayers", layers: [] }, "*"));
  await page.waitForTimeout(200);
  if ((await smpLabels()).length !== 6 || (await smpLabels())[1].label !== "Domain/Left") fail("an outline-less viewLayers reset the flat setting");

  // 6. The host restoring outline:false (a reopened sidecar) un-flattens.
  await page.evaluate(() => window.postMessage({ type: "viewLayers", layers: [], outline: { flattenSubModelParts: false } }, "*"));
  await page.waitForTimeout(200);
  const restored = await smpLabels();
  if (JSON.stringify(restored.map((r) => r.label)) !== JSON.stringify(names)) fail(`tree not restored: ${JSON.stringify(restored)}`);
  if (restored.find((r) => r.label === "Left")?.checked !== true) fail("checkbox state lost on restoring the tree");
  if (await page.$eval(item, (el) => el.classList.contains("active"))) fail("menu item still active after restore");

  // 7. Toggle off through the menu as well.
  await page.click(item);
  await page.click(item);
  await page.waitForTimeout(200);
  // A view-only save (no `outline` key; the view sidecar key rides its own debounced message) may land last.
  const last = (await sent("viewLayersSave")).filter((m) => m.outline !== undefined).at(-1);
  if (last.outline?.flattenSubModelParts !== false) fail("off-toggle did not post outline:false");

  if (pageErrors.length) fail(`page errors: ${pageErrors.join("; ")}`);
  console.log("check-outline-flat: OK");
} catch (e) {
  console.error("check-outline-flat FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
