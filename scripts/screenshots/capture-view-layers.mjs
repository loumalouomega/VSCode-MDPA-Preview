// Captures the View Layers screenshot from the webview harness. Companion to
// capture.mjs — same setup, different section.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-view-layers.mjs
//
// Output: images/view-layers.png (3360×2000 = 1680×1000 @2x, dark theme).
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

function chromiumOf() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const fs = require("node:fs");
  const base = path.join(process.env.HOME ?? "~", ".cache", "ms-playwright");
  for (const c of [
    "chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
    "chromium_headless_shell-1234/chrome-linux/headless_shell",
    "chromium-1243/chrome-linux64/chrome",
  ]) {
    const p = path.join(base, c);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function main() {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({
    executablePath: chromiumOf(),
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
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(2500);

  // Build two view layers through the real sidebar form: one from the first
  // block (visible, recoloured), one from the first part (hidden, to show the
  // suppressed state). Fails loudly instead of screenshotting an empty section.
  const built = await page.evaluate(() => {
    const section = document.querySelector('.sb-section[data-section="view-layers"]');
    section?.scrollIntoView({ block: "start" });
    const blockCb = document.querySelector(".vl-block-cb");
    const partCb = document.querySelector(".vl-part-cb");
    const name = document.getElementById("vl-name");
    const add = [...document.querySelectorAll("#view-layers .panel-btn")]
      .find((b) => b.textContent?.includes("Add view layer"));
    if (!section || !name || !add) return { ok: false, reason: "view-layers section or creation form missing" };
    if (!blockCb && !partCb) return { ok: false, reason: "mesh has neither blocks nor parts to snapshot" };
    // Layer one: first block.
    name.value = "Walls";
    if (blockCb) blockCb.checked = true;
    add.click();
    return { ok: true };
  });
  if (!built.ok) throw new Error(`could not create the first view layer: ${built.reason}`);
  await page.waitForTimeout(600);

  const second = await page.evaluate(() => {
    const rows = document.querySelectorAll("#view-layers .vl-row").length;
    if (rows !== 1) return { ok: false, reason: `expected 1 row, found ${rows}` };
    const name = document.getElementById("vl-name");
    const partCb = document.querySelector(".vl-part-cb");
    const add = [...document.querySelectorAll("#view-layers .panel-btn")]
      .find((b) => b.textContent?.includes("Add view layer"));
    if (!name || !add) return { ok: false, reason: "creation form vanished after the first add" };
    name.value = "Probe region";
    document.querySelectorAll(".vl-block-cb").forEach((c) => (c.checked = false));
    if (partCb) partCb.checked = true;
    else {
      const blockCb = document.querySelector(".vl-block-cb");
      if (blockCb) blockCb.checked = true;
    }
    add.click();
    return { ok: true };
  });
  if (!second.ok) throw new Error(`could not create the second view layer: ${second.reason}`);
  await page.waitForTimeout(600);

  // Hide the second layer so the shot shows both states (one tinted group,
  // one suppressed), then fit the camera.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#view-layers .vl-row")];
    const secondRow = rows[1];
    secondRow?.querySelector('input[type="checkbox"]')?.click();
    document.querySelector('.sb-section[data-section="view-layers"]')?.scrollIntoView({ block: "start" });
    document.getElementById("nav-fit")?.click();
  });
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => ({
    rows: document.querySelectorAll("#view-layers .vl-row").length,
    names: [...document.querySelectorAll("#view-layers .vl-name")].map((el) => el.textContent),
    hint: document.getElementById("view-layers-hint")?.textContent?.slice(0, 120) ?? "",
  }));
  console.log(JSON.stringify(state, null, 2));
  if (state.rows !== 2) throw new Error(`expected 2 view-layer rows for the shot, found ${state.rows}`);

  const out = path.join(ROOT, "images", "view-layers.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
