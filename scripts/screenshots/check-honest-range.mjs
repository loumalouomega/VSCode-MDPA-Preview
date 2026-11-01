// Chromium check for roadmap item 36 (honest colour ranges, visible extremes).
//   npm run compile && HARNESS_MESH=example/VTK/Main_0_2.vtk node scripts/screenshots/build-harness.mjs
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=<playwright-core dir> node scripts/screenshots/check-honest-range.mjs
// With CONST_MESH=<mesh with a uniform scalar> also run the constant-field leg.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { chromium } = require("playwright-core");
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

async function open(meshEnv) {
  execFileSync("node", [path.join(ROOT, "scripts/screenshots/build-harness.mjs")], {
    env: { ...process.env, ...(meshEnv ? { HARNESS_MESH: meshEnv } : {}) },
    stdio: "ignore",
  });
  const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => document.querySelector('[data-action="field"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForTimeout(800);
  return { browser, page, errors };
}
const tick = (page, re) =>
  page.evaluate((s) => {
    const l = [...document.querySelectorAll("#field-panel label")].find((x) => new RegExp(s).test(x.textContent));
    const c = l?.querySelector("input");
    if (!c) return false;
    c.checked = !c.checked;
    c.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, re);

{
  const { browser, page, errors } = await open("example/VTK/Main_0_2.vtk");
  check(/data: .* … .*node\/cell/.test(await page.evaluate(() => document.querySelector(".field-legend-note")?.textContent ?? "")), "legend prints the true data range");
  check(await tick(page, "Show extremes"), "Show extremes ticked");
  await page.waitForTimeout(600);
  const rows = await page.evaluate(() => [...document.querySelectorAll(".field-extreme-row")].map((r) => r.textContent));
  check(rows.length === 2 && /Min/.test(rows[0]) && /Max/.test(rows[1]), `two extreme rows (${rows.join(" | ")})`);
  const id = (rows[1].match(/id (\d+)/) ?? [])[1];
  await page.evaluate(() => document.querySelectorAll(".field-extreme-go")[1].click());
  await page.waitForTimeout(600);
  const inspect = await page.evaluate(() => document.getElementById("inspect-panel")?.innerText ?? "");
  check(id && inspect.includes(id), `Go to opens Inspect on the maximum's id ${id}`);
  await tick(page, "Symmetric range");
  await page.waitForTimeout(400);
  const inputs = await page.evaluate(() => [...document.querySelectorAll(".field-range-input")].map((i) => Number(i.value)));
  check(inputs.length === 2 && Math.abs(inputs[0] + inputs[1]) < 1e-6, `symmetric range ${inputs}`);
  check(errors.length === 0, `no page errors ${errors}`);
  await browser.close();
}
if (process.env.CONST_MESH) {
  const { browser, page, errors } = await open(process.env.CONST_MESH);
  const note = await page.evaluate(() => document.querySelector(".field-legend-note")?.textContent ?? "");
  check(/constant/i.test(note), `constant field legend "${note}"`);
  check(errors.length === 0, `no page errors (constant) ${errors}`);
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
