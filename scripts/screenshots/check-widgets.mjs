// Chromium check for roadmap item 22 C (interactive widgets): the Clip plane
// handle. Dragging it with the real pointer must move the clip (slider, state,
// cap) exactly as the slider does, and moving the slider must move the handle.
//   npm run compile && node scripts/screenshots/build-harness.mjs
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=<playwright-core dir> node scripts/screenshots/check-widgets.mjs
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { chromium } = require("playwright-core");
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const problems = [];
page.on("pageerror", (e) => problems.push(e.message));
page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(3000);
// The default view looks straight down the clip normal, where dragging along
// the normal is degenerate (vtk.js returns no movement), so take the isometric view.
await page.keyboard.press("i");
await page.waitForTimeout(800);
const probe = (frac) => page.evaluate((f) => window.__clipHandleProbe?.(f), frac);
check((await probe())?.active === false, "clip starts off");
await page.evaluate(() => document.getElementById("cut-toggle")?.click());
await page.waitForTimeout(1500);
const on = await probe();
check(on?.active === true, "clip on");
const sliderT = () => page.evaluate(() => Number(document.getElementById("cut-slider")?.value));
const t0 = await sliderT();
const shot = async () =>
  createHash("sha1").update(await page.screenshot({ clip: { x: 340, y: 110, width: 1000, height: 700 } })).digest("hex");
const before = await shot();
// Slider -> handle: the handle's screen position follows the plane.
await page.evaluate(() => {
  const s = document.getElementById("cut-slider");
  s.value = "30";
  s.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(1200);
const moved = await probe();
check(Math.abs(moved.y - on.y) > 1 || Math.abs(moved.x - on.x) > 1, `slider moves the handle (${on.x.toFixed(0)},${on.y.toFixed(0)} -> ${moved.x.toFixed(0)},${moved.y.toFixed(0)})`);
check((await shot()) !== before, "the scene changed with the slider");
// Handle -> clip: press somewhere on the plane (the origin sphere drags within
// the plane, the plane surface drags along its normal), scanning for a hit.
let start;
let gx;
let gy;
for (const frac of [0.1, 0.2, 0.3, 0.4, 0.5]) {
  const p = await probe(frac);
  await page.mouse.move(p.plane.x, p.plane.y);
  await page.waitForTimeout(500);
  const n0 = await page.evaluate(() => window.__widgetInteractions ?? 0);
  await page.mouse.down();
  await page.waitForTimeout(100);
  const n1 = await page.evaluate(() => window.__widgetInteractions ?? 0);
  if (n1 > n0) {
    start = p;
    gx = p.plane.x;
    gy = p.plane.y;
    break;
  }
  await page.mouse.up();
}
check(start !== undefined, "a press on the plane reaches the widget");
const tBefore = await sliderT();
if (start) {
  await page.mouse.move(gx, gy - 30, { steps: 6 });
  await page.mouse.move(gx, gy - 60, { steps: 6 });
  await page.mouse.up();
}
await page.waitForTimeout(1200);
const end = await probe();
const tAfter = await sliderT();
check(Math.abs(tAfter - tBefore) > 0.5, `dragging the handle moves the clip slider (${tBefore.toFixed(1)} -> ${tAfter.toFixed(1)})`);
check(Math.abs(end.t * 100 - tAfter) < 1, "slider and clip state agree after the drag");
check(t0 !== undefined, "slider readable");
await page.screenshot({ path: "/tmp/widgets.png" });
// --- Measure angle and the extendable probe polyline (native, node-snapped) ---
await page.evaluate(() => document.getElementById("cut-toggle")?.click()); // clip off
await page.waitForTimeout(800);
await page.evaluate(() => document.querySelector('#toolbar button[data-action="inspect"]')?.click());
await page.waitForTimeout(500);
const clickText = (re) =>
  page.evaluate((src) => {
    const b = [...document.querySelectorAll("#inspect-panel button")].find((x) => new RegExp(src).test(x.textContent));
    b?.click();
    return !!b;
  }, re.source);
check(await clickText(/Measure/), "Measure button");
check(await clickText(/^Angle$/), "Angle mode offered while measuring");
const pts = [
  [1100, 430],
  [1000, 520],
  [1180, 350],
];
for (const [x, y] of pts) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(500);
}
const panel = await page.evaluate(() => document.getElementById("inspect-panel")?.textContent ?? "");
check(/Angle at node \d+\.?\d*°/.test(panel) && /Angle: node \d+ → \d+ → \d+/.test(panel), "three picks report an angle at the middle node");
check(/Path a–b–c/.test(panel), "path length row shown");
await clickText(/Measure/); // measure off
await clickText(/Probe line/);
for (const [x, y] of pts) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(500);
}
// The mesh has no nodal field, so no profile is requested; the Inspect hint
// shows that picks now extend the polyline instead of starting a new one.
const hint = await page.evaluate(() => document.getElementById("inspect-panel")?.textContent ?? "");
check(/extend the probe line/.test(hint), "after two picks further picks extend the probe polyline");
check(problems.length === 0, `no console errors${problems.length ? ": " + problems.join(" | ") : ""}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
