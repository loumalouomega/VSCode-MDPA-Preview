// Captures the "Additional mesh operations" screenshot from the webview
// harness — the Mesh Modification section's six subcategories (Element order
// & topology, Remeshing (MMG), Smoothing & renumbering, Selection &
// combination, Fields, Sphere elements), one of them expanded to show a form.
// Companion to capture.mjs — same setup, different scene.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs      # the default structural scene
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-mesh-operations.mjs
//
// Output: images/mesh-operations.png (3360×2000 = 1680×1000 @2x, dark theme).
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

  // Collapse Edit + Problemtype so Mesh Modification gets the room. All six
  // subcategories start collapsed (the whole point of the reorganization —
  // six clean group titles instead of a flat list of fourteen items), so the
  // shot shows that list, then opens one ("Element order & topology") and one
  // of its forms (Refine) to show what is actually inside a group.
  await page.evaluate(() => {
    for (const name of ["edit", "problemtype"]) {
      document
        .querySelector(`.sb-section[data-section="${name}"] .sb-section-header`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    document
      .querySelector('.sb-section[data-section="mesh-mod"]')
      ?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    document
      .querySelector('.sb-subsection[data-subsection="topology"] .sb-subsection-header')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(300);

  // Expand the Refine form by its title (data-op lives on the Apply button).
  await page.evaluate(() => {
    document
      .querySelector('[data-op="refine"]')
      ?.closest(".edit-form")
      ?.querySelector(".edit-form-title")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const fit = [...document.querySelectorAll("#nav-controls button")].find(
      (b) => b.textContent?.trim() === "Fit"
    );
    fit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(1500);

  // Report what actually rendered, so a silent failure cannot pass as a shot.
  const state = await page.evaluate(() => ({
    subsections: [...document.querySelectorAll('.sb-section[data-section="mesh-mod"] .sb-subsection')].map(
      (s) => ({ key: s.dataset.subsection, collapsed: s.classList.contains("collapsed") })
    ),
    refineExpanded: !document
      .querySelector('[data-op="refine"]')
      ?.closest(".edit-form")
      ?.classList.contains("collapsed"),
  }));
  console.log(JSON.stringify(state, null, 2));

  const out = path.join(ROOT, "images", "mesh-operations.png");
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
