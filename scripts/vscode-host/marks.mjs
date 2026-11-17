// Roadmap item 78 in a real VS Code host: the tab's unsaved marker follows the
// history back to the save point, while close prompts, the redo tail, the
// watcher reload and a manual File ▸ Revert File keep their old contracts.
//   NODE_PATH=<dir with playwright-core> node scripts/vscode-host/marks.mjs
import { mkdirSync, copyFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, startHost, palette, openFile, webviewFrame } from "./host.mjs";

const ws = join(ROOT, "out/host/ws4");
mkdirSync(ws, { recursive: true });
const file = join(ws, "frame.mdpa");
copyFileSync(join(ROOT, "src/test/fixtures/mdpa/beam_frame.mdpa"), file);
const before = readFileSync(file, "utf8");

const h = await startHost({ workspace: ws });
const ok = (n, p, x = {}) => { console.log(p ? "PASS" : "FAIL", n, JSON.stringify(x)); if (!p) process.exitCode = 1; };
const dirty = () => h.page.evaluate(() => !!document.querySelector(".tab.dirty, .tab.active.dirty"));
const dialog = () => h.page.locator(".monaco-dialog-box").count();
const wait = (ms) => h.page.waitForTimeout(ms);
const op = (f, msg) => f.evaluate((m) => window.__api.postMessage(m), msg);

/** Accept the extension's first-save overwrite confirmation, if shown. */
async function acceptSaveModal() {
  await wait(1500);
  if (!(await dialog())) return "none";
  const labels = await h.page.locator(".monaco-dialog-box .monaco-button").allInnerTexts();
  const btn = h.page.locator(".monaco-dialog-box .monaco-button")
    .filter({ hasText: /overwrite|don't save|save|continue|yes/i }).first();
  await btn.click().catch(() => {});
  await wait(2500);
  return labels.join("|");
}

/** Dismiss a close prompt so the run can continue after a documented failure. */
async function dismissClosePrompt() {
  if (!(await dialog())) return false;
  const btn = h.page.locator(".monaco-dialog-box .monaco-button")
    .filter({ hasText: /don't save|close without/i }).first();
  await btn.click().catch(() => h.page.keyboard.press("Escape"));
  await wait(1000);
  return true;
}

async function openPreview() {
  await openFile(h.page, "frame.mdpa");
  await palette(h.page, "Open Preview");
  const f = await webviewFrame(h.page);
  await wait(3000);
  return f;
}

try {
  await h.page.addInitScript(() => {
    let real;
    Object.defineProperty(window, "acquireVsCodeApi", {
      configurable: true,
      get() { return real ? () => { const a = real(); window.__api = a; return a; } : undefined; },
      set(v) { real = v; },
    });
  });

  let f = await openPreview();
  await f.evaluate(() => {
    window.__docInfo = [];
    window.addEventListener("message", (e) => {
      if (e.data && e.data.type === "documentInfo") window.__docInfo.push(e.data);
    });
  });
  const unsaved = () => f.evaluate(() => (window.__docInfo.length ? window.__docInfo[window.__docInfo.length - 1].unsavedEdits : null));

  ok("clean when opened", !(await dirty()), { unsaved: await unsaved() });

  // --- Two operations, undo both: the dot follows the history back. --------
  await op(f, { type: "applyOp", op: "translate", dx: 1, dy: 0, dz: 0 });
  await wait(2000);
  ok("first edit marks the tab", await dirty(), { unsaved: await unsaved() });
  await op(f, { type: "applyOp", op: "translate", dx: 0, dy: 0, dz: 1 });
  await wait(2000);
  ok("second edit keeps it marked", await dirty());
  await op(f, { type: "opUndo" });
  await wait(1500);
  ok("one undo is still unsaved", await dirty(), { unsaved: await unsaved() });
  await op(f, { type: "opUndo" });
  await wait(2000);
  ok("undoing both clears the tab marker", !(await dirty()), { unsaved: await unsaved() });
  ok("undo wrote nothing to the file", readFileSync(file, "utf8") === before);

  // The cleanup must not have dropped the tail: redo re-marks, undo re-clears.
  await op(f, { type: "opRedo" });
  await wait(1500);
  ok("redo after a cleanup still applies and marks", await dirty());
  await op(f, { type: "opUndo" });
  await wait(2000);
  ok("undoing that redo is clean again", !(await dirty()));
  await h.page.screenshot({ path: join(ROOT, "out/host/marks-clean.png") });

  // --- Closing on a clean-but-undone tab: no save prompt. -------------------
  // Ctrl+W never reaches the workbench through a browser-hosted webview, so
  // close through the same "View: Close Editor" command the keybinding runs.
  await palette(h.page, "View: Close Editor");
  await wait(1500);
  const prompted = await dismissClosePrompt();
  ok("closing after undo-all asks nothing", !prompted, { dialog: await dialog() });
  const tabs = await h.page.locator(".tabs-container .tab").allInnerTexts();
  ok("clean tab closed", !tabs.some((t) => t.includes("frame.mdpa")), { tabs });
  await h.page.screenshot({ path: join(ROOT, "out/host/marks-closed.png") });

  // --- Clear with nothing saved returns to the file and clears. -----------
  f = await openPreview();
  await op(f, { type: "applyOp", op: "translate", dx: 1, dy: 0, dz: 0 });
  await wait(2000);
  ok("edit before clear marks", await dirty());
  await op(f, { type: "opClear" });
  await wait(2000);
  ok("clear without a save clears the marker", !(await dirty()));
  ok("clear wrote nothing to the file", readFileSync(file, "utf8") === before);

  // --- A watcher reload of a really edited file keeps the marker. ---------
  await op(f, { type: "applyOp", op: "translate", dx: 0, dy: 1, dz: 0 });
  await wait(2000);
  ok("edit before the watcher tick marks", await dirty());
  appendFileSync(file, "\n// touched by marks.mjs\n");
  await wait(4000);
  ok("watcher reload keeps the marker", await dirty(), { dialog: await dialog() });
  const editedFile = readFileSync(file, "utf8");
  ok("watcher reload read the edited file", editedFile !== before);

  // --- Manual File ▸ Revert File still drops the stack and the marker. ----
  await palette(h.page, "File: Revert File");
  await wait(2500);
  ok("manual revert clears the marker", !(await dirty()));
  await palette(h.page, "Kratos MDPA: Undo Mesh Operation");
  await wait(1200);
  ok("nothing to undo after a manual revert", !(await dirty()));

  // --- Apply → save → apply → undo back to the save point. ----------------
  await op(f, { type: "applyOp", op: "translate", dx: 2, dy: 0, dz: 0 });
  await wait(2000);
  ok("edit before save marks", await dirty());
  await palette(h.page, "Kratos MDPA: Save Mesh");
  const modal = await acceptSaveModal();
  const saved = readFileSync(file, "utf8");
  ok("save wrote the mesh and cleared the marker", saved !== editedFile && !(await dirty()), { modal });
  await op(f, { type: "applyOp", op: "translate", dx: 0, dy: 0, dz: 2 });
  await wait(2000);
  ok("edit after save marks again", await dirty());
  await op(f, { type: "opUndo" });
  await wait(2000);
  ok("undo back to the save point clears the marker", !(await dirty()));
  ok("undo to the save point wrote nothing", readFileSync(file, "utf8") === saved);
  await op(f, { type: "opRedo" });
  await wait(1500);
  ok("the redo tail survived the cleanup", await dirty());
  await op(f, { type: "opUndo" });
  await wait(2000);
  ok("and undo clears it once more", !(await dirty()));

  await h.page.screenshot({ path: join(ROOT, "out/host/marks.png") });
} catch (e) {
  console.error(e);
  await h.page.screenshot({ path: join(ROOT, "out/host/marks-fail.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await h.stop();
}
