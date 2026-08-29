// Captures the Beams (line-element tube rendering) screenshot from the webview
// harness. Companion to capture-spheres.mjs — same setup, the 1D counterpart.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   HARNESS_MESH=src/test/fixtures/mdpa/beam_frame.mdpa node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-beams.mjs
//
// Output: images/beams.png (3360×2000 = 1680×1000 @2x, dark theme).
//
// The fixture is chosen to show every rule at once: thick members and thin
// braces resolving DIFFERENT sections out of one merged EntityBlock, one
// element on a property with no CROSS_AREA falling back to the constant, and a
// LineCondition2D2N that stays a plain line.
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
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE:", m.text());
  });

  const harness = path.join(ROOT, "out", "screenshot-harness", "index.html");
  await page.goto(`file://${harness}`);
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForTimeout(4000);

  // Open the Beams panel (it lives under the Advanced toolbar menu). The tubes
  // themselves are already drawn: a mesh whose line ELEMENTS declare a section
  // renders them without being asked.
  await page.evaluate(() => {
    document
      .querySelector('#advanced-popup button[data-action="beams"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(800);

  // Tilt off-axis: the fixture is planar, and face-on the tubes read as flat
  // bars rather than as round sections. The rotate buttons auto-repeat from
  // mousedown, so pair each with a mouseup (capture-op.mjs does the same).
  await page.evaluate(() => {
    const nav = document.getElementById("nav-controls");
    [...(nav?.querySelectorAll("button.nav-step-btn") ?? [])]
      .find((b) => b.textContent?.trim() === "15°")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (const label of ["Rotate left", "Rotate up"]) {
      const btn = nav?.querySelector(`button[aria-label="${label}"]`);
      btn?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const fit = [...document.querySelectorAll("#nav-controls button")].find(
      (b) => b.textContent?.trim() === "Fit"
    );
    fit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(1200);

  // Fit centres in the WHOLE canvas, but the panel covers its left third, so
  // the frame lands clipped. Back off one step for margin.
  await page.evaluate(() => {
    const nav = document.getElementById("nav-controls");
    const out = nav?.querySelector('button[aria-label="Zoom out"]');
    out?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitForTimeout(1200);

  // Report what actually rendered, so a silent failure cannot pass as a shot.
  const state = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("#beam-panel .meshsize-mode-btn")];
    return {
      panelOpen: getComputedStyle(document.getElementById("beam-panel")).display !== "none",
      panelText: document.getElementById("beam-panel")?.textContent?.slice(0, 200) ?? "",
      // The tubes must actually be ON: a silent failure to draw them would
      // otherwise pass as a screenshot of the plain-line rendering.
      showBeamsActive: btns.find((b) => b.textContent === "Show beams")?.classList.contains("active"),
    };
  });
  console.log(JSON.stringify(state, null, 2));
  if (!state.panelOpen || !state.showBeamsActive) {
    throw new Error("the beam rendering is not on — refusing to write a misleading shot");
  }

  const out = path.join(ROOT, "images", "beams.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
