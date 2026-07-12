// Captures documentation screenshots from the standalone webview harness
// (see build-harness.mjs). Uses playwright-core + a playwright-managed
// Chromium; WebGL renders through SwiftShader so no GPU is needed.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture.mjs
//
// Output: images/problemtype.png (3360×2000 = 1680×1000 @2x, dark theme,
// matching the other feature screenshots).
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
  const harness = path.join(ROOT, "out", "screenshot-harness", "index.html");
  await page.goto(`file://${harness}`);
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  // Let the vtk.js scene render and the sidebar populate.
  await page.waitForTimeout(4000);

  await page.evaluate(() => {
    // Focus the shot on the Problemtype section: collapse Edit + Mesh
    // Modification, widen the sidebar so form labels don't truncate.
    for (const name of ["edit", "mesh-mod"]) {
      const header = document.querySelector(
        `.sb-section[data-section="${name}"] .sb-section-header`
      );
      header?.click();
    }
    document
      .querySelector('.sb-section[data-section="problemtype"]')
      ?.scrollIntoView({ block: "start" });
  });
  // Fit the camera to the mesh (the resize from the wider sidebar settles too).
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const fit = [...document.querySelectorAll("#nav-controls button")].find(
      (b) => b.textContent?.trim() === "Fit"
    );
    fit?.click();
  });
  await page.waitForTimeout(1500);

  const out = path.join(ROOT, "images", "problemtype.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
