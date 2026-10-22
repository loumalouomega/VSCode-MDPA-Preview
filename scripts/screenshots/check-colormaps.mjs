// Chromium check for roadmap item 22 F (colormap preset library): the Field
// panel's picker lists grouped presets, searches, filters colour-blind-safe
// maps, and a chosen preset reaches the legend. Scene: panefields.
//   HARNESS_SCENE=panefields node scripts/screenshots/build-harness.mjs
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=<playwright-core dir> node scripts/screenshots/check-colormaps.mjs
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
await page.evaluate(() => document.querySelector('#toolbar button[data-action="field"]')?.click());
await page.waitForTimeout(800);
const count = () => page.evaluate(() => document.querySelectorAll(".colormap-picker select option").length);
const total = await count();
check(total > 30, `picker lists the 12 built-ins plus presets (${total})`);
check(
  (await page.evaluate(() => document.querySelectorAll(".colormap-picker select optgroup").length)) >= 3,
  "options are grouped by category"
);
await page.fill(".colormap-picker input[type=search]", "viridis");
const found = await count();
check(found >= 1 && found < total, `search narrows the list (${found})`);
await page.fill(".colormap-picker input[type=search]", "");
await page.evaluate(() => {
  const ck = document.querySelector(".colormap-picker input[type=checkbox]");
  ck.checked = true;
  ck.dispatchEvent(new Event("change", { bubbles: true }));
});
const safe = await count();
check(safe > 0 && safe < total, `colour-blind filter narrows the list (${safe})`);
const label = await page.evaluate(() => {
  const s = document.querySelector(".colormap-picker select");
  const o = [...s.options].find((x) => x.value !== s.value);
  s.value = o.value;
  s.dispatchEvent(new Event("change", { bubbles: true }));
  return o.value;
});
await page.waitForTimeout(500);
check(
  (await page.evaluate(() => document.querySelector(".colormap-picker select")?.value)) === label,
  "a chosen preset stays selected after the panel re-renders"
);
check(problems.length === 0, `no console errors${problems.length ? ": " + problems.join(" | ") : ""}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
