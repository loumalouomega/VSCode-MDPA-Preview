// Chromium smoke check for the Tier 2 sidebar forms (field management,
// conditioning, repair, curvature, shrinkwrap, Sobolev, compare) and the Tier 2
// export entry points (Field panel Export isosurface/region/boundary, Clip's Export
// slice…, the Advanced ▸ Export partitions… / Split mesh… items) and the View ▸
// Level of detail toggle.
//
// `webview/meshMod.ts` is untestable under `node:test` (it needs a DOM), and every
// form here is only as good as the `applyOp` message its builder posts — a typo in
// an element id or a field name fails silently in the real UI. This script drives
// the REAL webview bundle in the screenshot harness, fills each form the way a
// user would, clicks its Apply button and asserts on the exact message recorded on
// `window.SENT_MESSAGES` (the harness stub of `acquireVsCodeApi`).
//
// Setup and run (playwright is deliberately not a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-tier2-forms.mjs
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

// The averageField op scene carries a hex block with a nodal field, which is what
// enables the field-driven forms (they disable themselves on a field-less mesh).
execFileSync("node", [path.join(ROOT, "scripts", "screenshots", "build-harness.mjs")], {
  env: { ...process.env, HARNESS_SCENE: "op", HARNESS_OP: "averageField" },
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

/** Sets controls by id, clicks the button, and returns the message the click posted (or undefined). */
async function fillAndClick(set, buttonSelector) {
  return page.evaluate(
    ({ set, buttonSelector }) => {
      const before = (window.SENT_MESSAGES ||= []).length;
      for (const [id, v] of Object.entries(set)) {
        const el = document.getElementById(id);
        if (!el) throw new Error(`no element #${id}`);
        if (el.type === "checkbox") el.checked = Boolean(v);
        else el.value = String(v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const btn = document.querySelector(buttonSelector);
      if (!btn) throw new Error(`no button ${buttonSelector}`);
      btn.click();
      return window.SENT_MESSAGES.slice(before).find((m) => m.type === "applyOp" || m.type === "pickMeshFile");
    },
    { set, buttonSelector }
  );
}

const fieldOption = await page.evaluate(() => {
  const sel = document.getElementById("fm-field");
  return [...sel.options].map((o) => o.value).filter(Boolean)[0];
});
assert.ok(fieldOption, "the scene has a field to manage");
const [kind, variable] = [fieldOption.split(":")[0], fieldOption.slice(fieldOption.indexOf(":") + 1)];

// --- Manage fields ---------------------------------------------------------------
let m = await fillAndClick({ "fm-field": fieldOption, "fm-newname": "RENAMED" }, '[data-op="renameField"]');
assert.deepEqual(m, { type: "applyOp", op: "renameField", kind, variable, newName: "RENAMED" });
m = await fillAndClick({ "fm-field": fieldOption, "fm-overwrite": true }, '[data-op="renameField"]');
assert.equal(m.onConflict, "overwrite");
m = await fillAndClick({ "fm-field": fieldOption }, '[data-op="dropFields"]');
assert.deepEqual(m, { type: "applyOp", op: "dropFields", kind, variables: [variable] });
m = await fillAndClick({ "fm-field": fieldOption }, '[data-op="keepFields"]');
assert.deepEqual(m, { type: "applyOp", op: "keepFields", kind, variables: [variable] });
// A rename with no new name posts nothing.
await page.evaluate(() => { document.getElementById("fm-newname").value = ""; });
assert.equal(await fillAndClick({}, '[data-op="renameField"]'), undefined);

// --- Condition field ---------------------------------------------------------------
m = await fillAndClick({ "cond-field": fieldOption, "cond-mode": "clamp", "cond-lo": 2, "cond-hi": 5, "cond-scope": "component", "cond-nan": "replace", "cond-nanvalue": -7, "cond-output": "OUT" }, '[data-op="conditionField"]');
assert.deepEqual(m, { type: "applyOp", op: "conditionField", kind, variable, mode: "clamp", lo: 2, hi: 5, scope: "component", nanPolicy: "replace", nanReplacement: -7, output: "OUT" });
m = await fillAndClick({ "cond-mode": "standardize", "cond-nan": "ignore", "cond-output": "" }, '[data-op="conditionField"]');
assert.equal("lo" in m, false, "standardize sends no range");
assert.equal(m.mode, "standardize");
assert.equal(await page.evaluate(() => document.getElementById("cond-lo-field").classList.contains("hidden")), true, "lo/hi hide for standardize");

// --- Repair surface -----------------------------------------------------------------
m = await fillAndClick({ "repair-maxhole": 12, "repair-weld": 0.5, "repair-outward": false }, '[data-op="repairSurface"]');
assert.deepEqual(m, { type: "applyOp", op: "repairSurface", fixOrientation: true, orientOutward: false, fillHoles: true, splitNonManifold: true, maxHoleEdges: 12, weldTolerance: 0.5 });

// --- Curvature ----------------------------------------------------------------------
m = await fillAndClick({ "curv-mean": true, "curv-gauss": false, "curv-principal": true, "curv-area": false, "curv-dual": "barycentric", "curv-boundary": true, "curv-prefix": "K" }, '[data-op="curvature"]');
assert.deepEqual(m, { type: "applyOp", op: "curvature", mean: true, gaussian: false, principal: true, area: false, dualArea: "barycentric", includeBoundary: true, outputPrefix: "K" });
assert.equal(await fillAndClick({ "curv-mean": false, "curv-gauss": false, "curv-principal": false, "curv-area": false }, '[data-op="curvature"]'), undefined, "nothing selected posts nothing");

// --- Surface / volume meshing --------------------------------------------------------------
m = await fillAndClick({ "sr-clusters": 300, "sr-metric": "anisotropic", "sr-gradation": 0.5, "sr-aniso": 3, "sr-boundary": false }, '[data-op="surfaceRemesh"]');
assert.deepEqual(m, { type: "applyOp", op: "surfaceRemesh", metric: "anisotropic", preserveBoundary: false, numClusters: 300, gradation: 0.5, maxAnisotropy: 3 });
assert.equal(await page.evaluate(() => document.getElementById("sr-aniso-field").classList.contains("hidden")), false, "max stretch shows for anisotropic");
m = await fillAndClick({ "sr-clusters": "", "sr-metric": "isotropic", "sr-gradation": 0 }, '[data-op="surfaceRemesh"]');
assert.equal("numClusters" in m, false, "blank vertices means half the nodes");
assert.equal("maxAnisotropy" in m, false, "the stretch limit is sent only for the anisotropic metric");
assert.equal(await page.evaluate(() => document.getElementById("sr-aniso-field").classList.contains("hidden")), true);
assert.equal(await fillAndClick({ "sr-clusters": 2 }, '[data-op="surfaceRemesh"]'), undefined, "fewer than 4 vertices posts nothing");
assert.equal(await fillAndClick({ "vm-cellsize": "" }, '[data-op="volumeMesh"]'), undefined, "no cell size posts nothing");
m = await fillAndClick({ "vm-cellsize": 0.25, "vm-warp": 0.2, "vm-surface": false }, '[data-op="volumeMesh"]');
assert.deepEqual(m, { type: "applyOp", op: "volumeMesh", cellSize: 0.25, keepSurface: false, warpFraction: 0.2 });
m = await fillAndClick({ "ov-flip": false, "ov-relocate": true, "ov-boundary": true, "ov-iter": 25 }, '[data-op="optimizeVolume"]');
assert.deepEqual(m, { type: "applyOp", op: "optimizeVolume", flip: false, relocate: true, preserveBoundary: true, maxIterations: 25 });

// --- Shrinkwrap / Sobolev / Compare need a target: no target, no message ---------------
assert.equal(await fillAndClick({}, '[data-op="shrinkwrap"]'), undefined);
assert.equal(await fillAndClick({}, '[data-op="compareField"]'), undefined);
// Their Browse buttons ask the host for a file, naming the form.
for (const [id, target] of [["sw-browse", "shrinkwrap"], ["cmp-browse", "compareField"]]) {
  m = await fillAndClick({}, `#${id}`);
  assert.deepEqual(m, { type: "pickMeshFile", target });
}
// A host reply fills the field and the builder then posts the file.
await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "mergeMeshPicked", target: "shrinkwrap", paths: ["/tmp/scan.stl"] } })));
m = await fillAndClick({ "sw-offset": 0.25, "sw-maxdist": 3, "sw-blend": 0.5, "sw-record": true }, '[data-op="shrinkwrap"]');
assert.deepEqual(m, { type: "applyOp", op: "shrinkwrap", path: "/tmp/scan.stl", offset: 0.25, maxDistance: 3, blend: 0.5, recordDistance: true });
await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "mergeMeshPicked", target: "compareField", paths: ["/tmp/other.vtu"] } })));
m = await fillAndClick({ "cmp-field": fieldOption, "cmp-corr": "spatial", "cmp-atol": 0.01, "cmp-source": "T2", "cmp-output": "CMP" }, '[data-op="compareField"]');
assert.deepEqual(m, { type: "applyOp", op: "compareField", path: "/tmp/other.vtu", kind, variable, correspondence: "spatial", sourceVariable: "T2", atol: 0.01, output: "CMP" });

// --- Field panel exports: Isosurface and Threshold modes --------------------------------
const sent = () => page.evaluate(() => window.SENT_MESSAGES.filter((x) => x.type === "menuExportDerived" || x.type === "menuExportPartitions" || x.type === "menuSplitMesh"));
await page.evaluate(() => document.querySelector('[data-action="field"]')?.click());
await page.waitForTimeout(300);
const clickMode = (label) => page.evaluate((l) => [...document.querySelectorAll("#field-panel .field-mode-btn")].find((b) => b.textContent.trim() === l)?.click(), label);
const clickText = (label) => page.evaluate((l) => [...document.querySelectorAll("#field-panel button")].find((b) => b.textContent.trim() === l)?.click(), label);
await clickMode("Isosurface");
await page.waitForTimeout(300);
const before = (await sent()).length;
await clickText("Export isosurface…");
let derived = (await sent()).slice(before);
assert.equal(derived.length, 1, "Export isosurface… posts one message");
assert.equal(derived[0].type, "menuExportDerived");
assert.equal(derived[0].derive.kind, "isosurface");
assert.equal(derived[0].derive.variable, "RADIAL_DISTANCE");
assert.ok(derived[0].derive.values.length >= 1 && derived[0].derive.values.every(Number.isFinite));
assert.equal(derived[0].derive.component, "mag");
await clickMode("Isosurface"); // off again
await clickMode("Threshold");
await page.waitForTimeout(300);
const n2 = (await sent()).length;
await clickText("Export region…");
await clickText("Export boundary…");
derived = (await sent()).slice(n2);
assert.equal(derived.length, 2);
assert.deepEqual(derived.map((d) => [d.derive.kind, d.derive.output]), [["threshold", "region"], ["threshold", "skin"]]);
assert.equal(derived[0].derive.fieldKind, "Nodal");
assert.ok(Array.isArray(derived[0].derive.range) && derived[0].derive.range.length === 2 && derived[0].derive.range[0] <= derived[0].derive.range[1]);
assert.equal(derived[0].derive.rule, "all");

// --- Clip: Export slice… needs Clip ON -------------------------------------------------
assert.equal(await page.evaluate(() => document.getElementById("cut-export").disabled), true, "disabled while Clip is off");
await page.evaluate(() => document.getElementById("cut-toggle").click());
await page.waitForTimeout(300);
assert.equal(await page.evaluate(() => document.getElementById("cut-export").disabled), false, "enabled once Clip is on");
const n3 = (await sent()).length;
await page.evaluate(() => document.getElementById("cut-export").click());
derived = (await sent()).slice(n3);
assert.equal(derived.length, 1);
assert.equal(derived[0].derive.kind, "slice");
assert.equal(derived[0].derive.origin.length, 3);
assert.ok(Math.abs(Math.hypot(...derived[0].derive.normal) - 1) < 1e-6, "the normal is a unit vector");

// --- Advanced menu: partitions and split ------------------------------------------------
for (const [action, type] of [["exportPartitions", "menuExportPartitions"], ["splitMesh", "menuSplitMesh"]]) {
  const n = (await sent()).length;
  await page.evaluate((a) => document.querySelector(`#advanced-popup [data-action="${a}"]`).click(), action);
  assert.deepEqual((await sent()).slice(n).map((x) => x.type), [type], `${action} posts ${type}`);
}

// --- View ▸ Level of detail: request, reply, restore ------------------------------------
const lodMessages = () => page.evaluate(() => window.SENT_MESSAGES.filter((x) => x.type === "meshAnalysis" && x.kind === "lod").length);
const statusText = () => page.evaluate(() => document.getElementById("message")?.textContent ?? "");
const n4 = await lodMessages();
await page.evaluate(() => document.querySelector('#view-popup [data-action="lod"]').click());
assert.equal((await lodMessages()) - n4, 1, "turning LOD on asks the host once");
assert.match(await statusText(), /decimating/);
assert.equal(await page.evaluate(() => document.querySelector('[data-action="lod"]').classList.contains("active")), true);
// A host reply: one triangle. The status names the counts and that picking is off.
await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "meshAnalysisResult", kind: "lod", lod: { points: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2], sourceFaces: 10, keptFaces: 1, skin: true } } })));
await page.waitForTimeout(300);
assert.match(await statusText(), /1 of 10 faces \(the boundary skin\).*picking is off/);
// Off again: the status clears and the toggle is no longer active.
await page.evaluate(() => document.querySelector('#view-popup [data-action="lod"]').click());
assert.equal(await statusText(), "");
assert.equal(await page.evaluate(() => document.querySelector('[data-action="lod"]').classList.contains("active")), false);
// A refusal turns the toggle back off and shows why.
await page.evaluate(() => document.querySelector('#view-popup [data-action="lod"]').click());
await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "meshAnalysisResult", kind: "lod", message: "The mesh has no surface faces to draw." } })));
assert.match(await statusText(), /no surface faces/);
assert.equal(await page.evaluate(() => document.querySelector('[data-action="lod"]').classList.contains("active")), false);

// --- The forms actually rendered, and the page raised no errors ---------------------------
const forms = await page.evaluate(() => ["fm-form", "cond-form", "repair-form", "curv-form", "sw-form", "sob-form", "cmp-form", "sr-form", "vm-form", "ov-form"].map((id) => [id, !!document.getElementById(id)]));
for (const [id, present] of forms) assert.ok(present, `#${id} is in the sidebar`);
assert.deepEqual(errors.filter((e) => !/WebGL|swiftshader|GPU/i.test(e)), [], "no page errors");

await browser.close();
console.log("check-tier2-forms: OK");
