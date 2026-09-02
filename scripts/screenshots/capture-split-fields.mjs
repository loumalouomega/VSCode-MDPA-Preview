// Captures the per-pane field settings screenshot: two panes of one mesh, each
// coloured by a DIFFERENT variable. Companion to capture-split-view.mjs (which
// documents the camera-only half of the split view).
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   HARNESS_SCENE=panefields node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-split-fields.mjs
//
// Output: images/split-view-fields.png (3360×2000 = 1680×1000 @2x, dark theme).
//
// It FAILS rather than writing a misleading shot if the two panes did not
// actually land on different variables — the failure mode here is silent (one
// global field would simply look like a symmetric picture), which is the same
// reason capture-beams.mjs refuses to write unless the rendering is really on.
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
  await page.waitForTimeout(3000);

  await page.evaluate(() => {
    for (const name of ["edit", "mesh-mod", "problemtype"]) {
      document
        .querySelector(`.sb-section[data-section="${name}"] .sb-section-header`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });

  // Side by side, then the Field panel — which always edits the focused pane.
  await page.click('#toolbar button[data-action="viewMenu"]');
  await page.waitForTimeout(200);
  await page.click('#view-popup [data-action="layout:1x2"]');
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.click('#toolbar button[data-action="field"]');
  await page.waitForTimeout(400);

  const canvas = await page.$eval("#render-root canvas", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  // A press+release inside a pane latches it as the focused one (main.ts's
  // latchFocusedPane) and refreshes the panel to describe it.
  const focusPane = async (fx) => {
    await page.mouse.move(canvas.x + canvas.width * fx, canvas.y + canvas.height * 0.5);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  // The first select in the panel is the variable picker; its option labels
  // carry the kind and width, so match on the value (the FieldInfo key).
  const pickVariable = async (variable) => {
    const value = await page.$eval(
      "#field-panel select",
      (sel, name) =>
        [...sel.options].find((o) => o.textContent.startsWith(`${name} (`))?.value ?? "",
      variable
    );
    if (!value) throw new Error(`no ${variable} option in the field panel`);
    await page.selectOption("#field-panel select", value);
    await page.waitForTimeout(600);
  };

  // Each pane: give it the focus, colour it (the panel edits whichever pane the
  // pointer last touched), then aim its camera. Colouring FIRST, because the
  // panel is only re-rendered on a canvas pointerup — so the last thing done to
  // a pane must be a canvas interaction if the panel is to describe it.
  await focusPane(0.25);
  await pickVariable("TEMPERATURE");
  await page.keyboard.press("i");
  await page.click('#toolbar button[data-action="reset"]');
  await page.waitForTimeout(300);
  await focusPane(0.25);

  await focusPane(0.75);
  await pickVariable("PRESSURE");
  await page.keyboard.press("i");
  await page.click('#toolbar button[data-action="reset"]');
  await page.waitForTimeout(300);
  // Turn it away from the left pane's angle so the shot cannot be mistaken for
  // a single camera. Ends on the canvas, which is what leaves the panel
  // describing this pane.
  await page.mouse.move(canvas.x + canvas.width * 0.75, canvas.y + canvas.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(
    canvas.x + canvas.width * 0.75 + 60,
    canvas.y + canvas.height * 0.6 + 20,
    { steps: 12 }
  );
  await page.mouse.up();
  await page.waitForTimeout(300);
  // Pull back so the rotated pane stays inside its half. The nav card is a DOM
  // overlay outside #render-root, so clicking it produces no canvas pointer
  // event and the latched pane is still this one.
  for (let i = 0; i < 2; i++) {
    await page.click('#nav-controls button[title="Zoom out"]');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => ({
    panes: document.querySelectorAll("#pane-chrome .pane-box").length,
    paneLabel: document.querySelector(".field-pane-label")?.textContent ?? "",
    selected: document.querySelector("#field-panel select")?.value ?? "",
  }));
  console.log(JSON.stringify(state, null, 2));
  if (state.panes !== 2) throw new Error(`expected 2 panes, got ${state.panes}`);
  if (state.paneLabel !== "Pane 2 of 2") {
    throw new Error(`panel is not addressing pane 2 (label: "${state.paneLabel}")`);
  }
  if (!state.selected.includes("PRESSURE")) {
    throw new Error(`focused pane is not on PRESSURE (selected: "${state.selected}")`);
  }

  const out = path.join(ROOT, "images", "split-view-fields.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
