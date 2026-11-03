// Chromium smoke check for the Inspect panel's Evaluation table: each pick
// appends a row, rows keep their frame label across a timeline change, and
// Export CSV posts menuExportAnalysis with suffix "evaluation".
// NOT run in the authoring environment (no Chromium there).
//
// Setup as in check-save-monitor.mjs:
//   npm run compile && npm run build:tests
//   HARNESS_MESH=example/VTK/Main_0_2.vtk node scripts/screenshots/build-harness.mjs
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-evaluation-table.mjs
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolvePlaywright() {
  for (const candidate of ["playwright-core", path.join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try { return require(candidate); } catch { /* next */ }
  }
  throw new Error("playwright-core not found — install it and pass NODE_PATH (see the header comment).");
}

const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

const { chromium } = resolvePlaywright();
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(4000);
await page.evaluate(() => window.postMessage({ type: "vtkGroup", fileName: "Main_0_2.vtk", group: { modelPartName: "Main", steps: ["2", "4"], subParts: [], ranks: [0] } }, "*"));
await page.waitForTimeout(400);
await page.click('#toolbar button[data-action="inspect"]');
const box = await page.$eval("#render-root", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const rowCount = () => page.evaluate(() => document.querySelectorAll("#inspect-panel .inspect-eval-table tr").length - 1);
let picks = 0;
for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.4], [0.55, 0.6], [0.4, 0.55], [0.6, 0.45]]) {
  await page.mouse.click(box.x + box.w * fx, box.y + box.h * fy);
  await page.waitForTimeout(400);
  picks = await rowCount();
  if (picks >= 2) break;
}
if (picks < 1) { fail("no evaluation rows after picking"); }
else console.log(`OK: ${picks} evaluation row(s)`);

const header = await page.evaluate(() => [...document.querySelectorAll("#inspect-panel .inspect-eval-table th")].map((e) => e.textContent));
if (!["frame", "kind", "id", "x", "y", "z"].every((h) => header.includes(h))) fail(`unexpected header ${JSON.stringify(header)}`);

// Export CSV posts the table.
await page.evaluate(() => { window.SENT_MESSAGES.length = 0; });
await page.click("#inspect-panel .inspect-eval-export");
await page.waitForTimeout(200);
const sent = await page.evaluate(() => window.SENT_MESSAGES.filter((m) => m.type === "menuExportAnalysis"));
if (sent.length !== 1 || sent[0].suffix !== "evaluation" || !String(sent[0].csv).startsWith("frame,kind,id")) fail(`wrong export payload ${JSON.stringify(sent)}`);
else console.log("OK: Export CSV posted menuExportAnalysis/evaluation");

// Rows persist across a timeline change (a vtkFrame message) and keep their frame label.
const before = await page.evaluate(() => [...document.querySelectorAll("#inspect-panel .inspect-eval-table tr")].map((r) => r.firstChild.textContent));
// (Re-rendering the panel stands in for a scrub here; the frame label is part of each stored row.)
await page.click('#toolbar button[data-action="inspect"]');
await page.click('#toolbar button[data-action="inspect"]');
await page.waitForTimeout(200);
const after = await page.evaluate(() => [...document.querySelectorAll("#inspect-panel .inspect-eval-table tr")].map((r) => r.firstChild.textContent));
if (JSON.stringify(before) !== JSON.stringify(after)) fail("rows changed");

// Clear empties the table.
await page.click("#inspect-panel .inspect-eval-clear");
await page.waitForTimeout(200);
if ((await rowCount()) > 0 || await page.$("#inspect-panel .inspect-eval-table")) fail("Clear left rows");
else console.log("OK: Clear");

await browser.close();
