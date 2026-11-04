// Captures images/meshio181-forms.png: the sidebar forms of the meshio++ 18.1.0
// in-place operations (Untangle, Morph, Geodesic distance) opened and filled the
// way a user would, in the webview harness.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-meshio181-forms.mjs
//
// Output: images/meshio181-forms.png (3360×2000 = 1680×1000 @2x, dark theme).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolvePlaywright() {
  for (const c of ["playwright-core", path.join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error("playwright-core not found — install it and pass NODE_PATH (see the header comment).");
}

// The averageField scene carries a hex block with fields, which the field-driven forms need.
execFileSync("node", [path.join(ROOT, "scripts", "screenshots", "build-harness.mjs")], {
  env: { ...process.env, HARNESS_SCENE: "op", HARNESS_OP: "averageField" },
  stdio: "pipe",
});

const { chromium } = resolvePlaywright();
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(3500);

const staged = await page.evaluate(() => {
  const click = (el) => el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  // Collapse everything above so the forms have the room.
  for (const s of ["problemtype", "view-layers", "edit", "variables"]) click(document.querySelector(`.sb-section[data-section="${s}"] .sb-section-header .panel-chevron`));
  const host = document.getElementById("untangle-form")?.closest(".sb-subsection");
  if (host?.classList.contains("collapsed")) click(host.querySelector(".sb-subsection-header"));
  const set = (id, v) => { const el = document.getElementById(id); if (!el) throw new Error(`no #${id}`); if (el.type === "checkbox") el.checked = v; else el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
  for (const op of ["untangle", "morph", "geodesicDistance"]) click(document.getElementById(`${op}-form`)?.querySelector(".edit-form-title"));
  set("f181-untangle-frozenPart", "Inlet");
  set("f181-untangle-rings", "2");
  set("f181-morph-variable", "DISPLACEMENT");
  set("f181-morph-steps", "3");
  set("f181-geodesicDistance-sourceNodes", "1, 2");
  set("f181-geodesicDistance-output", "GEODESIC_DISTANCE");
  document.getElementById("untangle-form")?.scrollIntoView({ block: "start" });
  return ["untangle-form", "morph-form", "geodesicDistance-form"].map((id) => [id, document.getElementById(id)?.classList.contains("collapsed") === false]);
});
console.log(JSON.stringify(staged));
if (staged.some(([, open]) => !open)) throw new Error("a form did not open — refusing to write a misleading shot");
await page.waitForTimeout(600);
const target = path.join(ROOT, "images", "meshio181-forms.png");
await page.screenshot({ path: target });
console.log(`Wrote ${target}`);
await browser.close();
