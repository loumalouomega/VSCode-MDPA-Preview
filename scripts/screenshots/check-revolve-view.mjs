// Harness check for the view-only Revolve (roadmap item 24): `revolve` on doubles the displayed
// mesh (stats change, `_revolve` layers appear), posts no applyOp/save, and `revolve off` restores
// the original scene.
// Run (after `npm run compile` + `node scripts/screenshots/build-harness.mjs`):
//   NODE_PATH=/tmp/pw/node_modules CHROMIUM_PATH=... node scripts/screenshots/check-revolve-view.mjs
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
const stats = () => page.$eval("#stats", (el) => el.textContent ?? "");
const outline = () => page.$eval("#outline", (el) => el.textContent ?? "");
const run = async (t) => { await page.fill("#cmd-input", t); await page.press("#cmd-input", "Enter"); await page.waitForTimeout(1500); };
try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(800);
  const before = { stats: await stats(), outline: await outline() };
  await page.evaluate(() => { window.SENT_MESSAGES = []; });
  await run("revolve axis=y sweep=360 layers=12");
  const on = { stats: await stats(), outline: await outline() };
  if (on.stats === before.stats) fail("stats did not change after revolve on");
  if (!/_revolve/.test(on.outline)) fail("no _revolve layers in the outline");
  const sent = await page.evaluate(() => window.SENT_MESSAGES ?? []);
  const bad = sent.filter((m) => /^(applyOp|applyBatch|menuSave|menuExport)/.test(m.type));
  if (bad.length) fail("revolve posted an edit/save message: " + JSON.stringify(bad));
  console.log("ok: revolve on doubles the scene and posts no edit");
  await run("revolve off");
  const off = { stats: await stats(), outline: await outline() };
  if (off.stats !== before.stats || /_revolve/.test(off.outline)) fail("revolve off did not restore the scene: " + JSON.stringify({b: before.stats.slice(0,200), o: off.stats.slice(0,200), mir: /_revolve/.test(off.outline), echo: await page.$eval("#cmd-echo", (e) => e.textContent)}));
  console.log("ok: revolve off restores the original scene");
  if (pageErrors.length) fail("page errors: " + pageErrors.join("; "));
} finally {
  await browser.close();
}
