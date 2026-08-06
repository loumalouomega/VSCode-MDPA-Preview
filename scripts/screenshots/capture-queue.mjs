// Captures the Edit section's operation queue — "Queue operations for one
// apply" checked, with a couple of staged steps — for doc/guide/mesh-editing.md.
// Companion to capture-organize.mjs — same setup, different action.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs      # the default structural scene
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-queue.mjs
//
// Output: images/op-queue.png (3360×2000 = 1680×1000 @2x, dark theme).
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

  // Collapse the busy sections so the Edit section's queue carries the shot;
  // expand the Scale form so a real staged row (not just removeOrphanNodes)
  // is visible.
  await page.evaluate(() => {
    for (const name of ["mesh-mod", "problemtype"]) {
      document
        .querySelector(`.sb-section[data-section="${name}"] .sb-section-header`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  await page.waitForTimeout(200);

  await click("#edit-queue-mode");
  await page.waitForTimeout(100);

  // Stage removeOrphanNodes (no inputs needed).
  await click("#edit-remove-orphans");

  // Stage a scale — expand its form, fill it, apply.
  const scaleTitle = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll(".edit-form-title"));
    const t = titles.find((el) => el.textContent?.includes("Scale"));
    t?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return Boolean(t);
  });
  if (!scaleTitle) throw new Error("Could not find the Scale form title.");
  await page.waitForTimeout(100);
  await page.fill("#scale-x", "1.5");
  await page.fill("#scale-y", "1.5");
  await page.fill("#scale-z", "1.5");
  await click('.edit-apply[data-op="scale"]');
  await page.waitForTimeout(200);

  // Report what actually rendered, so a silent failure cannot pass as a shot.
  const state = await page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll("#edit-queue-list .edit-queue-row")).map(
      (r) => r.querySelector(".edit-op-label")?.textContent
    ),
    applyDisabled: document.getElementById("edit-apply-batch")?.disabled,
  }));
  console.log(JSON.stringify(state, null, 2));
  if (state.rows.length !== 2) {
    throw new Error(`Expected 2 queued rows, got ${JSON.stringify(state.rows)}`);
  }
  if (state.applyDisabled !== false) {
    throw new Error("Apply queued steps should be enabled with a non-empty queue.");
  }

  // Scroll the queue block into view for the shot.
  await page.evaluate(() => {
    document.getElementById("edit-queue-list")?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);

  const out = path.join(ROOT, "images", "op-queue.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
