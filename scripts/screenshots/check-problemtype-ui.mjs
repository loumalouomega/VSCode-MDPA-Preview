// Chromium smoke check for the Problemtype sidebar's grouped layout.
//
// `webview/problemtype.ts` / `problemtypeUi.ts` need a DOM, so the layout
// decisions (pure, in src/problemtype/layout.ts) are unit-tested while this
// script checks that the real bundle DRAWS them: the catalog <optgroup>s, the
// header card and its chips, stage separators, collapsible field groups, the
// per-domain condition branches of a coupled problemtype, and that a card the
// user collapsed stays collapsed when the form re-renders.
//
// Run (playwright is deliberately not a repo dependency):
//   npm run compile && npm run build:tests && node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-problemtype-ui.mjs
import { createRequire } from "node:module";
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

const { chromium } = resolvePlaywright();
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(3500);

const select = async (id) => {
  await page.evaluate((pid) => {
    const sel = document.getElementById("pt-select");
    sel.value = pid;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, id);
  await page.waitForTimeout(300);
};

// Catalog: grouped by family, broken entries last.
const groups = await page.evaluate(() =>
  [...document.querySelectorAll("#pt-select optgroup")].map((g) => ({ label: g.label, options: g.querySelectorAll("option").length }))
);
assert.deepEqual(
  groups.map((g) => g.label),
  ["Solids & structures", "Fluids", "Thermal", "Coupled physics", "Workflow"],
  `catalog groups: ${JSON.stringify(groups)}`
);
assert.equal(groups.find((g) => g.label === "Coupled physics").options, 3);

// Structure of a single-physics problemtype.
await select("fluid");
const fluid = await page.evaluate(() => ({
  header: document.querySelector("#pt-header .pt-header-name")?.textContent,
  chips: [...document.querySelectorAll("#pt-header .pt-chip")].length,
  seps: [...document.querySelectorAll(".sb-section[data-section=problemtype] .pt-sep-label")].map((e) => e.textContent),
  groups: [...document.querySelectorAll("#pt-forms .pt-group-title")].map((e) => e.textContent),
}));
assert.match(fluid.header ?? "", /Fluid/);
assert.equal(fluid.chips, 3);
assert.ok(fluid.seps.length >= 3, `stage separators: ${fluid.seps}`);
assert.ok(fluid.groups.length >= 3, `field groups: ${fluid.groups}`);

// A collapsed group stays collapsed across a re-render (a field edit re-renders the cards).
const title = '#pt-forms .pt-group-header';
await page.click(`${title} >> nth=0`);
const firstGroup = () => page.evaluate(() => document.querySelector("#pt-forms .pt-group")?.classList.contains("collapsed"));
const toggled = await firstGroup();
await select("fluid");
assert.equal(await firstGroup(), toggled, "collapse state must survive a re-render");

// Coupled: conditions are branched per domain, and each domain has its own parts card.
await select("fsi");
const fsi = await page.evaluate(() => ({
  name: document.querySelector("#pt-header .pt-header-name")?.textContent,
  branches: [...document.querySelectorAll("#pt-assignments .pt-branch-title, #pt-assignments .pt-group-title")].map((e) => e.textContent),
  text: document.getElementById("pt-parts")?.textContent ?? "",
}));
assert.match(fsi.name ?? "", /Fluid-Structure/);
assert.ok(/Fluid/.test(fsi.text) && /Structure/.test(fsi.text), `per-domain parts: ${fsi.text}`);

assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
await browser.close();
console.log("check-problemtype-ui: OK");
