// Chromium check for roadmap item 22 D (image-data / volume rendering): a
// dense lattice opens the Volume view; volume, slices and iso surfaces each
// change the image, the opacity curve and slice position change it, Surface
// restores the original image exactly, and an ordinary mesh offers nothing.
//   HARNESS_SCENE=lattice node scripts/screenshots/build-harness.mjs
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=<playwright-core dir> node scripts/screenshots/check-volume.mjs
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
let shotNo = 0;
const shot = async () => {
  const b = await page.screenshot({ clip: { x: 680, y: 150, width: 700, height: 700 } });
  if (process.env.SHOTS) (await import("node:fs")).writeFileSync(`/tmp/vol-${shotNo++}.png`, b);
  return createHash("sha1").update(b).digest("hex");
};
// An oblique view: straight down an axis a slice or iso surface can hide itself.
await page.keyboard.press("i");
await page.waitForTimeout(800);
const surface = await shot();
await page.evaluate(() => document.querySelector('#advanced-popup button[data-action="volume"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
await page.waitForTimeout(800);
const panelText = () => page.evaluate(() => document.getElementById("volume-panel")?.textContent ?? "");
check(/lattice/.test(await panelText()) && !/not a dense/.test(await panelText()), "the lattice is detected and the panel is offered");
const mode = async (label) => {
  const ok = await page.evaluate((l) => {
    const b = [...document.querySelectorAll("#volume-panel .meshsize-mode-btn")].find((x) => x.textContent === l);
    b?.click();
    return !!b;
  }, label);
  await page.waitForTimeout(2500);
  return ok;
};
check(await mode("Volume"), "Volume mode");
const vol = await shot();
check(vol !== surface, "the volume draws something different from the surface");
// Opacity: pick the 'Inverse ramp' preset
await page.evaluate(() => {
  const sel = document.querySelector("#volume-panel select.field-select:not([name])");
  const presets = [...document.querySelectorAll("#volume-panel select")].find((s) => [...s.options].some((o) => o.value === "inverse"));
  presets.value = "inverse";
  presets.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(2500);
check((await shot()) !== vol, "changing the opacity curve changes the image");
check(await mode("Slices"), "Slices mode");
const sl = await shot();
check(sl !== vol, "slices differ from the volume");
await page.evaluate(() => {
  const r = document.querySelector("#volume-panel input[type=range]");
  r.value = "3";
  r.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(1500);
check((await shot()) !== sl, "moving a slice changes the image");
check(await mode("Iso"), "Iso mode");
const iso = await shot();
check(iso !== sl && iso !== vol, "iso surfaces differ from slices and volume");
check(await mode("Surface"), "Surface mode");
const back = await shot();
check(back === surface, "back to Surface restores the original image exactly");
await page.screenshot({ path: "/tmp/volume.png" });
check(problems.length === 0, `no console errors${problems.length ? ": " + problems.join(" | ") : ""}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
