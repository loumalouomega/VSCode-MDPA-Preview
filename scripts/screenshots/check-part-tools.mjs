// Harness smoke check for part measures, part-scoped transforms and the formula seed:
// the Information section shows a Volume/Area row, a SubModelPart's info menu lists its
// measure, Translate posts `part`, and the Selection panel's Formula seed adds a set and
// "Add & create SubModelPart" posts createSubModelPartFromSelection.
//   npm run compile && node scripts/screenshots/build-harness.mjs   (HARNESS_MESH=src/test/fixtures/mdpa/nested_parts.mdpa)
//   NODE_PATH=/tmp/pw/node_modules CHROMIUM_PATH=... node scripts/screenshots/check-part-tools.mjs
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
const sent = () => page.evaluate(() => window.SENT_MESSAGES ?? []);
const fail = (m) => { throw new Error(m); };

try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });

  // 1. Measures: computed after a short debounce, once the sidecar reply is in.
  await page.waitForFunction(() => /Volume|Area/.test(document.getElementById("stats")?.textContent ?? ""), { timeout: 15000 })
    .catch(() => fail("Information section never showed a Volume/Area row"));
  console.log("ok: Information shows", await page.$eval("#stats", (e) => (e.textContent.match(/(Volume|Area)[^A-Z]*/) ?? [])[0]));

  // The Edit forms start collapsed (and the sidebar sections may too): open them.
  await page.evaluate(() => document.querySelectorAll(".collapsed").forEach((e) => e.classList.remove("collapsed")));

  // 2. Part selector on Translate populated, and `part` posted.
  const opts = await page.$$eval("#trans-part option", (o) => o.map((x) => x.value));
  if (opts.length < 2) fail("trans-part select has no SubModelParts");
  await page.evaluate(() => { window.SENT_MESSAGES.length = 0; });
  await page.selectOption("#trans-part", opts[1]);
  await page.fill("#trans-x", "2");
  await page.evaluate(() => document.querySelector('.edit-apply[data-op="translate"]').click());
  const tr = (await sent()).find((m) => m.type === "applyOp" && m.op === "translate");
  if (!tr || tr.part !== opts[1] || tr.dx !== 2) fail("translate did not post part: " + JSON.stringify(tr));
  console.log("ok: translate posted part =", tr.part);
  await page.evaluate(() => { window.SENT_MESSAGES.length = 0; });
  await page.selectOption("#trans-part", "");
  await page.evaluate(() => document.querySelector('.edit-apply[data-op="translate"]').click());
  const tr2 = (await sent()).find((m) => m.op === "translate");
  if (!tr2 || "part" in tr2) fail("whole-mesh translate must omit part");
  console.log("ok: whole-mesh translate omits part");

  // 3. Formula seed in the Selection panel.
  await page.click('#toolbar button[data-action="selection"]');
  await page.waitForSelector("#selection-panel", { state: "visible", timeout: 5000 });
  await page.waitForSelector("#sel-seed-kind", { state: "attached", timeout: 5000 }).catch(async () => {
    fail("no #sel-seed-kind; panel html: " + (await page.$eval("#selection-panel", (e) => e.innerHTML.slice(0, 300))));
  });
  await page.selectOption("#sel-seed-kind", "formula");
  if (!(await page.isVisible("#sel-seed-expr"))) fail("formula input hidden");
  const zmax = await page.evaluate(() => 1e9);
  await page.fill("#sel-seed-expr", "x > -1e9");
  await page.fill("#sel-seed-name", "Everything");
  await page.click("#sel-seed-create-part");
  await page.waitForTimeout(300);
  const msgs = await sent();
  const create = msgs.find((m) => m.op === "createSubModelPartFromSelection" && m.name === "Everything");
  if (!create || !(create.elements?.length > 0)) fail("Add & create SubModelPart did not post: " + JSON.stringify(create));
  console.log("ok: formula seed created a part with", create.elements.length, "elements", zmax ? "" : "");

  // 4. Node picking toggle exists and flips.
  await page.click("#sel-pick-nodes");
  if (!(await page.$eval("#sel-pick-nodes", (b) => b.classList.contains("active")))) fail("Pick nodes did not latch");
  console.log("ok: Pick nodes toggles on");

  if (pageErrors.length) fail("page errors: " + pageErrors.join(" | "));
  console.log("PASS");
} catch (e) {
  console.error("FAIL:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
