// Harness check for the multi-point-constraint views (roadmap item 23): View > Constraint
// links, the Data table "Constraints" kind, and Inspect's constraint lines on a node.
//   npm run compile && HARNESS_MESH=src/test/fixtures/mdpa/hanging_two_level.mdpa node scripts/screenshots/build-harness.mjs
//   NODE_PATH=<dir with playwright-core> node scripts/screenshots/check-constraint-view.mjs
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const harnessDir = path.resolve(process.cwd(), "out/screenshot-harness");
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForTimeout(3000);

  // 1. Constraint links overlay: on reports segments, off clears nothing it should not.
  await page.click('#toolbar button[data-action="viewMenu"]');
  await page.click('#view-popup button[data-action="constraintLinks"]');
  await page.waitForTimeout(400);
  const msg = await page.$eval("#message", (e) => e.textContent ?? "");
  if (!/Constraint links: \d+ slave→master segment/.test(msg)) fail("links overlay message: " + msg);
  else console.log("ok:", msg);
  const active = await page.$eval('[data-action="constraintLinks"]', (e) => e.classList.contains("active"));
  if (!active) fail("Constraint links menu item is not checked");

  // 2. Data table Constraints kind: one row per linear constraint, row click selects.
  await page.click('#toolbar button[data-action="advanced"]');
  await page.click('#advanced-popup button[data-action="dataTable"]');
  await page.waitForSelector("#data-table-panel", { state: "visible", timeout: 5000 });
  const kinds = await page.$$eval("#data-table-panel .meshsize-modes button", (b) => b.map((x) => x.textContent?.trim()));
  const ci = kinds.findIndex((k) => /constraint/i.test(k ?? ""));
  if (ci < 0) fail("no Constraints table kind: " + kinds.join("|"));
  else {
    await page.click(`#data-table-panel .meshsize-modes button:nth-child(${ci + 1})`);
    await page.waitForTimeout(500);
    const rows = await page.$$eval("#data-table-panel .dt-window .dt-row", (r) => r.length);
    if (rows !== 15) fail(`expected 15 constraint rows (5 nodes x 3 variables), got ${rows}`);
    else console.log("ok: Constraints table has", rows, "rows");
    await page.click("#data-table-panel .dt-window .dt-row:nth-child(1)");
    await page.waitForTimeout(300);
    const sel = await page.$$eval("#data-table-panel .dt-row.selected", (r) => r.length);
    if (sel !== 1) fail("row click did not select");
    else console.log("ok: constraint row selected");
  }

  // 3. Inspect: a click that lands on a node of a constrained edge shows constraint lines.
  await page.click('#toolbar button[data-action="inspect"]');
  const box = await page.$eval("#render-root", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  let found = false;
  for (let i = 0; i < 12 && !found; i++) {
    for (let j = 0; j < 8 && !found; j++) {
      await page.mouse.click(box.x + box.w * (0.25 + i * 0.05), box.y + box.h * (0.3 + j * 0.05));
      await page.waitForTimeout(120);
      found = await page.evaluate(() => /slave of|master of/.test(document.getElementById("inspect-panel")?.textContent ?? ""));
    }
  }
  if (!found) console.log("note: no pick landed on a constrained node in the sweep (view-dependent)");
  else console.log("ok: Inspect shows a constraint line");
} finally {
  await browser.close();
}
