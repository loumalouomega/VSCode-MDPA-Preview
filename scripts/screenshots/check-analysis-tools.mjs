// Chromium smoke check for the "Mesh analysis and region tools" panel
// (quality gate, Hausdorff, feature edges, periodic nodes).
//
// `webview/analysisTools.ts` needs a DOM, so `node:test` cannot see it. Since
// roadmap item 2 the host runs these analyses in a cancellable worker; this
// drives the REAL webview bundle in the screenshot harness and checks the
// webview half of that contract: every request carries a fresh `seq`, a reply
// that is stale (older tag) or `cancelled` never replaces what is on screen,
// the Cancel button posts `meshAnalysisCancel` per kind and drops late replies,
// and a feature-edges reply draws its overlay. The harness has no host, so
// replies are dispatched as `message` events.
//
// Setup and run (playwright is deliberately not a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   npm run compile && npm run build:tests && node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-analysis-tools.mjs
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
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(3500);

const sent = () => page.evaluate(() => window.SENT_MESSAGES.slice());
const analysisMessages = async (kind) => (await sent()).filter((m) => m.type === "meshAnalysis" && m.kind === kind);
const report = () => page.evaluate(() => document.getElementById("analysis-tools-report")?.textContent ?? "");
const click = (label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("#analysis-tools button")].find((x) => x.textContent.trim() === l);
    if (!b) throw new Error(`no button "${l}"`);
    b.click();
  }, label);
const reply = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "meshAnalysisResult", ...d } })), data);

// --- A request is tagged and shows a running state ----------------------------------------
await click("Check quality");
const first = (await analysisMessages("qualityGate")).at(-1);
assert.equal(typeof first.seq, "number", "the request carries a sequence tag");
assert.equal(first.require, "scaled_jacobian >= 0.2");
assert.match(await report(), /Running/);

// --- A stale reply is dropped, the current one renders -------------------------------------
await reply({ kind: "qualityGate", seq: first.seq - 1, report: { passed: false, marker: "STALE" } });
await page.waitForTimeout(150);
assert.doesNotMatch(await report(), /STALE/, "an older tag never overwrites the running state");
await reply({ kind: "qualityGate", seq: first.seq, report: { passed: true, marker: "CURRENT" } });
await page.waitForTimeout(150);
assert.match(await report(), /CURRENT/);

// --- A newer request supersedes: the older reply is dropped --------------------------------
await click("Check quality");
await click("Check quality");
const [older, newer] = (await analysisMessages("qualityGate")).slice(-2);
assert.ok(newer.seq > older.seq, "each request gets a newer tag");
await reply({ kind: "qualityGate", seq: older.seq, report: { marker: "OLDER" } });
await page.waitForTimeout(150);
assert.doesNotMatch(await report(), /OLDER/);

// --- A cancelled reply is ignored -----------------------------------------------------------
await reply({ kind: "qualityGate", seq: newer.seq, cancelled: true });
await page.waitForTimeout(150);
assert.match(await report(), /Running/, "a cancelled reply changes nothing");

// --- Cancel posts one cancel per kind and drops late replies --------------------------------
const before = (await sent()).length;
await click("Cancel running analysis");
const cancels = (await sent()).slice(before).filter((m) => m.type === "meshAnalysisCancel").map((m) => m.kind).sort();
assert.deepEqual(cancels, ["featureEdges", "hausdorff", "periodicNodes", "qualityGate"]);
assert.match(await report(), /Cancelled/);
await reply({ kind: "qualityGate", seq: newer.seq, report: { marker: "LATE" } });
await page.waitForTimeout(150);
assert.doesNotMatch(await report(), /LATE/, "a reply after Cancel is dropped");

// --- Feature edges: tagged request, overlay drawn from the reply -----------------------------
await click("Preview feature edges");
const edges = (await analysisMessages("featureEdges")).at(-1);
assert.equal(typeof edges.seq, "number");
assert.equal(edges.featureAngle, 30);
await reply({ kind: "featureEdges", seq: edges.seq, report: { boundary: 1 }, edges: { points: [0, 0, 0, 1, 0, 0], lines: [2, 0, 1] } });
await page.waitForTimeout(300);
assert.match(await report(), /boundary/);

assert.deepEqual(errors.filter((e) => !/WebGL|swiftshader|GPU/i.test(e)), [], "no page errors");
await browser.close();
console.log("check-analysis-tools: OK");
