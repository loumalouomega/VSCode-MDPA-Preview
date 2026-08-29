// Captures the Advanced ▸ Data table screenshot from the webview harness.
// Companion to capture.mjs / capture-normals.mjs — same setup, different action.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs      # the default structural scene
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-data-table.mjs
//
// Output: images/data-table.png (3360×2000 = 1680×1000 @2x, dark theme).
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

  const click = (sel) =>
    page.evaluate(
      (s) => document.querySelector(s)?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      sel
    );

  // Collapse the busy sidebar sections so the table carries the shot.
  await page.evaluate(() => {
    for (const name of ["edit", "mesh-mod", "problemtype"]) {
      document
        .querySelector(`.sb-section[data-section="${name}"] .sb-section-header`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  await page.waitForTimeout(500);

  await click('#toolbar button[data-action="advanced"]');
  await page.waitForTimeout(300);
  await click('#advanced-popup button[data-action="dataTable"]');
  await page.waitForTimeout(800);

  // Elements, so the shot shows a block and a connectivity column rather than
  // four numeric columns that could be any table at all.
  await click("#data-table-panel .meshsize-modes button:nth-child(2)");
  await page.waitForTimeout(600);
  // ...and a selected row, since the marker in the scene is half the feature.
  await click("#data-table-panel .dt-window .dt-row:nth-child(6)");
  await page.waitForTimeout(400);
  // Frame it, then pull back a little: framed alone, a single tetrahedron fills
  // the viewport with flat colour and the shot shows no mesh at all, while a
  // fitted whole mesh makes the highlighted element a couple of pixels.
  await page.evaluate(() => {
    [...document.querySelectorAll("#data-table-panel .dt-options button")]
      .find((b) => b.textContent?.trim() === "Frame")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(600);
  // A real click: the zoom buttons are press-and-hold (mousedown/mouseup), so a
  // synthetic "click" event alone would do nothing.
  for (let i = 0; i < 2; i++) {
    await page.click('#nav-controls button[title="Zoom out"]');
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1200);

  // Report what actually rendered, so a silent failure cannot pass as a shot.
  const state = await page.evaluate(() => {
    const p = document.getElementById("data-table-panel");
    return {
      columns: [...p.querySelectorAll(".dt-head .dt-cell")].map((e) => e.textContent),
      rows: p.querySelectorAll(".dt-window .dt-row").length,
      selected: p.querySelectorAll(".dt-row.selected").length,
    };
  });
  console.log(JSON.stringify(state, null, 2));
  if (state.rows === 0 || state.selected !== 1) {
    throw new Error(`the table did not render as expected: ${JSON.stringify(state)}`);
  }

  const out = path.join(ROOT, "images", "data-table.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
