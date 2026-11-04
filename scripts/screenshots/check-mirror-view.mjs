// Harness check for the view-only Mirror (roadmap item 24): `mirror` on doubles the displayed
// mesh (stats change, `_mirror` layers appear), posts no applyOp/save, and `mirror off` restores
// the original scene.
// Run (after `npm run compile` + `node scripts/screenshots/build-harness.mjs`):
//   NODE_PATH=/tmp/pw/node_modules CHROMIUM_PATH=... node scripts/screenshots/check-mirror-view.mjs
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
  await run("mirror axis=x side=min");
  const on = { stats: await stats(), outline: await outline() };
  if (on.stats === before.stats) fail("stats did not change after mirror on");
  if (!/_mirror/.test(on.outline)) fail("no _mirror layers in the outline");
  const sent = await page.evaluate(() => window.SENT_MESSAGES ?? []);
  const bad = sent.filter((m) => /^(applyOp|applyBatch|menuSave|menuExport)/.test(m.type));
  if (bad.length) fail("mirror posted an edit/save message: " + JSON.stringify(bad));
  console.log("ok: mirror on doubles the scene and posts no edit");
  await run("mirror off");
  const off = { stats: await stats(), outline: await outline() };
  if (off.stats !== before.stats || /_mirror/.test(off.outline)) fail("mirror off did not restore the scene: " + JSON.stringify({b: before.stats.slice(0,200), o: off.stats.slice(0,200), mir: /_mirror/.test(off.outline), echo: await page.$eval("#cmd-echo", (e) => e.textContent)}));
  console.log("ok: mirror off restores the original scene");
  if (pageErrors.length) fail("page errors: " + pageErrors.join("; "));
} finally {
  await browser.close();
}
