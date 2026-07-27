// Captures the Spheres (particle rendering) screenshot from the webview
// harness. Companion to capture.mjs — same setup, different scene.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   HARNESS_SCENE=spheres node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-spheres.mjs
//
// Output: images/spheres.png (3360×2000 = 1680×1000 @2x, dark theme).
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

  // Open the Spheres panel and expand the Set-element-radius sidebar form, so
  // the shot shows both halves of the feature.
  await page.evaluate(() => {
    // Spheres lives under the Advanced toolbar menu.
    document
      .querySelector('#advanced-popup button[data-action="spheres"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const radiusTitle = document.querySelector("#radius-form .edit-form-title");
    radiusTitle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .querySelector('.sb-section[data-section="mesh-mod"]')
      ?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(800);

  await page.evaluate(() => {
    const fit = [...document.querySelectorAll("#nav-controls button")].find(
      (b) => b.textContent?.trim() === "Fit"
    );
    fit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(2000);

  // Report what actually rendered, so a silent failure cannot pass as a shot.
  const state = await page.evaluate(() => ({
    panelOpen: getComputedStyle(document.getElementById("sphere-panel")).display !== "none",
    panelText: document.getElementById("sphere-panel")?.textContent?.slice(0, 200) ?? "",
    radiusForm: !!document.getElementById("radius-form"),
    advancedBtn: !!document.querySelector('#toolbar button[data-action="advanced"]'),
    advancedItems: [...document.querySelectorAll("#advanced-popup button")].map((b) =>
      b.textContent?.trim()
    ),
  }));
  console.log(JSON.stringify(state, null, 2));

  const out = path.join(ROOT, "images", "spheres.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
