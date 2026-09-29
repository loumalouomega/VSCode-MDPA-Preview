// Chromium smoke check for the Flow balance panel (Advanced ▸ Flow balance…).
//
// `webview/flowBalancePanel.ts` and its wiring in `webview/main.ts` are
// untestable under `node:test` (they need a DOM); the pure half — the form and
// its validation — is covered by `src/test/flowBalanceForm.test.ts`, the host
// half by `meshAnalysis.test.ts`. This drives the REAL webview bundle in the
// screenshot harness on a small duct mesh: opens the panel from the menu,
// checks the fields and parts it offers, that an incomplete form posts nothing
// and names the problem, that Compute posts the exact `meshAnalysis` request,
// that a stale reply (older `seq`) is dropped while the current one renders the
// table, that a typed draft survives a section add/remove, that Export CSV posts
// `menuExportAnalysis`, and that a sibling dock panel dismisses it. The harness
// has no host, so replies are dispatched as `message` events.
//
// Setup and run (playwright is deliberately not a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-flow-balance.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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

// A duct with Inlet/Outlet Conditions and nodal VELOCITY + PRESSURE: the
// default scene has neither SubModelParts of Conditions nor fields.
const { flowDuct } = require(path.join(ROOT, "out", "test", "fixtures", "shapes.js"));
const { writeMdpa } = require(path.join(ROOT, "out", "parser", "writers", "mdpaWriter.js"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-balance-"));
const meshPath = path.join(dir, "duct.mdpa");
fs.writeFileSync(meshPath, writeMdpa(flowDuct({ velocity: () => [1, 0, 0], pressure: (x) => 10 - x })));
execFileSync("node", [path.join(ROOT, "scripts", "screenshots", "build-harness.mjs")], {
  env: { ...process.env, HARNESS_MESH: meshPath },
  stdio: "pipe",
});

const { chromium } = resolvePlaywright();
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(3500);

const sent = () => page.evaluate(() => window.SENT_MESSAGES.slice());
const flowMessages = async () => (await sent()).filter((m) => m.type === "meshAnalysis" && m.kind === "flowBalance");
const panelText = () => page.evaluate(() => document.getElementById("flow-panel")?.textContent ?? "");
const visible = () => page.evaluate(() => document.getElementById("flow-panel").style.display !== "none");
const click = (label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("#flow-panel button")].find((x) => x.textContent.trim() === l);
    if (!b) throw new Error(`no button "${l}"`);
    b.click();
  }, label);
const pick = (index, value) =>
  page.evaluate(
    ({ index, value }) => {
      const el = document.querySelectorAll("#flow-panel select")[index];
      if (!el) throw new Error(`no select ${index}`);
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { index, value }
  );

// --- Open from the Advanced menu -------------------------------------------------------
assert.equal(await visible(), false, "closed at first");
await page.evaluate(() => document.querySelector('#advanced-popup [data-action="flowBalance"]').click());
assert.equal(await visible(), true, "the menu item opens the panel");
assert.equal(await page.evaluate(() => document.querySelector('[data-action="flowBalance"]').classList.contains("active")), true);
// Selects: velocity, pressure, normal, one part per section row, then the drop pair.
const velocity = await page.evaluate(() => [...document.querySelectorAll("#flow-panel select")[0].options].map((o) => o.value));
assert.ok(velocity.includes("VELOCITY"), "the vector field is offered");
assert.equal(await page.evaluate(() => document.querySelectorAll("#flow-panel select")[0].value), "VELOCITY", "Kratos' own names are preselected");
assert.equal(await page.evaluate(() => document.querySelectorAll("#flow-panel select")[1].value), "PRESSURE");
const parts = await page.evaluate(() => [...document.querySelectorAll("#flow-panel select")[3].options].map((o) => o.value));
assert.ok(parts.includes("Inlet") && parts.includes("Outlet"), "the SubModelParts are offered");

// --- An incomplete form posts nothing and says why ---------------------------------------
const before = (await flowMessages()).length;
await click("Compute");
assert.equal((await flowMessages()).length, before, "no sections, no request");
assert.match(await panelText(), /at least one section/);

// --- Choose sections; typing survives adding and removing a row ---------------------------
await pick(3, "Inlet");
await pick(4, "Outlet");
await page.evaluate(() => {
  // Text inputs: density, then one name per section row.
  const name = document.querySelectorAll('#flow-panel input[type="text"]')[2];
  name.value = "outlet-face";
  name.dispatchEvent(new Event("input", { bubbles: true }));
});
await click("Add section");
assert.equal(await page.evaluate(() => document.querySelectorAll('#flow-panel input[type="text"]').length), 4, "a third section row appears");
assert.equal(await page.evaluate(() => document.querySelectorAll('#flow-panel input[type="text"]')[2].value), "outlet-face", "the draft survives the re-render");
await page.evaluate(() => [...document.querySelectorAll("#flow-panel button")].filter((b) => b.textContent.trim() === "✕").at(-1).click());
assert.equal(await page.evaluate(() => document.querySelectorAll('#flow-panel input[type="text"]').length), 3, "the row is removed again");

// The Drop choices follow the sections' labels (here "Inlet" and the typed "outlet-face").
const dropOptions = await page.evaluate(() => [...document.querySelectorAll("#flow-panel select")].at(-2).options.length && [...[...document.querySelectorAll("#flow-panel select")].at(-2).options].map((o) => o.value));
assert.deepEqual(dropOptions.slice(0, 2), ["", "Inlet"], "the pressure-drop select offers the chosen sections");

// --- Compute posts the exact request -----------------------------------------------------
await click("Compute");
const posted = (await flowMessages()).at(-1);
assert.deepEqual(posted.flow.sections, [{ name: "Inlet", part: "Inlet" }, { name: "outlet-face", part: "Outlet" }]);
assert.equal(posted.flow.velocity, "VELOCITY");
assert.equal(posted.flow.pressure, "PRESSURE");
assert.equal(posted.flow.orientation, "outward");
assert.equal(typeof posted.seq, "number");
assert.match(await panelText(), /Computing/);

// --- A reply with the current seq renders the table; a stale one is dropped ----------------
const result = {
  dimension: 3,
  velocity: "VELOCITY",
  pressure: "PRESSURE",
  orientation: "outward",
  fluxUnit: "velocity unit x mesh length^2",
  sections: [
    { name: "Inlet", part: "Inlet", facets: 1, area: 1, degenerate: 0, unoriented: 0, internal: 0, fluxArea: 1, fluxUncoveredArea: 0, flux: -1, massFlux: null, meanPressure: 10, pressureArea: 1, pressureUncoveredArea: 0 },
    { name: "outlet-face", part: "Outlet", facets: 1, area: 1, degenerate: 0, unoriented: 0, internal: 0, fluxArea: 1, fluxUncoveredArea: 0, flux: 1, massFlux: null, meanPressure: 8, pressureArea: 1, pressureUncoveredArea: 0 },
  ],
  inflow: 1,
  outflow: 1,
  netFlux: 0,
  imbalance: 0,
  imbalanceNote: "net flux / max(total inflow, total outflow) over the sections given",
  warnings: ["Section \"Inlet\": 1 zero-area facet skipped."],
};
const reply = (seq, extra) =>
  page.evaluate(
    ({ seq, extra }) => window.dispatchEvent(new MessageEvent("message", { data: { type: "meshAnalysisResult", kind: "flowBalance", seq, ...extra } })),
    { seq, extra }
  );
await reply(posted.seq - 1, { summary: "STALE", flow: result });
await page.waitForTimeout(200);
assert.doesNotMatch(await panelText(), /STALE|imbalance/, "an older reply is dropped");
assert.match(await panelText(), /Computing/, "still waiting for the current one");
await reply(posted.seq, { summary: "Flux…", flow: result });
await page.waitForTimeout(300);
const text = await panelText();
assert.match(text, /outlet-face/);
assert.match(text, /imbalance/);
assert.match(text, /positive OUT of the domain/);
assert.match(text, /zero-area facet skipped/, "warnings are shown");
assert.equal(await page.evaluate(() => [...document.querySelectorAll("#flow-panel button")].find((b) => b.textContent.trim() === "Export CSV").disabled), false, "Export is enabled once there is a result");

// --- Export posts the CSV -------------------------------------------------------------------
const n = (await sent()).length;
await click("Export CSV");
const exported = (await sent()).slice(n).find((m) => m.type === "menuExportAnalysis");
assert.equal(exported.suffix, "flow-balance");
assert.match(exported.csv, /^section,part,area,flux,/);
assert.match(exported.csv, /outlet-face,Outlet,1,1,/);

// --- A refusal (and a failure) arrives as a message and keeps its seq -----------------------
await click("Compute");
const second = (await flowMessages()).at(-1);
assert.ok(second.seq > posted.seq, "each request gets a newer tag");
await reply(second.seq, { message: 'No SubModelPart "Nope".' });
await page.waitForTimeout(200);
assert.match(await panelText(), /No SubModelPart "Nope"/);
assert.doesNotMatch(await panelText(), /outlet-face \(mass\)|positive OUT/, "a failure drops the old table rather than keeping stale numbers");

// --- Close hides it; a sibling dock panel replaces it ---------------------------------------
await page.evaluate(() => document.querySelector("#flow-panel .meshsize-close").click());
assert.equal(await visible(), false, "close hides the panel");
assert.equal(await page.evaluate(() => document.querySelector('[data-action="flowBalance"]').classList.contains("active")), false);
await page.evaluate(() => document.querySelector('#advanced-popup [data-action="flowBalance"]').click());
await page.evaluate(() => document.querySelector('#advanced-popup [data-action="integrals"]').click());
assert.equal(await visible(), false, "a sibling dock panel replaces it");

assert.deepEqual(errors.filter((e) => !/WebGL|swiftshader|GPU/i.test(e)), [], "no page errors");
await browser.close();
console.log("check-flow-balance: OK");
