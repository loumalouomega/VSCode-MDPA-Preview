// Chromium check of the CoSimulation problemtype's Coupling form (roadmap item 16):
// webview/problemtype.ts needs a DOM, so the gated fields are driven through the real
// bundle in the screenshot harness. Asserts that the strong-coupling, accelerator,
// Aitken and ALE fields appear only when their rule holds, that the posted ptState
// carries what was picked, and that the page logs no errors.
//
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-cosim-coupling.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolvePlaywright() {
  for (const c of ["playwright-core", path.join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright-core not found — see the header comment.");
}

execFileSync("node", [path.join(ROOT, "scripts", "screenshots", "build-harness.mjs")], { stdio: "pipe" });

const { chromium } = resolvePlaywright();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(3500);

const lastState = async () => {
  const all = (await page.evaluate(() => window.SENT_MESSAGES ?? [])).filter((m) => m.type === "ptState");
  return all.length > 0 ? all[all.length - 1].state : undefined;
};
/** The ids of the Coupling section's fields a user can see. */
const visible = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("#pt-forms [data-field]")]
      .filter((el) => el.offsetParent !== null)
      .map((el) => el.dataset.field)
  );
async function setField(id, value) {
  await page.evaluate(
    ([fid, v]) => {
      const el = document.querySelector(`#pt-forms [data-field="${fid}"] select, #pt-forms [data-field="${fid}"] input`);
      if (el.type === "checkbox") el.checked = v;
      else el.value = String(v);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    [id, value]
  );
  await page.waitForTimeout(450); // re-render + the 300 ms ptState debounce
}
/** Opens every collapsed group, so visibility reflects the rules rather than the collapse state. */
const expandAll = () =>
  page.evaluate(() => {
    for (const d of document.querySelectorAll("#pt-forms details")) d.open = true;
    for (const b of document.querySelectorAll('#pt-forms [aria-expanded="false"]')) b.click();
  });

await page.evaluate(() => {
  const sel = document.getElementById("pt-select");
  sel.value = "cosim";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(300);
await expandAll();

let shown = await visible();
for (const id of ["couplingType", "predictor", "predictorBeta", "mapperType", "aleMesh"]) assert.ok(shown.includes(id), `${id} is shown`);
for (const id of ["numCouplingIterations", "accelerator", "absTolerance", "meshSolver"]) assert.ok(!shown.includes(id), `${id} is hidden for weak coupling`);

await setField("couplingType", "strong");
await expandAll();
shown = await visible();
for (const id of ["numCouplingIterations", "absTolerance", "relTolerance", "accelerator"]) assert.ok(shown.includes(id), `${id} appears for strong coupling`);

await setField("accelerator", "aitken");
await expandAll();
shown = await visible();
assert.ok(!shown.includes("acceleratorAlpha"), "the quasi-Newton relaxation hides for Aitken");

await setField("predictor", "linear_derivative_based");
await setField("aleMesh", true);
await expandAll();
shown = await visible();
assert.ok(!shown.includes("predictorBeta"), "β hides for the linear predictor");
assert.ok(shown.includes("meshSolver"), "the mesh motion solver appears with ALE");

const state = await lastState();
assert.equal(state.problemtypeId, "cosim");
assert.equal(state.values.coupling.couplingType, "strong");
assert.equal(state.values.coupling.accelerator, "aitken");
assert.equal(state.values.coupling.predictor, "linear_derivative_based");
assert.equal(state.values.coupling.aleMesh, true);

// The ALE hold is offered as a fluid condition.
const conditions = await page.evaluate(() => document.body.innerText.includes("ALE mesh displacement"));
assert.ok(conditions, "the ALE mesh displacement condition is listed");

await browser.close();
assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
console.log("check-cosim-coupling: ok");
