// Chromium check for roadmap item 22 F (GPU-assisted node labels): a mesh over
// the old 1,000-node cap is labelled, labels survive a 2x2 split, hidden nodes
// are culled by the depth buffer, and nothing raises a console error.
//   npm run compile && node scripts/screenshots/build-harness.mjs
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=<playwright-core dir> node scripts/screenshots/check-gpu-labels.mjs
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
const nodes = await page.evaluate(() => Number(document.querySelector("#stats")?.textContent?.match(/Nodes\s*(\d+)/)?.[1] ?? 0));
check(nodes > 1000, `scene has more nodes than the old label cap (${nodes})`);
await page.evaluate(() => document.querySelector('[data-action="nodeIds"]')?.click());
await page.waitForTimeout(1500);
const stats = () =>
  page.evaluate(() => ({
    shown: Number(document.querySelector("#labels")?.dataset.shown ?? -1),
    occluded: Number(document.querySelector("#labels")?.dataset.occluded ?? -1),
    msg: document.querySelector("#message")?.textContent ?? "",
  }));
let s = await stats();
check(s.shown > 0, `labels drawn above the old cap (${s.shown})`);
check(!/exceed/.test(s.msg), "no label-limit refusal message");
check(s.occluded > 0, `depth buffer culls hidden nodes (${s.occluded} occluded)`);
await page.evaluate(() => document.querySelector('[data-action="layout:2x2"]')?.click());
await page.waitForTimeout(1500);
s = await stats();
check(s.shown > 0 && !/single-pane/.test(s.msg), `labels survive a split layout (${s.shown})`);
check(problems.length === 0, `no console errors${problems.length ? ": " + problems.join(" | ") : ""}`);
await page.screenshot({ path: "/tmp/gpu-labels.png" });
await browser.close();
process.exit(failures.length ? 1 : 0);
