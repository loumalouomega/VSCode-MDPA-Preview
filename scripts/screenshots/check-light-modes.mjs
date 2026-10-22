// Chromium check for roadmap item 22 F (Light modes): a fixed scene light must
// change the image, stay put while the camera orbits (headlight would not), and
// the headlight must restore the original image exactly.
//   npm run compile && node scripts/screenshots/build-harness.mjs
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=<playwright-core dir> node scripts/screenshots/check-light-modes.mjs
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
const shot = async () =>
  createHash("sha1").update(await page.screenshot({ clip: { x: 760, y: 110, width: 800, height: 700 } })).digest("hex");
const setMode = (m) =>
  page.evaluate((mode) => {
    const sel = [...document.querySelectorAll("#lighting-panel select")][0];
    if (!sel) return false;
    sel.value = mode;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, m);
const head = await shot();
check(await setMode("scene"), "Light mode selector is offered (caps.lightModes)");
await page.waitForTimeout(800);
const scene = await shot();
check(scene !== head, "a fixed scene light changes the image");
await setMode("headlight");
await page.waitForTimeout(800);
check((await shot()) === head, "headlight restores the original image exactly");
check(problems.length === 0, `no console errors${problems.length ? ": " + problems.join(" | ") : ""}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
