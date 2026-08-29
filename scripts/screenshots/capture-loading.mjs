// Captures the loading overlay for the docs.
//
// The overlay is normally torn down the moment the model lands, so this posts a
// `progress` message to bring it back — which is only possible because the
// markup was hoisted into webviewChrome.ts's LOADING_HTML and the harness now
// renders the same constant the providers do.
//
// Reduced motion is emulated so the mark is captured upright rather than caught
// mid-turn; the rotation itself is verified in the harness, not in a still.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-loading.mjs
//
// Output: images/loading.png (3360×2000 = 1680×1000 @2x, dark theme).
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
    reducedMotion: "reduce",
  });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
  await page.waitForSelector("#app", { timeout: 30000 });
  await page.waitForTimeout(3000);

  // Bring the overlay back with a half-finished read.
  await page.evaluate(() =>
    window.postMessage(
      { type: "progress", phase: "read", bytesRead: 46, totalBytes: 100 },
      "*"
    )
  );
  await page.waitForTimeout(500);

  const state = await page.evaluate(() => {
    const logo = document.getElementById("loading-logo");
    return {
      overlay: getComputedStyle(document.getElementById("loading")).display,
      hasSvg: !!logo?.querySelector("svg"),
      size: logo ? [logo.clientWidth, logo.clientHeight] : null,
      bar: document.getElementById("loading-bar").style.width,
    };
  });
  console.log(JSON.stringify(state, null, 2));
  if (state.overlay === "none" || !state.hasSvg) {
    throw new Error(`the loading overlay did not render its mark: ${JSON.stringify(state)}`);
  }

  const out = path.join(ROOT, "images", "loading.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
