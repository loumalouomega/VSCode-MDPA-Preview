// Chromium smoke check for the virtual wind tunnel wizard (Advanced ▸ Virtual wind tunnel…).
//
// `webview/windTunnelPanel.ts` and its wiring in `webview/main.ts` need a DOM,
// so they are untestable under `node:test`; the form is covered by
// `windTunnelHost.test.ts`, the planner and builder by `windTunnelRun.test.ts`
// and `mcpWindTunnel.test.ts`. This drives the REAL webview bundle in the
// screenshot harness: the menu opens the wizard and asks the host for its
// state, an offered body fills the form and posts a plan request, a stale plan
// reply is dropped while the current one fills the live cards, an incomplete
// form posts nothing and names the field, Generate posts the exact request with
// the output choice, progress and the result render and Open posts the mesh
// path, and a sibling dock panel dismisses the wizard. The harness has no host,
// so replies are dispatched as `message` events.
//
// Setup and run (playwright is deliberately not a repo dependency):
//   npm run compile && npm run build:tests
//   NODE_PATH=/path/to/node_modules node scripts/screenshots/check-wind-tunnel.mjs
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

// A realistic plan from the real planner, so the cards show real numbers.
const { icosphere } = require(path.join(ROOT, "out", "test", "fixtures", "shapes.js"));
const { planWindTunnel, summarizePlan } = require(path.join(ROOT, "out", "problemtype", "windTunnel", "plan.js"));
const { windTunnelCase } = require(path.join(ROOT, "out", "problemtype", "windTunnel", "caseState.js"));
const plan = planWindTunnel({ flow: { speed: 30 }, tunnel: { ground: "slip", clearance: 0.1 }, mesh: { surfaceSize: 0.1 } }, icosphere(0.5, 3));
const planView = { ...summarizePlan(plan), case: windTunnelCase(plan).notes };

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
await page.waitForTimeout(3000);

const sent = () => page.evaluate(() => window.SENT_MESSAGES.slice());
const sentOf = async (type) => (await sent()).filter((m) => m.type === type);
const host = (msg) => page.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: m })), msg);
const panel = () => page.evaluate(() => document.getElementById("wind-tunnel-panel")?.textContent ?? "");
const visible = () => page.evaluate(() => document.getElementById("wind-tunnel-panel").style.display !== "none");
const click = (label) =>
  page.evaluate((l) => {
    const all = [...document.querySelectorAll("#wind-tunnel-panel button")];
    const b = all.find((x) => x.textContent.trim() === l) ?? all.find((x) => x.textContent.trim().endsWith(l));
    if (!b) throw new Error(`no button "${l}"`);
    b.click();
  }, label);
const inputs = () => page.evaluate(() => [...document.querySelectorAll('#wind-tunnel-panel input[type="text"]')].map((i) => i.value));
const type = (index, value) =>
  page.evaluate(
    ({ index, value }) => {
      const el = document.querySelectorAll('#wind-tunnel-panel input[type="text"]')[index];
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { index, value }
  );

// --- Open from the Advanced menu ---------------------------------------------------
assert.equal(await visible(), false, "closed at first");
await page.evaluate(() => document.querySelector('#advanced-popup [data-action="windTunnel"]').click());
assert.equal(await visible(), true, "the menu item opens the wizard");
assert.equal((await sentOf("windTunnelHello")).length, 1, "it asks the host for its state");
assert.match(await panel(), /1 Body/);
assert.match(await panel(), /5 Generate/);

// --- The host offers a body: the form fills and a plan is requested ---------------------
await host({ type: "windTunnelState", bodyPath: "/data/car.stl", folder: "/data/car_tunnel", stem: "car", building: false });
await page.waitForTimeout(300);
assert.equal((await inputs())[0], "/data/car.stl");
const plans = await sentOf("windTunnelPlan");
assert.ok(plans.length >= 1, "a plan is requested");
const last = plans[plans.length - 1];
assert.equal(last.request.bodyPath, "/data/car.stl");
assert.equal(last.request.flow.speed, 30);
assert.ok(!("outputFolder" in last.request), "a plan does not carry the output choice");

// --- A stale reply is dropped, the current one fills the cards ----------------------------
await host({ type: "windTunnelPlanResult", seq: last.seq - 1, plan: { ...planView, runnable: false } });
await click("2 Tunnel");
await host({ type: "windTunnelPlanResult", seq: (await sentOf("windTunnelPlan")).slice(-1)[0].seq, plan: planView });
assert.match(await panel(), /Blockage \d/);
await page.screenshot({ path: "/tmp/opencode/wizard_tunnel.png" });
await click("4 Mesh");
await page.waitForTimeout(200);
await host({ type: "windTunnelPlanResult", seq: (await sentOf("windTunnelPlan")).slice(-1)[0].seq, plan: planView });
assert.match(await panel(), /First node row/);
assert.match(await panel(), /tetrahedra/);
await page.screenshot({ path: "/tmp/opencode/wizard_mesh.png" });

// --- An incomplete form posts nothing and names the field ----------------------------------
await click("5 Generate");
await page.waitForTimeout(100);
await host({ type: "windTunnelPlanResult", seq: (await sentOf("windTunnelPlan")).slice(-1)[0].seq, plan: planView });
assert.match(await panel(), /Plan/);
await page.screenshot({ path: "/tmp/opencode/wizard_review.png" });
const runsBefore = (await sentOf("windTunnelRun")).length;
await type(0, "");
await click("Generate");
assert.equal((await sentOf("windTunnelRun")).length, runsBefore, "an empty folder posts nothing");
assert.match(await panel(), /Choose the folder/);
await type(0, "/data/car_tunnel");

// --- Generate posts the exact request, progress and result render -------------------------
await click("Generate");
const run = (await sentOf("windTunnelRun")).slice(-1)[0];
assert.equal(run.request.outputFolder, "/data/car_tunnel");
assert.equal(run.request.stem, "car");
assert.equal(run.request.generateCase, true);
assert.equal(run.request.tunnel.ground, "free");
assert.match(await panel(), /Cancel/, "the build offers Cancel");
await host({ type: "windTunnelProgress", seq: run.seq, done: 3, total: 9, label: "Carve the body out of the tunnel" });
assert.match(await panel(), /Carve the body/);
await click("Cancel");
assert.equal((await sentOf("windTunnelCancel")).length, 1);
await host({
  type: "windTunnelResult",
  seq: run.seq,
  result: {
    files: { mesh: "/data/car_tunnel/car.mdpa", body: "/data/car_tunnel/car_body.stl", recipe: "/x", caseState: "/y" },
    report: { tetrahedra: 123456, nodes: 22000, seconds: 40, wallFit: { max: 0.004, mean: 0.0006 }, firstLayer: { requested: 0.002, achieved: 0.0021, yPlus: 55 }, check: { inverted: 0, minAngle: 3.4, maxEdgeRatio: 18, unnamedBoundaryFaces: 0, problems: [] }, warnings: [] },
    problemtype: "fluid",
    caseNotes: [],
  },
});
assert.match(await panel(), /123,456 tetrahedra/);
assert.match(await panel(), /y\+ about 55/);
await page.screenshot({ path: "/tmp/opencode/wizard_built.png" });
await click("Open the mesh");
assert.equal((await sentOf("windTunnelOpen")).slice(-1)[0].path, "/data/car_tunnel/car.mdpa");

// --- A refusal from the host shows, with the overwrite hint -----------------------------
await click("Generate");
const run2 = (await sentOf("windTunnelRun")).slice(-1)[0];
await host({ type: "windTunnelResult", seq: run2.seq, message: "car.mdpa already exist in /data/car_tunnel." });
assert.match(await panel(), /Tick Overwrite/);

// --- A sibling dock panel dismisses the wizard -----------------------------------------
await page.evaluate(() => document.querySelector('#advanced-popup [data-action="meshSize"]').click());
assert.equal(await visible(), false, "another left-dock panel dismisses the wizard");
await page.evaluate(() => document.querySelector('#advanced-popup [data-action="windTunnel"]').click());
assert.equal((await inputs())[0], "/data/car_tunnel", "the draft survives a dismissal");

await browser.close();
assert.deepEqual(errors, [], "no page errors");
console.log("wind tunnel wizard: OK");
