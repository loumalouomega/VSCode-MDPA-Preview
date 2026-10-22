// Chromium check for roadmap item 22 A (ray-cast sphere and stick impostors).
//
// Drives the real webview bundle in the harness and asserts: the sphere (or
// beam) layer draws something, the Detail (tessellation) control is gone because
// the vtk.js backend reports `caps.impostors`, nothing throws or logs a console
// error (a shader that fails to compile does), and the Clip plane still removes
// glyphs.
//
//   npm run compile
//   HARNESS_SCENE=spheres node scripts/screenshots/build-harness.mjs
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=<dir with playwright-core> \
//     node scripts/screenshots/check-impostors.mjs spheres
//   HARNESS_MESH=src/test/fixtures/mdpa/beam_frame.mdpa node scripts/screenshots/build-harness.mjs
//     ... node scripts/screenshots/check-impostors.mjs beams
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mode = process.argv[2] === "beams" ? "beams" : "spheres";
const { chromium } = require("playwright-core");

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text()}`);
});
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(4000);

const panelId = mode === "beams" ? "beam-panel" : "sphere-panel";
await page.evaluate((action) => {
  document
    .querySelector(`#advanced-popup button[data-action="${action}"]`)
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}, mode === "beams" ? "beams" : "spheres");
await page.waitForTimeout(800);
await page.evaluate(() => document.getElementById("nav-fit")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
await page.waitForTimeout(1500);

// Lit pixels in the viewport: anything not the scene background colour.
async function litPixels() {
  const shot = await page.screenshot({ clip: { x: 760, y: 110, width: 900, height: 820 } });
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const bg = [d[0], d[1], d[2]];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) n++;
    }
    return n;
  }, shot.toString("base64"));
}

const panel = await page.evaluate((id) => {
  const el = document.getElementById(id);
  return { open: el && getComputedStyle(el).display !== "none", text: el?.textContent ?? "" };
}, panelId);
check(panel.open, `${mode} panel is open`);
check(!/Detail/.test(panel.text), "Detail (tessellation) control is hidden under impostors");

const before = await litPixels();
check(before > 2000, `${mode} layer draws pixels (${before})`);

// Clip: turn it on, axis X, slide to the middle; glyphs on one side must go.
await page.evaluate(() => {
  const click = (sel) => document.querySelector(sel)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  click("#cut-toggle");
  const x = [...document.querySelectorAll("#cut-axes input")].find((i) => i.value === "0");
  x?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const s = document.getElementById("cut-slider");
  if (s) {
    s.value = "50";
    s.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
await page.waitForTimeout(1500);
const clipped = await litPixels();
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
check(clipped < before * 0.95, `Clip plane removes glyphs (${before} -> ${clipped})`);

check(problems.length === 0, `no page errors or console errors${problems.length ? ": " + problems.join(" | ") : ""}`);
await browser.close();
if (failures.length) process.exit(1);
