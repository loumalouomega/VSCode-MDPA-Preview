// Chromium smoke check for the Problemtype sidebar's **Setup** stage — the
// collections editor (`renderCollections` in webview/problemtype.ts), driven
// through the Structural Optimization problemtype.
//
// `webview/problemtype.ts` needs a DOM, so `node:test` cannot reach it; a wrong
// selector, a rename that forgets the references or a chip that never reaches
// the case would pass every unit test and fail silently in the real UI. This
// script drives the REAL webview bundle in the screenshot harness and asserts
// on the `ptState` recorded on `window.SENT_MESSAGES`.
//
// What it pins down:
//   - Structural still renders and has no Setup stage (no collections declared);
//   - Optimization shows Responses (two defaults), Controls and Constraints, and
//     the Controls card reports that one is needed;
//   - adding a control by type + name, and a SubModelPart through its chip
//     picker, reaches the posted case and clears the issue;
//   - an invalid or taken name is refused in place, nothing posted;
//   - renaming a response rewrites the objective reference;
//   - removing the objective's response turns the objective select red;
//   - a ROM parameter picks a numeric value of the case from a grouped picker,
//     and a field gated on a SECTION value (grid points) follows that value.
//
// Setup and run (playwright is deliberately not a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-collections.mjs
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
const flush = () => page.waitForTimeout(450); // the 300 ms ptState debounce
async function selectProblemtype(id) {
  await page.evaluate((pid) => {
    const sel = document.getElementById("pt-select");
    sel.value = pid;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, id);
  await page.waitForTimeout(250);
}
/** The Setup stage as a user reads it. */
const setup = () =>
  page.evaluate(() => {
    const host = document.getElementById("pt-collections");
    return [...host.querySelectorAll("[data-collection]")].map((card) => ({
      id: card.dataset.collection,
      entries: [...card.querySelectorAll(".pt-entry")].map((e) => ({
        name: e.querySelector(".pt-entry-name")?.textContent ?? "",
        type: e.querySelector(".pt-assign-path")?.textContent ?? "",
        chips: [...e.querySelectorAll(".pt-chip > span")].map((c) => c.textContent),
        issues: [...e.querySelectorAll(".pt-issue")].map((i) => i.textContent),
      })),
      issues: [...card.querySelectorAll(":scope .pt-issues:not(.pt-entry .pt-issues) .pt-issue")].map((i) => i.textContent),
    }));
  });

// --- Structural: unchanged, no Setup stage ---------------------------------------------------
await selectProblemtype("structural");
assert.equal(await page.evaluate(() => document.getElementById("pt-collections").children.length), 0, "Structural declares no collections");
assert.ok(await page.evaluate(() => document.querySelectorAll("#pt-forms .pt-field").length > 5), "Structural forms still render");

// --- Optimization: three collections, defaults seeded ---------------------------------------
await selectProblemtype("optimization");
let view = await setup();
assert.deepEqual(view.map((c) => c.id), ["responses", "controls", "constraints"]);
assert.deepEqual(view[0].entries.map((e) => e.name), ["mass", "strain_energy"]);
assert.match(view[1].issues.join(" "), /add at least 1/, `controls issue: ${JSON.stringify(view[1])}`);

// --- an invalid name is refused in place ----------------------------------------------------
const addEntry = (collection, type, name) =>
  page.evaluate(
    ({ collection, type, name }) => {
      const card = document.querySelector(`[data-collection="${collection}"]`);
      const row = card.querySelector(".pt-add-row");
      row.querySelector("select").value = type;
      row.querySelector("select").dispatchEvent(new Event("change", { bubbles: true }));
      row.querySelector("input").value = name;
      row.querySelector("button").click();
      return row.querySelector("input").classList.contains("pt-invalid");
    },
    { collection, type, name }
  );
assert.equal(await addEntry("controls", "material", "bad name"), true, "an invalid name is flagged");
assert.equal(await addEntry("responses", "mass", "mass"), true, "a taken name is flagged");
view = await setup();
assert.equal(view[1].entries.length, 0, "nothing added for a refused name");

// --- add a control, then a design region through the chip picker -----------------------------
await addEntry("controls", "material", "stiffness");
await page.waitForTimeout(100);
view = await setup();
assert.deepEqual(view[1].entries.map((e) => [e.name, e.type]), [["stiffness", "Material property"]]);
assert.match(view[1].entries[0].issues.join(" "), /assign at least 1 SubModelPart/);
const firstPart = await page.evaluate(() => {
  const add = document.querySelector('[data-collection="controls"] .pt-entry .pt-chip-add');
  const option = [...add.options].find((o) => o.value);
  if (!option) throw new Error("the harness mesh offers no SubModelPart");
  add.value = option.value;
  add.dispatchEvent(new Event("change", { bubbles: true }));
  return option.value;
});
await flush();
view = await setup();
assert.deepEqual(view[1].entries[0].chips, [firstPart]);
assert.deepEqual(view[1].entries[0].issues, []);
let state = await lastState();
assert.deepEqual(state.collections.controls.map((c) => [c.name, c.type, c.parts]), [["stiffness", "material", [firstPart]]]);
assert.equal(state.collections.controls[0].values.variable, "YOUNG_MODULUS");

// --- rename a response: the objective follows --------------------------------------------------
await page.evaluate(() => {
  const entry = [...document.querySelectorAll('[data-collection="responses"] .pt-entry')].find((e) => e.dataset.entry === "strain_energy");
  [...entry.querySelectorAll("button")].find((b) => b.textContent === "✎").click();
  const input = entry.querySelector(".pt-entry-rename");
  input.value = "compliance";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
});
await flush();
state = await lastState();
assert.deepEqual(state.collections.responses.map((r) => r.name), ["mass", "compliance"]);
assert.equal(state.values.algorithm.objectiveResponse, "compliance", "the objective follows the rename");

// --- remove the objective's response: the objective turns red --------------------------------
await page.evaluate(() => {
  const entry = [...document.querySelectorAll('[data-collection="responses"] .pt-entry')].find((e) => e.dataset.entry === "compliance");
  [...entry.querySelectorAll("button")].find((b) => b.textContent === "×").click();
});
await flush();
const objective = await page.evaluate(() => {
  const select = document.querySelector('#pt-forms [data-field="objectiveResponse"] select');
  return { invalid: select.classList.contains("pt-invalid"), text: select.selectedOptions[0]?.textContent };
});
assert.equal(objective.invalid, true);
assert.match(objective.text, /compliance \(missing\)/);

// --- ROM: a parameter picks a numeric value of the case ---------------------------------------
await selectProblemtype("romStructural");
view = await setup();
assert.deepEqual(view.map((c) => c.id), ["parameters"]);
await addEntry("parameters", "range", "load");
await page.waitForTimeout(100);
const picked = await page.evaluate(() => {
  const select = document.querySelector('[data-collection="parameters"] .pt-entry [data-field="target"] select');
  const groups = [...select.querySelectorAll("optgroup")].map((g) => g.label);
  const option = [...select.options].find((o) => o.value.startsWith("section:"));
  select.value = option.value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return { groups, address: option.value };
});
assert.ok(picked.groups.length >= 1, "the value picker is grouped");
await flush();
state = await lastState();
assert.equal(state.problemtypeId, "romStructural");
assert.equal(state.collections.parameters[0].values.target, picked.address);
const gridHidden = await page.evaluate(() => document.querySelector('[data-collection="parameters"] .pt-entry [data-field="gridPoints"]').style.display);
assert.equal(gridHidden, "none", "grid points only show for the grid method");

assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
await page.screenshot({ path: path.join(ROOT, "out", "screenshot-harness", "check-collections.png") });
await browser.close();
console.log("check-collections: OK");
