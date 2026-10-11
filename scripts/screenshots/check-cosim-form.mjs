// Chromium smoke check for the generic CoSimulation problemtype's sidebar (roadmap item 16).
//
// `webview/problemtype.ts` renders a declaration's sections, groups and condition
// branches from the spec. A wrong id, a group that names no field, or a condition the
// picker cannot list passes every unit test and fails silently in the real UI. This
// script drives the REAL webview bundle in the screenshot harness, loads the two-physics
// mesh of problemtypeCosim.test.ts, selects the cosim problemtype and asserts on what
// the sidebar shows, on where the catalog lists it, and on the page errors it raised.
//
// Setup and run (playwright is deliberately not a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-cosim-form.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolvePlaywright() {
  for (const c of ["playwright-core", path.join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright-core not found — see the header comment.");
}

// The two-physics mesh of the unit test, read from its source so the two cannot drift.
const testSource = fs.readFileSync(path.join(ROOT, "src", "test", "problemtypeCosim.test.ts"), "utf8");
const mdpa = /const MDPA = `([\s\S]*?)`;/.exec(testSource)?.[1];
assert.ok(mdpa, "the unit test's MDPA fixture is readable");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-cosim-ui-"));
const meshPath = path.join(workspace, "flap.mdpa");
fs.writeFileSync(meshPath, mdpa);

execFileSync("node", [path.join(ROOT, "scripts", "screenshots", "build-harness.mjs")], {
  env: { ...process.env, HARNESS_MESH: meshPath },
  stdio: "pipe",
});

const { chromium } = resolvePlaywright();
// The bundled Chromium is the one this sandbox ships; the default lookup wants another build.
const bundled = "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  ...(fs.existsSync(bundled) ? { executablePath: bundled } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForTimeout(3500);
  pageErrors.length = 0; // only errors raised by the selection below count

  const select = async (id) => {
    await page.evaluate((pid) => {
      const sel = document.getElementById("pt-select");
      if (!sel) throw new Error("no #pt-select");
      sel.value = pid;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, id);
    await page.waitForTimeout(400);
  };

  // The catalog lists cosim in the same family group as the FSI problemtype it sits beside.
  const options = await page.evaluate(() =>
    [...document.querySelectorAll("#pt-select option")].map((o) => ({
      value: o.value,
      group: o.parentElement?.tagName === "OPTGROUP" ? o.parentElement.label : "",
    }))
  );
  const cosimOption = options.find((o) => o.value === "cosim");
  const fsiOption = options.find((o) => o.value === "fsi");
  assert.ok(cosimOption, `cosim missing from the catalog: ${options.map((o) => o.value).join(", ")}`);
  assert.ok(fsiOption, "fsi missing from the catalog");
  assert.equal(cosimOption.group, fsiOption.group, "cosim sits in the same family group as fsi");

  await select("cosim");
  const text = await page.evaluate(() => document.body.textContent ?? "");
  for (const phrase of [
    "Partitioned coupling", // the coupling section's group
    "Predictor weight", // the coupling section's one field
    "Coupling interface (fluid side)", // an interface condition in the branch picker
    "Coupling interface (structure side)",
  ]) {
    assert.ok(text.includes(phrase), `the sidebar shows "${phrase}" once cosim is selected`);
  }
  assert.deepEqual(pageErrors, [], `selecting cosim raised page errors: ${pageErrors.join(" | ")}`);

  // Generate posts the case request for the selected problemtype.
  await page.click("#pt-generate");
  await page.waitForTimeout(200);
  const sent = await page.evaluate(() => (window.SENT_MESSAGES ?? []).map((m) => m.type));
  assert.ok(sent.includes("ptGenerate"), `Generate posts ptGenerate, got ${sent.slice(-4).join(", ")}`);
  console.log("cosim sidebar: OK");
} finally {
  await browser.close();
}
