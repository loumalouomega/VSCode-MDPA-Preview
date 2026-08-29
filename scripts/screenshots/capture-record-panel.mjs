// Captures the View ▾ ▸ Record… panel for the docs.
// Companion to capture.mjs / capture-data-table.mjs — same setup.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-record-panel.mjs
//
// Output: images/video-record.png (3360×2000 = 1680×1000 @2x, dark theme).
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolvePlaywright() {
  for (const candidate of [
    "playwright-core",
    path.join(process.env.NODE_PATH ?? "", "playwright-core"),
  ]) {
    try {
      return require(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error(
    "playwright-core not found — install it and pass NODE_PATH (see the header comment)."
  );
}

async function main() {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({
    viewport: { width: 1680, height: 1000 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForTimeout(4000);

  await page.evaluate(() => {
    for (const name of ["edit", "mesh-mod", "problemtype"]) {
      document
        .querySelector(`.sb-section[data-section="${name}"] .sb-section-header`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  await page.waitForTimeout(400);

  const click = (sel) =>
    page.evaluate(
      (s) => document.querySelector(s)?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      sel
    );
  await click('#toolbar button[data-action="viewMenu"]');
  await page.waitForTimeout(200);
  await click('#view-popup [data-action="record"]');
  await page.waitForTimeout(600);

  // Record a short turntable so the shot shows the panel in its finished state.
  await page.evaluate(() => {
    const frames = [...document.querySelectorAll("#record-panel input")][1];
    frames.value = "24";
    frames.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => ({
    summary: document.querySelector("#record-panel .meshsize-summary")?.textContent,
    buttons: [...document.querySelectorAll("#record-panel button")].length,
  }));
  console.log(JSON.stringify(state, null, 2));
  if (!state.summary || !state.summary.includes("frames")) {
    throw new Error(`the record panel did not render a plan: ${state.summary}`);
  }

  const out = path.join(ROOT, "images", "video-record.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
