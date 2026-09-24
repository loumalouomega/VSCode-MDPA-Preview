// Harness smoke check for the Selection feature (roadmap item 4): the panel
// opens from the new toolbar button, box mode toggles with a toast, Ctrl+click
// picks land in the active set, a box drag completes, and the SubModelPart
// route posts createSubModelPartFromSelection with explicit id arrays.
// Run like the other checks (after `npm run compile` + build-harness):
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-selection.mjs
import path from "node:path";
import { createRequire } from "node:module";

// playwright-core resolves through NODE_PATH, which ESM imports ignore — the
// same require-based lookup every other screenshot script uses.
const { chromium } = createRequire(import.meta.url)("playwright-core");

const harnessDir = path.resolve(process.cwd(), "out/screenshot-harness");
const fs = (await import("node:fs")).default;

// The playwright-cached Chromium in ~/.cache/ms-playwright, or CHROMIUM_PATH —
// the installed playwright-core's own cache entry may differ from the one on
// disk, so the executable is resolved explicitly like CHROMIUM_PATH lets the
// other scripts do.
function chromiumOf() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = path.join(process.env.HOME ?? "~", ".cache", "ms-playwright");
  const cands = [
    "chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
    "chromium_headless_shell-1234/chrome-linux/headless_shell",
    "chromium-1243/chrome-linux64/chrome",
  ];
  for (const c of cands) {
    const p = path.join(base, c);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

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
  // The model text is filled by buildScene; wait for any parse to land.
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(800);

  // 1. The toolbar button opens the floating panel and latches.
  await page.click('#toolbar button[data-action="selection"]');
  await page.waitForSelector("#selection-panel", { state: "visible", timeout: 5000 });
  const buttonActive = await page.$eval('#toolbar button[data-action="selection"]', (b) => b.classList.contains("active"));
  if (!buttonActive) throw new Error("Selection toolbar button did not latch active");
  console.log("ok: selection panel opens from the toolbar");

  // 2. Box mode toggles and announces itself.
  await page.click('#selection-panel .inspect-actions button.panel-btn');
  await page.waitForTimeout(300);
  const boxActive = await page.$eval('#selection-panel .inspect-actions button.panel-btn', (b) => b.classList.contains("active"));
  if (!boxActive) throw new Error("box select toggle did not latch");
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

  // 4. A box drag completes and reports additions.
  const boxTop = { x: mid.x - 150, y: canvasRect.y + canvasRect.height * 0.35 };
  await page.mouse.move(boxTop.x, boxTop.y);
  await page.mouse.down();
  await page.mouse.move(boxTop.x + 300, boxTop.y + 200, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const rubberGone = await page.$eval("#sel-rubberband", (el) => el.style.display === "none");
  if (!rubberGone) throw new Error("rubber band did not hide after release");
  const afterBox = await page.$eval("#selection-panel .sel-set-name", (el) => el.textContent ?? "");
  if (afterBox === setName) throw new Error("box select did not change the set");
  console.log("ok: box select completed, set now:", afterBox);

  // 5. New SubModelPart posts the op with the selection's explicit id arrays.
  await page.fill("#sel-smp-name", "SelCheck");
  const smpBtn = await page.$('#selection-panel button[title*="SubModelPart"]');
  if (!smpBtn) throw new Error("no New SubModelPart button");
  await smpBtn.click();
  await page.waitForTimeout(400);
  const opMsgs = await page.evaluate(() =>
    (window.SENT_MESSAGES ?? []).filter((m) => m.type === "applyOp")
  );
  const selOp = opMsgs[opMsgs.length - 1];
  if (!selOp || selOp.op !== "createSubModelPartFromSelection" || !Array.isArray(selOp.elements)) {
    throw new Error("New SubModelPart did not post createSubModelPartFromSelection with id arrays");
  }
  if (selOp.elements.length + (selOp.conditions?.length ?? 0) === 0) {
    throw new Error("the posted selection is empty");
  }
  console.log("ok: SubModelPart op posted with", selOp.elements.length, "elements,", selOp.conditions?.length ?? 0, "conditions");

  if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join(" | ")}`);
  console.log("PASS");
} catch (e) {
  console.error("FAIL:", e?.message ?? e);
  if (pageErrors.length) console.error("page errors:", pageErrors.join(" | "));
  console.error("FAIL");
} finally {
  await browser.close();
}
