// Chromium check for roadmap item 39 (step through entities under the cursor).
//   npm run compile && node scripts/screenshots/build-harness.mjs
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=<playwright-core dir> node scripts/screenshots/check-pick-stack.mjs
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { chromium } = require("playwright-core");
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };

const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.querySelector('[data-action="inspect"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const box = await page.evaluate(() => { const r = document.getElementById("render-root").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
await page.mouse.move(box.x + box.w / 2 + 1, box.y + box.h / 2 + 1);
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(300);
const msg = await page.evaluate(() => document.getElementById("message")?.textContent ?? "");
check(/\d+ of \d+ under the cursor/.test(msg), `ArrowDown reports the stack (${msg})`);
await page.mouse.move(box.x + 20, box.y + 20);
await page.keyboard.press("ArrowDown");
check(errors.length === 0, `no page errors ${errors.join("; ")}`);
await browser.close();
if (failures.length) { console.error(`${failures.length} failure(s)`); process.exit(1); }
