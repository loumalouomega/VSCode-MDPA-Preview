// Harness smoke check for the Selection feature (roadmap item 4): the panel
// opens from the toolbar button, the gesture-mode track switches (box toast),
// Ctrl+click picks land in the active set, a box drag completes, the lasso
// closes from placed vertices, and both selection-driven routes post their
// ops with explicit id arrays (createSubModelPartFromSelection, deleteEntities).
// Run like the other checks (after `npm run compile` + build-harness):
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-selection.mjs
import path from "node:path";
import { createRequire } from "node:module";

// playwright-core resolves through NODE_PATH, which ESM imports ignore — the
// same require-based lookup every other screenshot script uses.
const { chromium } = createRequire(import.meta.url)("playwright-core");

const harnessDir = path.resolve(process.cwd(), "out/screenshot-harness");

// The playwright-cached Chromium in ~/.cache/ms-playwright, or CHROMIUM_PATH —
// the installed playwright-core's cache version may differ from the on-disk
// build, so the executable is resolved explicitly (CHROMIUM_PATH wins).
function chromiumOf() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const fs = require("node:fs");
  const base = path.join(process.env.HOME ?? "~", ".cache", "ms-playwright");
  for (const c of [
    "chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
    "chromium_headless_shell-1234/chrome-linux/headless_shell",
    "chromium-1243/chrome-linux64/chrome",
  ]) {
    const p = path.join(base, c);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const require = createRequire(import.meta.url);
const browser = await chromium.launch({
  executablePath: chromiumOf(),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(800);

  // 1. The toolbar button opens the floating panel and latches.
  await page.click('#toolbar button[data-action="selection"]');
  await page.waitForSelector("#selection-panel", { state: "visible", timeout: 5000 });
  if (!(await page.$eval('#toolbar button[data-action="selection"]', (b) => b.classList.contains("active")))) {
    throw new Error("Selection toolbar button did not latch active");
  }
  console.log("ok: selection panel opens from the toolbar");

  // 2. The mode track switches to Box and announces the mode.
  const segs = await page.$$("#selection-panel .ui-segments .ui-seg");
  if (segs.length !== 3) throw new Error(`gesture mode track has ${segs.length} segments, expected 3 (Single/Box/Lasso)`);
  // The panel re-renders on every state change, so a stored handle goes stale
  // — re-resolve the segments right before every click.
  await page.click('#selection-panel .ui-segments .ui-seg:nth-child(2)');
  await page.waitForTimeout(300);
  if (!(await page.$eval("#selection-panel .ui-segments .ui-seg:nth-child(2)", (b) => b.classList.contains("active")))) {
    throw new Error("Box segment did not latch");
  }
  const toastText = await page.$eval("#message", (el) => el.textContent ?? "");
  if (!toastText.includes("Box select")) throw new Error(`box-mode toast missing: "${toastText}"`);
  console.log("ok: box mode toggles and announces itself");

  // 3. Ctrl+click on the canvas creates the auto set.
  const canvasRect = await page.$eval("#render-root canvas", (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  const mid = { x: canvasRect.x + canvasRect.width / 2, y: canvasRect.y + canvasRect.height / 2 };
  await page.mouse.move(mid.x, mid.y);
  await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("Control");
  await page.waitForTimeout(500);
  const setRows = await page.$$("#selection-panel .sel-set-row");
  if (setRows.length === 0) throw new Error("Ctrl+click did not create a set");
  const setName = await setRows[0].$eval(".sel-set-name", (el) => el.textContent ?? "");
  console.log("ok: Ctrl+click created a set:", `("${setName}", rows=${setRows.length})`);

  // 4. A box drag completes and updates the set.
  const boxTop = { x: mid.x - 150, y: canvasRect.y + canvasRect.height * 0.35 };
  await page.mouse.move(boxTop.x, boxTop.y);
  await page.mouse.down();
  await page.mouse.move(boxTop.x + 300, boxTop.y + 200, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  if (!(await page.$eval("#sel-rubberband", (el) => el.style.display === "none"))) {
    throw new Error("rubber band did not hide after release");
  }
  const afterBox = await page.$eval("#selection-panel .sel-set-name", (el) => el.textContent ?? "");
  if (afterBox === setName) throw new Error("box select did not change the set");
  console.log("ok: box select completed, set now:", afterBox);

  // 5. The lasso: switch mode, place 4 vertices, close by Enter. The set grows.
  const beforeLasso = await page.$eval("#selection-panel .sel-set-name", (el) => el.textContent ?? "");
  await page.click('#selection-panel .ui-segments .ui-seg:nth-child(3)');
  await page.waitForTimeout(200);
  const cornerA = { x: mid.x - 180, y: canvasRect.y + canvasRect.height * 0.30 };
  const cornerB = { x: mid.x + 180, y: canvasRect.y + canvasRect.height * 0.30 };
  const cornerC = { x: mid.x + 180, y: canvasRect.y + canvasRect.height * 0.70 };
  const cornerD = { x: mid.x - 180, y: canvasRect.y + canvasRect.height * 0.30 };
  for (const [p, close] of [[cornerA, false], [cornerB, false], [cornerC, true], [cornerD, false]]) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(120);
    if (close) break;
  }
  const lassoVisible = await page.$eval("#sel-lasso", (el) => el.style.display !== "none");
  if (!lassoVisible) throw new Error("the lasso polygon is not drawn while points are being placed");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const afterLasso = await page.$eval("#selection-panel .sel-set-name", (el) => el.textContent ?? "");
  if (afterLasso === afterBox) throw new Error("lasso did not change the set");
  if (!(await page.$eval("#sel-lasso", (el) => el.style.display === "none"))) {
    throw new Error("the lasso overlay did not hide after Enter");
  }
  console.log("ok: lasso closed from placed vertices, set now:", afterLasso);

  // 6. New SubModelPart posts the op with the selection's explicit id arrays.
  await page.fill("#sel-smp-name", "SelCheck");
  const smpBtn = await page.$('#selection-panel button[title*="SubModelPart"]');
  if (!smpBtn) throw new Error("no New SubModelPart button");
  await smpBtn.click();
  await page.waitForTimeout(400);
  const selOp = await lastApplyOp(page);
  if (!selOp || selOp.op !== "createSubModelPartFromSelection" || !Array.isArray(selOp.elements)) {
    throw new Error("New SubModelPart did not post createSubModelPartFromSelection with id arrays");
  }
  if (selOp.elements.length + (selOp.conditions?.length ?? 0) === 0) {
    throw new Error("the posted selection is empty");
  }
  console.log("ok: SubModelPart op posted with", selOp.elements.length, "elements,", selOp.conditions?.length ?? 0, "conditions");

  // 7. Delete entities posts deleteEntities with the same id lists.
  const delBtn = await page.$('#selection-panel button[title^="DELETE the selected entities"]');
  if (!delBtn) throw new Error("no Delete entities button");
  await delBtn.click();
  await page.waitForTimeout(400);
  const delOp = await lastApplyOp(page);
  if (!delOp || delOp.op !== "deleteEntities" || !Array.isArray(delOp.elements)) {
    throw new Error("Delete entities did not post deleteEntities with id arrays");
  }
  console.log("ok: deleteEntities op posted with", delOp.elements.length, "elements");

  if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join(" | ")}`);
  console.log("PASS");
} catch (e) {
  console.error("FAIL:", e?.message ?? e);
  if (pageErrors.length) console.error("page errors:", pageErrors.join(" | "));
} finally {
  await browser.close();
}

async function lastApplyOp() {
  return page.evaluate(() => {
    const msgs = (window.SENT_MESSAGES ?? []).filter((m) => m.type === "applyOp");
    return msgs[msgs.length - 1];
  });
}
