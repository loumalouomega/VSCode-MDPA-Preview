// Harness check: the Field integrals panel offers a revolve axis and posts it (roadmap item 44).
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const fail = (m) => {
  throw new Error(m);
};
try {
  await page.goto("file://" + path.resolve(process.cwd(), "out/screenshot-harness/index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.fill("#cmd-input", "integrals");
  await page.press("#cmd-input", "Enter");
  await page.waitForSelector("#integral-panel select", { timeout: 5000 });
  await page.evaluate(() => {
    window.SENT_MESSAGES = [];
  });
  await page.selectOption("#integral-panel select", "y");
  await page.waitForTimeout(300);
  const m = (await page.evaluate(() => window.SENT_MESSAGES)).find((x) => x.type === "meshAnalysis" && x.kind === "integrate");
  if (!m || m.revolveAbout !== "y") fail("no integrate request with revolveAbout=y: " + JSON.stringify(m));
  await page.selectOption("#integral-panel select", "");
  await page.waitForTimeout(300);
  const last = (await page.evaluate(() => window.SENT_MESSAGES)).filter((x) => x.kind === "integrate").pop();
  if (last.revolveAbout !== undefined) fail("plane request still carries an axis");
  console.log("ok: Field integrals panel posts the revolve axis");
} finally {
  await browser.close();
}
