// Harness check for the ALE mesh quality panel (roadmap item 46): the panel opens by command,
// Scan posts `aleSeries`, a simulated `aleSeriesResult` fills the chart and table, a row click
// and "Go to worst frame" post `vtkRequestFrame`, "Select worst elements" creates a selection set
// from the inverted ids of the worst frame, and nothing edits or saves.
// Run (after `npm run compile` + `node scripts/screenshots/build-harness.mjs`):
//   NODE_PATH=... CHROMIUM_PATH=... node scripts/screenshots/check-ale-panel.mjs
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const harnessDir = path.resolve(process.cwd(), "out/screenshot-harness");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const fail = (m) => { throw new Error(m); };
const sent = () => page.evaluate(() => window.SENT_MESSAGES ?? []);
try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.SENT_MESSAGES = []; });
  await page.fill("#cmd-input", "aleQuality");
  await page.press("#cmd-input", "Enter");
  await page.waitForSelector("#ale-panel", { state: "visible", timeout: 5000 });
  await page.click("#ale-panel .meshsize-actions button:first-child");
  if (!(await sent()).some((m) => m.type === "aleSeries")) fail("Scan did not post aleSeries");
  const frames = [
    { label: "0", frameIndex: 0, elements: 4, inverted: 0, minMeasureRatio: 1, minShapeRatio: 1, worstElementId: 1 },
    { label: "1", frameIndex: 1, elements: 4, inverted: 0, minMeasureRatio: 0.8, minShapeRatio: 0.7, worstElementId: 2 },
    { label: "2", frameIndex: 2, elements: 4, inverted: 1, invertedIds: [3], minMeasureRatio: -0.1, minShapeRatio: -0.2, worstElementId: 3 },
  ];
  await page.evaluate((f) => window.postMessage({ type: "aleSeriesResult", series: { variable: "MESH_DISPLACEMENT", frames: f, worstFrame: 2, referenceLabel: "0", cancelled: false } }, "*"), frames);
  await page.waitForSelector("#ale-panel table tr:nth-child(4)", { timeout: 5000 });
  const text = await page.$eval("#ale-panel", (el) => el.textContent ?? "");
  if (!/frame\(s\) with inverted/.test(text) || !/★/.test(text)) fail("summary or worst-frame mark missing: " + text.slice(0, 300));
  if (!(await page.$("#ale-panel canvas"))) fail("no chart canvas");
  await page.evaluate(() => { window.SENT_MESSAGES = []; });
  await page.click("#ale-panel table tr:nth-child(2)");
  let m = (await sent()).find((x) => x.type === "vtkRequestFrame");
  if (!m || m.frameIndex !== 0) fail("row click did not request frame 0: " + JSON.stringify(m));
  await page.evaluate(() => { window.SENT_MESSAGES = []; });
  await page.click("#ale-panel .meshsize-actions button:nth-child(2)");
  m = (await sent()).find((x) => x.type === "vtkRequestFrame");
  if (!m || m.frameIndex !== 2) fail("Go to worst frame did not request frame 2: " + JSON.stringify(m));
  await page.click("#ale-panel .meshsize-actions button:nth-child(3)");
  await page.waitForSelector("#selection-panel", { state: "visible", timeout: 5000 });
  const sel = await page.$eval("#selection-panel", (el) => el.textContent ?? "");
  if (!/ALE worst/.test(sel)) fail("no ALE worst selection set: " + sel.slice(0, 300));
  const bad = (await sent()).filter((x) => /^(applyOp|applyBatch|menuSave|menuExport)/.test(x.type) && x.type !== "menuExportAnalysis");
  if (bad.length) fail("posted an edit/save message: " + JSON.stringify(bad));
  console.log("ok: ALE panel scans, draws, navigates and selects without editing");
  if (pageErrors.length) fail("page errors: " + pageErrors.join("; "));
} finally {
  await browser.close();
}
