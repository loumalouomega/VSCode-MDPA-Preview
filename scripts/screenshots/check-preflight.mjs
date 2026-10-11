// Chromium smoke check for the Problemtype sidebar's **Preflight** card.
//
// `webview/problemtype.ts` is untestable under `node:test` (it needs a DOM), and
// the card is only as good as what it renders from the host's `ptPreflight`
// message: a wrong id, a severity class that never reaches the row, or a click
// handler that is never bound would pass every unit test and fail silently in the
// real UI. This script drives the REAL webview bundle in the screenshot harness,
// delivers `ptPreflight` messages the way the host would, and asserts on the DOM.
//
// What it pins down:
//   - the card is hidden until an ACTIVE report arrives, and hides again when the
//     host reports there is no case to check;
//   - the header counts errors, warnings and notes (and says "ready to generate"
//     for an empty report); rows carry their severity class, most severe first as
//     posted;
//   - a row naming a SubModelPart is a button; a row without one is not;
//   - the header toggles the rows and the choice survives the next update;
//   - finding text is set as TEXT (a message containing markup must not become DOM).
//
// Setup and run (playwright is deliberately not a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-preflight.mjs
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

/** Delivers a host message to the webview exactly as the VS Code bridge would. */
const deliver = (data) =>
  page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
const card = () =>
  page.evaluate(() => {
    const box = document.getElementById("pt-preflight");
    if (!box) throw new Error("no #pt-preflight");
    return {
      hidden: box.hidden,
      summary: box.querySelector(".pt-preflight-summary")?.textContent ?? "",
      expanded: box.querySelector(".pt-preflight-head")?.getAttribute("aria-expanded"),
      rowsHidden: box.querySelector(".pt-preflight-rows")?.hidden,
      rows: [...box.querySelectorAll(".pt-preflight-row")].map((r) => ({
        tag: r.tagName,
        classes: r.className,
        text: r.querySelector("span:last-child")?.textContent ?? "",
        title: r.getAttribute("title"),
      })),
      injected: box.querySelectorAll("b, script, img").length,
    };
  });

// --- hidden until an active report arrives ------------------------------------------------
assert.equal((await card()).hidden, true, "the card starts hidden");
await deliver({ type: "ptPreflight", active: false, counts: { error: 0, warning: 0, info: 0 }, findings: [] });
assert.equal((await card()).hidden, true, "an inactive report keeps it hidden");

// --- an active report with every severity -------------------------------------------------
const findings = [
  { severity: "error", code: "smp-missing", message: 'SubModelPart "Nope" is not in the mesh.', target: { smpPath: "Nope" } },
  { severity: "warning", code: "part-no-material", message: "Computing part \"Parts/Solid\" has no material assigned.", target: { smpPath: "Parts/Solid" } },
  { severity: "warning", code: "quality-metric", message: "Mesh-wide <b>Aspect ratio</b>: 12.0% bad." },
  { severity: "info", code: "part-unused", message: "2 SubModelPart(s) are not used." },
];
await deliver({ type: "ptPreflight", active: true, counts: { error: 1, warning: 2, info: 1 }, findings });
let view = await card();
assert.equal(view.hidden, false);
assert.equal(view.summary, "1 error · 2 warnings · 1 note");
assert.equal(view.rows.length, 4);
assert.deepEqual(view.rows.map((r) => r.classes.split(" ")[1]), ["error", "warning", "warning", "info"]);
assert.equal(view.rows[0].tag, "BUTTON", "a row naming a SubModelPart is a button");
assert.equal(view.rows[2].tag, "DIV", "a row without a part is not");
assert.match(view.rows[0].title, /show "Nope"/);
assert.equal(view.rows[2].text, "Mesh-wide <b>Aspect ratio</b>: 12.0% bad.", "text, not markup");
assert.equal(view.injected, 0, "finding text never becomes DOM");

// --- the header toggles the rows, and the choice survives the next update -----------------
await page.click(".pt-preflight-head");
view = await card();
assert.equal(view.expanded, "false");
assert.equal(view.rowsHidden, true);
await deliver({ type: "ptPreflight", active: true, counts: { error: 0, warning: 1, info: 0 }, findings: [findings[1]] });
view = await card();
assert.equal(view.rowsHidden, true, "a collapsed card stays collapsed across updates");
assert.equal(view.summary, "1 warning");
await page.click(".pt-preflight-head");

// --- clean case --------------------------------------------------------------------------
await deliver({ type: "ptPreflight", active: true, counts: { error: 0, warning: 0, info: 0 }, findings: [] });
view = await card();
assert.equal(view.summary, "ready to generate");
assert.equal(view.rows.length, 0);

// --- clicking a part row must not raise ---------------------------------------------------
await deliver({ type: "ptPreflight", active: true, counts: { error: 1, warning: 0, info: 0 }, findings: [findings[0]] });
await page.click("button.pt-preflight-row");
await page.waitForTimeout(200);

await page.screenshot({ path: path.join(ROOT, "out", "screenshot-harness", "preflight.png"), clip: { x: 0, y: 0, width: 420, height: 1000 } });
await browser.close();
assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
console.log("check-preflight: ok");
