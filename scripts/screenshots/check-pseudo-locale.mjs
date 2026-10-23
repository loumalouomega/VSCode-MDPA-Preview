// Chromium check for the pseudo-locale (roadmap item 15): the chrome rendered
// with every string lengthened ~40 % and bracketed must not clip.
//   HARNESS_LOCALE=qps-ploc node scripts/screenshots/build-harness.mjs
//   NODE_PATH=<dir with playwright-core>/node_modules node scripts/screenshots/check-pseudo-locale.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const harnessDir = path.resolve(process.cwd(), "out/screenshot-harness");

function chromiumOf() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const base of [path.join(process.env.HOME ?? "~", ".cache", "ms-playwright"), "/opt/pw-browsers"]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

const browser = await chromium.launch({ executablePath: chromiumOf(), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let failed = false;
for (const theme of ["dark", "light", "hc"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.evaluate((t) => { document.body.dataset.theme = t; document.getElementById("sidebar").style.width = "176px"; }, theme);
  await page.waitForTimeout(500);
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll("#sidebar button, #sidebar label, #toolbar button, #menubar button")]
      .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible" && e.clientWidth > 0)
      .map((e) => (e.id || e.textContent || "").trim().slice(0, 40)));
  const bracketed = await page.evaluate(() => (document.getElementById("toolbar")?.innerText ?? "").includes("["));
  if (clipped.length || !bracketed) { failed = true; console.error(theme, "clipped:", clipped, "bracketed:", bracketed); }
  else console.log(theme, "ok");
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
