// Chromium check for roadmap item 22 E (display-only vtk.js filters): the
// Lighting panel's Smooth shading toggle must change what is drawn, switch back
// to the identical flat image, and raise no console errors.
//   npm run compile && node scripts/screenshots/build-harness.mjs
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=<playwright-core dir> node scripts/screenshots/check-display-filters.mjs
import { spawnSync } from "node:child_process";
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
await page.evaluate(() =>
  document.querySelector('#advanced-popup button[data-action="lighting"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
);
await page.waitForTimeout(500);
const shot = async () => {
  const b = await page.screenshot({ clip: { x: 760, y: 110, width: 800, height: 700 } });
  return createHash("sha1").update(b).digest("hex");
};
const toggle = () =>
  page.evaluate(() => {
    const ck = [...document.querySelectorAll("#lighting-panel label")].find((l) => /Smooth shading/.test(l.textContent))?.querySelector("input");
    if (!ck) return false;
    ck.checked = !ck.checked;
    ck.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
const flat = await shot();
check((await shot()) === flat, "two flat captures are identical (deterministic baseline)");
check(await toggle(), "Smooth shading checkbox is offered (caps.displayFilters)");
await page.waitForTimeout(800);
const smooth = await shot();
check(smooth !== flat, "smooth shading changes the image");
await toggle();
await page.waitForTimeout(800);
check((await shot()) === flat, "switching back restores the flat image exactly");
// --- Relief: a nodal scalar lifts the mesh along Z (scene with two nodal fields) ---
{
  const b = spawnSync("node", [path.join(ROOT, "scripts/screenshots/build-harness.mjs")], {
    env: { ...process.env, HARNESS_SCENE: "panefields" },
    encoding: "utf8",
  });
  if (b.status !== 0) throw new Error(b.stderr || "build-harness failed");
  await page.reload();
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.click('#toolbar button[data-action="field"]');
  await page.waitForSelector("#field-panel", { state: "visible" });
  await page.waitForTimeout(500);
  // Iso view so a Z lift is visible.
  await page.keyboard.press("i");
  await page.waitForTimeout(500);
  const before = await shot();
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("#field-panel .field-modes button")].find((x) => /Deformed/.test(x.textContent));
    btn?.click();
  });
  await page.waitForTimeout(500);
  const picked = await page.evaluate(() => {
    const sel = [...document.querySelectorAll("#field-panel select")].find((x) => [...x.options].some((o) => /height along Z/.test(o.textContent)));
    if (!sel) return false;
    sel.value = [...sel.options].find((o) => /height along Z/.test(o.textContent)).value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  check(picked, "the Deform-by selector offers a nodal scalar as height along Z");
  await page.evaluate(() => {
    const r = document.querySelector("#field-panel .field-subform input[type=range]");
    if (r) {
      r.value = "5";
      r.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await page.waitForTimeout(800);
  check((await shot()) !== before, "relief by a scalar changes the image");
}

check(problems.length === 0, `no page or console errors${problems.length ? ": " + problems.join(" | ") : ""}`);
await browser.close();
if (failures.length) process.exit(1);
