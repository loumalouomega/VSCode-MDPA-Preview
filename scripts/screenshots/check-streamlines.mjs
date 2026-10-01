// Chromium smoke check for the Streamlines panel (Advanced ▸ Streamlines…).
//
// `webview/streamlinePanel.ts` and its wiring in `webview/main.ts` are untestable
// under `node:test` (they need a DOM); the pure half — the form and its
// validation — is covered by `src/test/streamlineForm.test.ts`, the host half by
// `meshAnalysis.test.ts`. This drives the REAL webview bundle in the screenshot
// harness: opens the panel from the menu, types seeds the way a user would,
// clicks Trace and asserts the exact `meshAnalysis` message posted; feeds back a
// host reply and checks a stale one (an older `seq`) is dropped; checks an
// invalid form posts nothing; that the typed draft survives a seed-kind switch;
// and that Export posts `menuExportDerived` with a `streamlines` spec. The
// harness has no host, so replies are dispatched as `message` events.
//
// Setup and run (playwright is deliberately not a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-streamlines.mjs
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

// A mesh with a nodal vector field (DISPLACEMENT); the default scene has no
// fields at all, and the panel disables itself without one.
execFileSync("node", [path.join(ROOT, "scripts", "screenshots", "build-harness.mjs")], {
  env: { ...process.env, HARNESS_MESH: path.join(ROOT, "example", "VTK", "Main_0_4.vtk") },
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
const panelText = () => page.evaluate(() => document.getElementById("streamline-panel")?.textContent ?? "");
const visible = () => page.evaluate(() => document.getElementById("streamline-panel").style.display !== "none");
const click = (label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("#streamline-panel button")].find((x) => x.textContent.trim() === l);
    if (!b) throw new Error(`no button "${l}"`);
    b.click();
  }, label);
const streamMessages = async () => (await sent()).filter((m) => m.type === "meshAnalysis" && m.kind === "streamlines");

// --- Open from the Advanced menu -------------------------------------------------------
assert.equal(await visible(), false, "closed at first");
await page.evaluate(() => document.querySelector('#advanced-popup [data-action="streamlines"]').click());
assert.equal(await visible(), true, "the menu item opens the panel");
assert.equal(await page.evaluate(() => document.querySelector('[data-action="streamlines"]').classList.contains("active")), true);
const fields = await page.evaluate(() => [...document.querySelectorAll("#streamline-panel select")][0]?.options.length ?? 0);
assert.ok(fields >= 1, "the vector field is offered");

// --- An empty form posts nothing and says why -------------------------------------------
const before = (await streamMessages()).length;
await click("Trace");
assert.equal((await streamMessages()).length, before, "no seeds, no request");
assert.match(await panelText(), /Enter at least one seed point/);

// --- Typing seeds, then Trace posts the exact request ------------------------------------
await page.evaluate(() => {
  const area = document.querySelector('#streamline-panel [data-streamline-field="points"]');
  area.value = "0 0 0\n1, 2, 3";
  area.dispatchEvent(new Event("input", { bubbles: true }));
});
// A seed-kind switch re-renders; the typed draft must survive it.
await page.evaluate(() => {
  const kind = document.querySelectorAll("#streamline-panel select")[1];
  kind.value = "line";
  kind.dispatchEvent(new Event("change", { bubbles: true }));
});
assert.match(await panelText(), /From/);
await page.evaluate(() => {
  const kind = document.querySelectorAll("#streamline-panel select")[1];
  kind.value = "points";
  kind.dispatchEvent(new Event("change", { bubbles: true }));
});
assert.equal(await page.evaluate(() => document.querySelector('#streamline-panel [data-streamline-field="points"]').value), "0 0 0\n1, 2, 3", "the draft survives a re-render");

await click("Trace");
const posted = (await streamMessages()).at(-1);
assert.equal(posted.seeds.kind, "points");
assert.deepEqual(posted.seeds.points, [[0, 0, 0], [1, 2, 3]]);
assert.equal(posted.direction, "forward");
assert.ok(posted.variable, "a field is named");
assert.equal(typeof posted.seq, "number");
assert.match(await panelText(), /Tracing/);

// --- A reply with the current seq is drawn; a stale one is dropped ------------------------
const reply = (seq, summary, lineCount = 1) =>
  page.evaluate(
    ({ seq, summary, lineCount }) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "meshAnalysisResult",
            kind: "streamlines",
            seq,
            summary,
            streamlines: {
              points: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
              lines: new Uint32Array([3, 0, 1, 2]),
              speed: new Float32Array([1, 2, 3]),
              termination: new Uint8Array([2]),
              lineCount,
              seedCount: 2,
              rejected: 1,
              truncated: false,
            },
          },
        })
      ),
    { seq, summary, lineCount }
  );
await reply(posted.seq - 1, "STALE SUMMARY");
await page.waitForTimeout(200);
assert.doesNotMatch(await panelText(), /STALE SUMMARY/, "an older reply is dropped");
assert.match(await panelText(), /Tracing/, "still waiting for the current one");
await reply(posted.seq, "1 streamline of \"D\" from 2 seeds. no line for 1: 1 seed lies outside the domain.");
await page.waitForTimeout(300);
assert.match(await panelText(), /1 streamline of "D" from 2 seeds/);
assert.equal(await page.evaluate(() => [...document.querySelectorAll("#streamline-panel button")].find((b) => b.textContent.trim() === "Clear").disabled), false, "Clear is enabled once lines are drawn");

// --- Export posts the derived-mesh spec ---------------------------------------------------
const n = (await sent()).length;
await click("Export…");
const exported = (await sent()).slice(n).find((m) => m.type === "menuExportDerived");
assert.equal(exported.derive.kind, "streamlines");
assert.equal(exported.derive.seeds.points.length, 2);
assert.equal(exported.derive.variable, posted.variable);

// --- Styling is view-only: switching to Tubes posts no new request -------------------
const styles = await page.evaluate(() => [...document.querySelectorAll("#streamline-panel select")].map((s) => [...s.options].map((o) => o.value)));
assert.ok(styles.some((opts) => opts.includes("lines") && opts.includes("tubes")), "a Style control offers Lines/Tubes");
const nBefore = (await streamMessages()).length;
await page.evaluate(() => {
  const sel = [...document.querySelectorAll("#streamline-panel select")].find((s) => [...s.options].some((o) => o.value === "tubes"));
  sel.value = "tubes";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(300);
assert.equal((await streamMessages()).length, nBefore, "styling never re-traces");
assert.match(await panelText(), /Radius/, "tube options appear");
// Back to lines for the remaining steps.
await page.evaluate(() => {
  const sel = [...document.querySelectorAll("#streamline-panel select")].find((s) => [...s.options].some((o) => o.value === "tubes"));
  sel.value = "lines";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});

// --- Progress carries the request tag; a stale tag is dropped ---------------------------
await click("Trace");
const third = (await streamMessages()).at(-1);
assert.equal(await page.evaluate(() => [...document.querySelectorAll("#streamline-panel button")].some((b) => b.textContent.trim() === "Cancel")), true, "Cancel is offered while busy");
await page.evaluate(({ seq }) => window.dispatchEvent(new MessageEvent("message", { data: { type: "streamlineProgress", done: 1, total: 2, seq: seq - 1 } })), third.seq);
await page.waitForTimeout(200);
assert.doesNotMatch(await panelText(), /1\/2/, "progress from an older request is dropped");
await page.evaluate(({ seq }) => window.dispatchEvent(new MessageEvent("message", { data: { type: "streamlineProgress", done: 1, total: 2, seq } })), third.seq);
await page.waitForTimeout(200);
assert.match(await panelText(), /1\/2/, "live progress names the seed count");
const cancelCount = (await sent()).length;
await click("Cancel");
const cancelled = (await sent()).slice(cancelCount).find((m) => m.type === "streamlineCancel");
assert.ok(cancelled, "Cancel asks the host to stop the trace");
assert.match(await panelText(), /Cancelling/, "the panel says what cancel means");
await reply(third.seq, "1 streamline of \"D\" from 2 seeds. cancelled; partial result.");
await page.waitForTimeout(300);
assert.match(await panelText(), /partial result/, "the partial result is drawn under the current tag");

// --- A seed plane fills from the focused pane's clip plane --------------------------------
await page.evaluate(() => {
  const kind = document.querySelectorAll("#streamline-panel select")[1];
  kind.value = "plane";
  kind.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.evaluate(() => [...document.querySelectorAll("#streamline-panel button")].find((b) => b.textContent.trim() === "Use clip plane").click());
const filled = await page.evaluate(() => [...document.querySelectorAll("#streamline-panel input")].map((i) => i.value));
assert.ok(filled.some((v) => v.trim().length > 0), "Origin/U/V are filled from the clip plane");

// --- A refusal from the host arrives as a message and keeps its seq ------------------------
await click("Trace");
const second = (await streamMessages()).at(-1);
assert.ok(second.seq > posted.seq, "each request gets a newer tag");
await page.evaluate((seq) => window.dispatchEvent(new MessageEvent("message", { data: { type: "meshAnalysisResult", kind: "streamlines", seq, message: "\"T\" has 1 component; streamlines need a 2- or 3-component vector field." } })), second.seq);
await page.waitForTimeout(200);
assert.match(await panelText(), /2- or 3-component/);

// --- Clear removes the drawing; closing drops it too ---------------------------------------
await reply(second.seq, "again");
await page.waitForTimeout(200);
await click("Clear");
assert.equal(await page.evaluate(() => [...document.querySelectorAll("#streamline-panel button")].find((b) => b.textContent.trim() === "Clear").disabled), true);
await page.evaluate(() => document.querySelector("#streamline-panel .meshsize-close").click());
assert.equal(await visible(), false, "close hides the panel");
assert.equal(await page.evaluate(() => document.querySelector('[data-action="streamlines"]').classList.contains("active")), false);

// Opening another dock panel dismisses this one (the left-dock rule).
await page.evaluate(() => document.querySelector('#advanced-popup [data-action="streamlines"]').click());
await page.evaluate(() => document.querySelector('#advanced-popup [data-action="integrals"]').click());
assert.equal(await visible(), false, "a sibling dock panel replaces it");

assert.deepEqual(errors.filter((e) => !/WebGL|swiftshader|GPU/i.test(e)), [], "no page errors");
await browser.close();
console.log("check-streamlines: OK");
