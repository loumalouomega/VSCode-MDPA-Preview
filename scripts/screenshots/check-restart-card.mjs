// Harness check for the Restart card (roadmap item 29): present for structural, absent for
// potentialFlow; saving posts `restart.save` in the case state; Choose run… posts `ptRestartPick`;
// a simulated `ptRestartPicked` reply fills the label and `restart.from`; Clear removes it.
// Run (after `npm run compile` + `node scripts/screenshots/build-harness.mjs`):
//   NODE_PATH=... CHROMIUM_PATH=... node scripts/screenshots/check-restart-card.mjs
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
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fail = (m) => {
  throw new Error(m);
};
const sent = (type) => page.evaluate((t) => (window.SENT_MESSAGES ?? []).filter((m) => m.type === t), type);
try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#pt-select", { timeout: 30000 });
  await page.selectOption("#pt-select", "potentialFlow");
  await page.waitForTimeout(400);
  if ((await page.$("#pt-restart .pt-card")) !== null) fail("Restart card shown for a problemtype without an adapter");
  await page.selectOption("#pt-select", "structural");
  await page.waitForTimeout(400);
  await page.click("#pt-restart .edit-form-title");
  await page.click("#pt-restart .pt-field input[type=checkbox]");
  await page.waitForTimeout(700);
  let st = (await sent("ptState")).pop()?.state;
  if (!st?.restart?.save || st.restart.save.frequency <= 0) fail("restart.save not posted: " + JSON.stringify(st?.restart));
  await page.click("#pt-restart-choose");
  if ((await sent("ptRestartPick")).length !== 1) fail("Choose run… did not post ptRestartPick");
  await page.evaluate(() => window.postMessage({ type: "ptRestartPicked", runDirectory: "runs/a", label: 12 }, "*"));
  await page.waitForTimeout(700);
  const label = await page.$eval("#pt-restart-from-label", (e) => e.textContent);
  if (!/runs\/a/.test(label ?? "") || !/12/.test(label ?? "")) fail("label not updated: " + label);
  st = (await sent("ptState")).pop()?.state;
  if (st?.restart?.from?.runDirectory !== "runs/a" || st.restart.from.label !== 12) fail("from not posted: " + JSON.stringify(st?.restart));
  await page.click("#pt-restart-clear");
  await page.waitForTimeout(700);
  st = (await sent("ptState")).pop()?.state;
  if (st?.restart?.from) fail("Clear left restart.from");
  if (errors.length) fail("page errors: " + errors.join("; "));
  console.log("ok: Restart card saves, picks and clears");
} finally {
  await browser.close();
}
