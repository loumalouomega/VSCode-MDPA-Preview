// Captures the View ▾ ▸ Layout split-view screenshot from the webview harness.
// Companion to capture.mjs / capture-data-table.mjs — same setup.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-split-view.mjs
//
// Output: images/split-view.png (3360×2000 = 1680×1000 @2x, dark theme).
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

  // Collapse the busy sidebar sections so the panes carry the shot.
  await page.evaluate(() => {
    for (const name of ["edit", "mesh-mod", "problemtype"]) {
      document
        .querySelector(`.sb-section[data-section="${name}"] .sb-section-header`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  await page.waitForTimeout(400);

  await page.click('#toolbar button[data-action="viewMenu"]');
  await page.waitForTimeout(200);
  await page.click('#view-popup [data-action="layout:2x2"]');
  await page.waitForTimeout(400);
  // A layout row is checkable, so the menu deliberately stays open — close it,
  // or it covers the top-right pane in the shot.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // Give three of the four panes a distinct viewpoint, which is the whole
  // point of the feature and what a single-camera bug would fail to show.
  const canvas = await page.$eval("#render-root canvas", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const drag = async (fx, fy, dx, dy) => {
    await page.mouse.move(canvas.x + canvas.width * fx, canvas.y + canvas.height * fy);
    await page.mouse.down();
    await page.mouse.move(
      canvas.x + canvas.width * fx + dx,
      canvas.y + canvas.height * fy + dy,
      { steps: 12 }
    );
    await page.mouse.up();
    await page.waitForTimeout(400);
  };
  await drag(0.75, 0.25, 90, 30); // top-right
  await drag(0.25, 0.75, -60, 50); // bottom-left
  await drag(0.75, 0.75, 70, -40); // bottom-right (also leaves it focused)

  const state = await page.evaluate(() => ({
    panes: document.querySelectorAll("#pane-chrome .pane-box").length,
    focused: [...document.querySelectorAll("#pane-chrome .pane-box")].findIndex((b) =>
      b.classList.contains("focused")
    ),
  }));
  console.log(JSON.stringify(state, null, 2));
  if (state.panes !== 4) throw new Error(`expected 4 panes, got ${state.panes}`);

  const out = path.join(ROOT, "images", "split-view.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
