// Chromium smoke check for the Inspect panel's per-field Monitor button
// (roadmap item 8). webview/ is untestable under node:test, so this drives the
// real bundle in the harness: pick a node in Inspect,
// click a field's Monitor button and assert the exact message posted.
//
// Setup as in capture-time-series.mjs:
//   npm run compile && npm run build:tests
//   HARNESS_MESH=example/VTK/Main_0_2.vtk node scripts/screenshots/build-harness.mjs
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-save-monitor.mjs
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { discoverSeriesSteps } = require(path.join(ROOT, "out", "parser", "fieldSeriesScan"));

function resolvePlaywright() {
  for (const candidate of ["playwright-core", path.join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try { return require(candidate); } catch { /* next */ }
  }
  throw new Error("playwright-core not found — install it and pass NODE_PATH (see the header comment).");
}

const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

const { steps } = await discoverSeriesSteps(path.join(ROOT, "example", "VTK", "Main_0_2.vtk"));
const { chromium } = resolvePlaywright();
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(4000);
await page.evaluate((labels) => window.postMessage({ type: "vtkGroup", fileName: "Main_0_2.vtk", group: { modelPartName: "Main", steps: labels, subParts: [], ranks: [0] } }, "*"), steps.map((s) => s.label));
await page.waitForTimeout(400);
await page.click('#toolbar button[data-action="inspect"]');
const box = await page.$eval("#render-root", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.4], [0.55, 0.6], [0.4, 0.55]]) {
  await page.mouse.click(box.x + box.w * fx, box.y + box.h * fy);
  await page.waitForTimeout(500);
  if (await page.evaluate(() => document.querySelectorAll("#inspect-panel .inspect-section").length)) break;
}
const nodeId = await page.evaluate(() => {
  const s = [...document.querySelectorAll("#inspect-panel .inspect-section")].map((e) => e.textContent ?? "").find((t) => t.startsWith("Nearest node"));
  return s ? Number(s.replace(/\D+/g, "")) : undefined;
});
if (!nodeId) { fail("the pick did not resolve to a node"); await browser.close(); process.exit(); }
await page.evaluate(() => { window.SENT_MESSAGES.length = 0; });
const labels = await page.evaluate(() => [...document.querySelectorAll("#inspect-panel .inspect-monitor-btn")].map((b) => b.getAttribute("aria-label")));
const pressure = labels.findIndex((l) => /PRESSURE/.test(l ?? ""));
if (pressure < 0) fail(`no Monitor button for PRESSURE among ${JSON.stringify(labels)}`);
await page.evaluate((i) => document.querySelectorAll("#inspect-panel .inspect-monitor-btn")[i]?.click(), Math.max(pressure, 0));
await page.waitForTimeout(200);
const sent = await page.evaluate(() => window.SENT_MESSAGES.filter((m) => m.type === "saveMonitor"));
if (sent.length !== 1) fail(`expected one saveMonitor message, got ${sent.length}`);
else {
  const m = sent[0];
  // The first Monitor button for PRESSURE may belong to the element or the node section.
  if (!["Nodal", "Elemental"].includes(m.kind) || !Number.isInteger(m.entityId) || m.variable !== "PRESSURE") fail(`wrong payload ${JSON.stringify(m)} (picked node ${nodeId})`);
  else console.log(`OK: saveMonitor { kind: ${m.kind}, entityId: ${m.entityId}, variable: ${m.variable} }`);
}
await browser.close();
