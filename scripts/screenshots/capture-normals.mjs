// Captures the Advanced ▸ Face normals screenshot from the webview harness.
// Companion to capture.mjs — same setup, different action.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs      # the default structural scene
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-normals.mjs
//
// Output: images/face-normals.png (3360×2000 = 1680×1000 @2x, dark theme).
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

  // Collapse the busy sidebar sections so the viewport carries the shot.
  await page.evaluate(() => {
    for (const name of ["edit", "mesh-mod", "problemtype"]) {
      document
        .querySelector(`.sb-section[data-section="${name}"] .sb-section-header`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  await click("#nav-controls button"); // no-op guard if the panel is absent
  await page.evaluate(() => {
    [...document.querySelectorAll("#nav-controls button")]
      .find((b) => b.textContent?.trim() === "Fit")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(1000);

  await click('#toolbar button[data-action="advanced"]');
  await page.waitForTimeout(300);
  await click('#advanced-popup button[data-action="normals"]');
  await page.waitForTimeout(3000);

  // Report what actually rendered, so a silent failure cannot pass as a shot.
  const state = await page.evaluate(() => ({
    message: document.getElementById("message")?.textContent ?? "",
  }));
  console.log(JSON.stringify(state, null, 2));
  if (!/face normals/.test(state.message)) {
    throw new Error(`normals did not render — status line was ${JSON.stringify(state.message)}`);
  }

  const out = path.join(ROOT, "images", "face-normals.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
