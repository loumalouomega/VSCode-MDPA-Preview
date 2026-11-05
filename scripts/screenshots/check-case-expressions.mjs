// Harness check for case expressions in the Problemtype forms (roadmap item 27): a numeric field
// accepts an expression and keeps it as text in the posted case state, the Parameters card adds
// a `name = expression` row with a live value preview, and a plain number is still a number.
// Run (after `npm run compile` + `node scripts/screenshots/build-harness.mjs`):
//   NODE_PATH=... CHROMIUM_PATH=... node scripts/screenshots/check-case-expressions.mjs
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
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fail = (m) => {
  throw new Error(m);
};
const lastState = async () => (await page.evaluate(() => (window.SENT_MESSAGES ?? []).filter((m) => m.type === "ptState").pop()))?.state;
try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForSelector("#pt-select", { timeout: 30000 });
  await page.selectOption("#pt-select", "structural");
  await page.waitForTimeout(500);
  // Parameters card: open it and add a row.
  await page.click("#pt-forms .pt-card:last-child .edit-form-title");
  await page.click("#pt-forms .pt-card:last-child .panel-btn");
  const rows = await page.$$("#pt-forms .pt-param-row");
  if (rows.length !== 1) fail("expected one parameter row, got " + rows.length);
  const inputs = await rows[0].$$("input");
  await inputs[0].fill("L");
  await inputs[0].dispatchEvent("change");
  await inputs[1].fill("2[m]");
  await inputs[1].dispatchEvent("change");
  const preview = await rows[0].$eval(".pt-param-result", (e) => e.textContent);
  if (!/= 2/.test(preview ?? "")) fail("no live preview: " + preview);
  // A numeric field takes an expression and a plain number.
  const field = await page.$("#pt-forms .pt-card .pt-field input[type=text]");
  if (!field) fail("no numeric text input in the first section");
  await field.fill("L * 2");
  await field.dispatchEvent("change");
  await page.waitForTimeout(700);
  let st = await lastState();
  if (!st || JSON.stringify(st.parameters) !== JSON.stringify([{ name: "L", expr: "2[m]" }])) fail("parameters not posted: " + JSON.stringify(st?.parameters));
  if (!JSON.stringify(st.values).includes('"L * 2"')) fail("expression not kept as text: " + JSON.stringify(st.values).slice(0, 300));
  await field.fill("7.5");
  await field.dispatchEvent("change");
  await page.waitForTimeout(700);
  st = await lastState();
  if (!JSON.stringify(st.values).includes("7.5") || JSON.stringify(st.values).includes('"L * 2"')) fail("plain number not restored as a number");
  if (errors.length) fail("page errors: " + errors.join("; "));
  console.log("ok: expressions and the Parameters table work in the Problemtype forms");
} finally {
  await browser.close();
}
