// Captures the Advanced section's "Mesh analysis and region tools" panel for
// doc/guide/mesh-analysis.md: the quality-gate thresholds, the Hausdorff
// comparison, the feature-edge options, the periodic-node pairing fields and
// the region-algebra row, with example inputs filled.
//
// The host does not exist in the harness, so no analysis is run: the shot
// shows the panel's inputs, exactly as the form screenshots in
// doc/guide/mesh-editing.md show forms. Assertions guard against a silent
// empty shot.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/opencode/pw && cd /tmp/opencode/pw && npm i playwright-core
// Then from the repo root:
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/opencode/pw/node_modules node scripts/screenshots/capture-analysis.mjs
//
// Output: images/analysis-tools.png (3360×2000 = 1680×1000 @2x, dark theme).
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
  // Chromium comes from PLAYWRIGHT_EXE when set (a cached ms-playwright
  // build), else playwright-core's own bundled resolution.
  const launchOpts = { args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] };
  if (process.env.PLAYWRIGHT_EXE) launchOpts.executablePath = process.env.PLAYWRIGHT_EXE;
  const browser = await chromium.launch(launchOpts);
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

  // Expand the Advanced group, then open the analysis <details>.
  await click("#advanced-header .panel-chevron");
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => {
    const details = Array.from(document.querySelectorAll("#advanced-body details")).find((d) =>
      d.querySelector("summary")?.textContent?.includes("Mesh analysis")
    );
    if (!details) return false;
    if (!details.open) {
      details.querySelector("summary")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      details.open = true;
    }
    return true;
  });
  if (!opened) throw new Error("Could not find the Mesh analysis details element.");
  await page.waitForTimeout(200);

  // Fill the periodic pairing row with an example; the other rows keep their
  // defaults (30° feature angle, complete-pairing required).
  const filled = await page.evaluate(() => {
    const host = document.getElementById("analysis-tools");
    if (!host) return { host: false };
    const byLabel = (text) => {
      const label = Array.from(host.querySelectorAll("label")).find((l) =>
        l.textContent?.startsWith(text)
      );
      return label?.querySelector("input") ?? null;
    };
    const slave = byLabel("Slave SubModelPart");
    const master = byLabel("Master SubModelPart");
    if (slave) slave.value = "Inlet";
    if (master) master.value = "Outlet";
    const buttons = Array.from(host.querySelectorAll("button")).map((b) => b.textContent);
    return { host: true, slave: Boolean(slave), master: Boolean(master), buttons };
  });
  console.log(JSON.stringify(filled, null, 2));
  if (!filled.host || !filled.slave || !filled.master) {
    throw new Error(`Analysis panel did not render as expected: ${JSON.stringify(filled)}`);
  }
  for (const want of ["Check quality", "Compare surfaces", "Preview feature edges", "Match periodic nodes"]) {
    if (!filled.buttons.includes(want)) throw new Error(`Missing button: ${want}`);
  }

  await page.evaluate(() => {
    document.getElementById("analysis-tools")?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(200);

  const out = path.join(ROOT, "images", "analysis-tools.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
