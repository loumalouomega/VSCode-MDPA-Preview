// Harness smoke check for the bottom command line: typed commands become the
// exact host messages / UI changes, Tab completes, history recalls, a bad key
// reports a did-you-mean without posting anything, `;` steps wait for the host's
// `commandResult`, and the global single-key shortcuts do not fire while typing.
// Run (after `npm run compile` + `node scripts/screenshots/build-harness.mjs`):
//   NODE_PATH=/tmp/pw/node_modules CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//     node scripts/screenshots/check-command-line.mjs
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
const clearSent = () => page.evaluate(() => { window.SENT_MESSAGES = []; });
const echo = () => page.$eval("#cmd-echo", (el) => ({ text: el.textContent ?? "", tone: el.dataset.tone }));
const type = async (text) => {
  await page.fill("#cmd-input", text);
};
const run = async (text) => {
  await type(text);
  await page.press("#cmd-input", "Enter");
};
const hostReply = (m) => page.evaluate((msg) => window.postMessage(msg, "*"), m);

try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(800);

  // 0. Layout: the row sits directly above the status bar, full width.
  const geo = await page.evaluate(() => {
    const c = document.getElementById("commandline").getBoundingClientRect();
    const s = document.getElementById("statusbar").getBoundingClientRect();
    const m = document.getElementById("main").getBoundingClientRect();
    return { cTop: c.top, cBottom: c.bottom, cW: c.width, sTop: s.top, mBottom: m.bottom, vw: window.innerWidth };
  });
  if (Math.abs(geo.cBottom - geo.sTop) > 1) fail(`command line is not directly above the status bar: ${JSON.stringify(geo)}`);
  if (Math.abs(geo.mBottom - geo.cTop) > 1) fail(`#main does not end where the command line starts: ${JSON.stringify(geo)}`);
  if (geo.cW < geo.vw - 2) fail("command line is not full width");
  console.log("ok: command line sits between #main and the status bar");

  // 1. `/` focuses it from the viewport; the single-key view shortcuts do not fire while typing.
  await page.mouse.click(900, 400);
  await page.keyboard.press("/");
  if (!(await page.$eval("#cmd-input", (el) => document.activeElement === el))) fail("/ did not focus the command line");
  await clearSent();
  await page.keyboard.type("1i");
  await page.waitForTimeout(100);
  if ((await page.$eval("#cmd-input", (el) => el.value)) !== "1i") fail("typing digits/i did not reach the input");
  console.log("ok: '/' focuses the line and view shortcuts are not hijacked");

  // 2. A mesh operation posts applyOp with a cmdId, then waits for commandResult.
  await clearSent();
  await run("translate dx=1 dy=2");
  await page.waitForTimeout(100);
  let msgs = await sent();
  const op = msgs.find((m) => m.type === "applyOp");
  if (!op || op.op !== "translate" || op.dx !== 1 || op.dy !== 2 || typeof op.cmdId !== "number") fail(`unexpected applyOp: ${JSON.stringify(msgs)}`);
  if (!(await echo()).text.includes("running")) fail("echo did not show the running state");
  await hostReply({ type: "commandResult", cmdId: op.cmdId, ok: true, message: "Translated 12 nodes." });
  await page.waitForTimeout(100);
  const done = await echo();
  if (done.tone !== "ok" || !done.text.includes("Translated 12 nodes")) fail(`result not echoed: ${JSON.stringify(done)}`);
  console.log("ok: translate posts applyOp+cmdId and echoes the host result");

  // 3. A bad key is rejected locally with a did-you-mean; nothing is posted.
  await clearSent();
  await run("translate dxx=1");
  await page.waitForTimeout(100);
  const bad = await echo();
  if (bad.tone !== "error" || !/dxx/.test(bad.text) || !/did you mean dx/.test(bad.text)) fail(`bad key echo: ${JSON.stringify(bad)}`);
  if ((await sent()).length) fail("a rejected command still posted a message");
  console.log("ok: unknown parameter reports a did-you-mean and posts nothing");

  // 4. A host-side failure is shown as an error and stops the `;` sequence.
  await clearSent();
  await run("scale sx=2 ; translate dx=1");
  await page.waitForTimeout(100);
  let m1 = (await sent()).filter((m) => m.type === "applyOp");
  if (m1.length !== 1 || m1[0].op !== "scale") fail(`step 1 not posted alone: ${JSON.stringify(m1)}`);
  await hostReply({ type: "commandResult", cmdId: m1[0].cmdId, ok: false, message: "scale: invalid value for sx=2" });
  await page.waitForTimeout(150);
  if ((await sent()).filter((m) => m.type === "applyOp").length !== 1) fail("sequence continued after a failed step");
  const stopped = await echo();
  if (stopped.tone !== "error" || !stopped.text.includes("step 1/2")) fail(`failed-step echo: ${JSON.stringify(stopped)}`);
  console.log("ok: a failed step stops the sequence and is reported");

  // 5. `;` waits for each result and then runs the next step.
  await clearSent();
  await run("scale sx=2 ; translate dx=1");
  await page.waitForTimeout(100);
  m1 = (await sent()).filter((m) => m.type === "applyOp");
  await hostReply({ type: "commandResult", cmdId: m1[0].cmdId, ok: true, message: "Scaled." });
  await page.waitForTimeout(150);
  const m2 = (await sent()).filter((m) => m.type === "applyOp");
  if (m2.length !== 2 || m2[1].op !== "translate") fail(`second step not sent after the first result: ${JSON.stringify(m2)}`);
  await hostReply({ type: "commandResult", cmdId: m2[1].cmdId, ok: true, message: "Translated." });
  await page.waitForTimeout(100);
  console.log("ok: steps run sequentially on commandResult");

  // 6. Host messages and UI actions.
  await clearSent();
  await run("undo");
  await run("export vtu");
  await page.waitForTimeout(100);
  msgs = await sent();
  if (!msgs.some((m) => m.type === "opUndo")) fail("undo did not post opUndo");
  if (!msgs.some((m) => m.type === "menuExport" && m.format === ".vtu")) fail("export vtu did not post menuExport");
  await run("quality on");
  await page.waitForSelector("#quality-panel", { state: "visible", timeout: 5000 });
  await run("quality off");
  await page.waitForFunction(() => getComputedStyle(document.getElementById("quality-panel")).display === "none", { timeout: 5000 });
  await run("layout 1x2");
  await page.waitForTimeout(300);
  await run("view top");
  await run("wireframe on");
  console.log("ok: undo/export/quality/layout/view/wireframe commands run");

  // 7. Tab completion and history.
  await type("transl");
  await page.press("#cmd-input", "Tab");
  if ((await page.$eval("#cmd-input", (el) => el.value)) !== "translate ") fail("Tab did not complete the verb");
  await page.keyboard.type("d");
  await page.press("#cmd-input", "Tab");
  let v = await page.$eval("#cmd-input", (el) => el.value);
  if (!/^translate d[xyz]=?/.test(v)) fail(`param completion/cycling gave "${v}"`);
  await type("");
  await page.press("#cmd-input", "ArrowUp");
  v = await page.$eval("#cmd-input", (el) => el.value);
  if (v !== "layout 1x2" && !v.startsWith("wireframe") && !v.startsWith("view")) fail(`history recall gave "${v}"`);
  console.log("ok: Tab completes and ArrowUp recalls history:", `("${v}")`);

  // 8. help renders output; Escape closes it.
  await run("help rotate");
  await page.waitForSelector("#cmd-output", { state: "visible", timeout: 2000 });
  const helpText = await page.$eval("#cmd-output", (el) => el.textContent ?? "");
  if (!helpText.includes("rotate axis=<x|y|z>")) fail(`help output: ${helpText}`);
  await page.press("#cmd-input", "Escape");
  if (!(await page.$eval("#cmd-output", (el) => el.hidden))) fail("Escape did not dismiss the help card");
  console.log("ok: help shows usage and Escape dismisses it");

  await page.screenshot({ path: "out/command-line.png" });
  if (pageErrors.length) fail(`page errors: ${pageErrors.join(" | ")}`);
  console.log("PASS: command line");
} finally {
  await browser.close();
}
