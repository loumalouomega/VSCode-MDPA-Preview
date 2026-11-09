// Harness check for the Parallel card (roadmap item 32): present for structural, absent for
// potentialFlow; ticking MPI posts `parallel: {type:"mpi"}`; partition-in-memory is kept; unticking removes it.
// Run (after `npm run compile` + `node scripts/screenshots/build-harness.mjs`):
//   NODE_PATH=... CHROMIUM_PATH=... node scripts/screenshots/check-parallel-card.mjs
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
const last = async () => (await page.evaluate(() => (window.SENT_MESSAGES ?? []).filter((m) => m.type === "ptState").pop()))?.state;
try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#pt-select", { timeout: 30000 });
  await page.selectOption("#pt-select", "potentialFlow");
  await page.waitForTimeout(400);
  if ((await page.$("#pt-parallel .pt-card")) !== null) fail("Parallel card shown for an unsupported problemtype");
  await page.selectOption("#pt-select", "structural");
  await page.waitForTimeout(400);
  await page.click("#pt-parallel .edit-form-title");
  await page.click("#pt-parallel .pt-field input[type=checkbox]");
  await page.waitForTimeout(700);
  let st = await last();
  if (st?.parallel?.type !== "mpi") fail("parallel not posted: " + JSON.stringify(st?.parallel));
  await page.click("#pt-parallel .pt-field:nth-of-type(2) input[type=checkbox]");
  await page.waitForTimeout(700);
  st = await last();
  if (st?.parallel?.partitionInMemory !== true) fail("partitionInMemory not posted: " + JSON.stringify(st?.parallel));
  await page.click("#pt-parallel .pt-field:first-of-type input[type=checkbox]");
  await page.waitForTimeout(700);
  st = await last();
  if (st?.parallel) fail("unticking left parallel set");
  if (errors.length) fail("page errors: " + errors.join("; "));
  console.log("ok: Parallel card toggles the MPI variant");
} finally {
  await browser.close();
}
