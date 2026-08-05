// Captures the SubModelPart outline row's "organize" menu — New child / Move
// under / Merge into / Edit membership — for doc/guide/mesh-editing.md.
// Companion to capture-normals.mjs — same setup, different action.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs      # the default structural scene
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-organize.mjs
//
// Output: images/organize-submodelpart.png (3360×2000 = 1680×1000 @2x, dark theme).
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

  // Collapse the busy sidebar sections so the outline + menu carry the shot.
  await page.evaluate(() => {
    for (const name of ["edit", "mesh-mod", "problemtype"]) {
      document
        .querySelector(`.sb-section[data-section="${name}"] .sb-section-header`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  await page.waitForTimeout(300);

  // Open the organize menu on a real SubModelPart row (double_arch.mdpa's
  // first Parts group), then fill Edit membership so the shot shows a real
  // kind + id list rather than an empty placeholder.
  const opened = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".outline-row"));
    const row = rows.find((r) => r.querySelector(".outline-label")?.textContent?.includes("Parts_Parts_Auto1"));
    const btn = row?.querySelector(".outline-organize-btn");
    if (!btn) return { found: false, labels: rows.map((r) => r.querySelector(".outline-label")?.textContent) };
    btn.scrollIntoView({ block: "center" });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { found: true };
  });
  if (!opened.found) {
    throw new Error(
      `Could not find the Parts_Parts_Auto1 row's organize button. Rows seen: ${JSON.stringify(opened.labels)}`
    );
  }
  await page.waitForTimeout(300);

  const filled = await page.evaluate(() => {
    const kindSelect = document.querySelector(".outline-membership-kind");
    const idsInput = document.querySelector(".outline-membership-row .outline-label-input");
    if (!kindSelect || !idsInput) return false;
    kindSelect.value = "nodes";
    idsInput.value = "1,2,5-8";
    idsInput.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  });
  if (!filled) {
    throw new Error("Edit membership fields did not render — the organize menu may not have opened.");
  }
  await page.waitForTimeout(300);

  // Report what actually rendered, so a silent failure cannot pass as a shot.
  const state = await page.evaluate(() => ({
    groups: Array.from(document.querySelectorAll(".outline-export-group")).map((g) => g.textContent),
  }));
  console.log(JSON.stringify(state, null, 2));
  const expected = ["New child", "Move under", "Merge into", "Edit membership"];
  if (expected.some((g) => !state.groups.includes(g))) {
    throw new Error(`Organize menu is missing a group — expected ${JSON.stringify(expected)}, got ${JSON.stringify(state.groups)}`);
  }

  const out = path.join(ROOT, "images", "organize-submodelpart.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
