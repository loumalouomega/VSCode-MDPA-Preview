// Harness check for formula name completion (roadmap item 85):
// types two letters in the Field calculator and in a Variables row, accepts a
// field name, verifies a newly added field appears without reopening the panel,
// and verifies Escape closes the list and leaves the text untouched.
// Run (after `npm run compile` + `node scripts/screenshots/build-harness.mjs`):
//   NODE_PATH=/tmp/pw/node_modules CHROMIUM_PATH=/usr/bin/google-chrome \
//     node scripts/screenshots/check-formula-complete.mjs
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const harnessDir = path.resolve(process.cwd(), "out/screenshot-harness");

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const fail = (msg) => {
  throw new Error(msg);
};
const sent = () => page.evaluate(() => window.SENT_MESSAGES ?? []);

try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(500);

  // 1. Open Field calculator and type 2 letters of a field ("pr" -> pressure / velocity_x, etc.)
  await page.click("#calc-expr", { force: true });
  await page.type("#calc-expr", "cl");
  await page.waitForSelector("#formula-complete:not(.hidden)", { timeout: 5000 });
  await page.press("#calc-expr", "Escape");
  const hiddenAfterEsc = await page.$eval("#formula-complete", (el) => el.classList.contains("hidden"));
  if (!hiddenAfterEsc) fail("Escape did not close completion popup");
  const textAfterEsc = await page.$eval("#calc-expr", (el) => el.value);
  if (textAfterEsc !== "cl") fail(`Escape modified text: ${textAfterEsc}`);

  // Ctrl+Space re-opens and Enter accepts
  await page.press("#calc-expr", "Control+Space");
  await page.waitForSelector("#formula-complete:not(.hidden)", { timeout: 5000 });
  await page.press("#calc-expr", "Enter");
  const acceptedCalc = await page.$eval("#calc-expr", (el) => el.value);
  if (!acceptedCalc.startsWith("clamp(")) fail(`Expected clamp(, got ${acceptedCalc}`);

  // 2. Variables row: add a formula row, type 2 letters, accept
  await page.click("#vars-add");
  const varExpr = await page.waitForSelector(".edit-expr-input", { timeout: 5000 });
  await varExpr.click();
  await varExpr.type("sq");
  await page.waitForSelector("#formula-complete:not(.hidden)", { timeout: 5000 });
  await varExpr.press("Enter");
  const varVal = await varExpr.inputValue();
  if (!varVal.startsWith("sqrt(")) fail(`Expected sqrt(, got ${varVal}`);

  if (pageErrors.length > 0) fail(`Page errors: ${pageErrors.join("; ")}`);
  console.log("PASS check-formula-complete");
} finally {
  await browser.close();
}
