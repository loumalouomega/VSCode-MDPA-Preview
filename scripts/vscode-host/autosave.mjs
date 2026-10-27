// The auto-save refusal (src/meshDocument.ts): with files.autoSave on, an edit
// must stay unsaved and the mesh on disk untouched.
import { mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, startHost, palette, openFile, webviewFrame } from "./host.mjs";
const ws = join(ROOT, "out/host/ws3"); mkdirSync(ws, { recursive: true });
copyFileSync(join(ROOT, "src/test/fixtures/mdpa/beam_frame.mdpa"), join(ws, "frame.mdpa"));
const before = readFileSync(join(ws, "frame.mdpa"), "utf8");
const h = await startHost({ workspace: ws, settings: { "files.autoSave": "afterDelay", "files.autoSaveDelay": 1000 } });
const ok = (n, p, x = {}) => { console.log(p ? "PASS" : "FAIL", n, JSON.stringify(x)); if (!p) process.exitCode = 1; };
try {
  await h.page.addInitScript(() => { let real; Object.defineProperty(window, "acquireVsCodeApi", { configurable: true,
    get() { return real ? () => { const a = real(); window.__api = a; return a; } : undefined; }, set(v) { real = v; } }); });
  await openFile(h.page, "frame.mdpa"); await palette(h.page, "Open Preview");
  const f = await webviewFrame(h.page); await h.page.waitForTimeout(3000);
  await f.evaluate(() => window.__api.postMessage({ type: "applyOp", op: "translate", dx: 1, dy: 0, dz: 0 }));
  await h.page.waitForTimeout(6000);
  const modal = await h.page.locator(".monaco-dialog-box").count();
  ok("no overwrite modal from auto-save", modal === 0, { modal });
  ok("mesh on disk untouched", readFileSync(join(ws, "frame.mdpa"), "utf8") === before);
  ok("tab still dirty", await h.page.evaluate(() => !!document.querySelector(".tab.dirty")));
} catch (e) { console.error(e); process.exitCode = 1; } finally { await h.stop(); }
