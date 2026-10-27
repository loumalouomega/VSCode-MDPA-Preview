// Roadmap items 1/17 in a real VS Code host: custom-editor dirty/save/undo
// contract, palette parity and the Kratos activity-bar views.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, startHost, palette, openFile, webviewFrame } from "./host.mjs";

const ws = join(ROOT, "out/host/ws2"); mkdirSync(ws, { recursive: true });
copyFileSync(join(ROOT, "src/test/fixtures/mdpa/beam_frame.mdpa"), join(ws, "frame.mdpa"));
const before = readFileSync(join(ws, "frame.mdpa"), "utf8");
const h = await startHost({ workspace: ws });
const ok = (n, p, x = {}) => { console.log(p ? "PASS" : "FAIL", n, JSON.stringify(x)); if (!p) process.exitCode = 1; };
const dirty = () => h.page.evaluate(() => !!document.querySelector(".tab.dirty, .tab.active.dirty"));
try {
  await h.page.addInitScript(() => {
    let real; Object.defineProperty(window, "acquireVsCodeApi", { configurable: true,
      get() { return real ? () => { const a = real(); window.__api = a; return a; } : undefined; }, set(v) { real = v; } });
  });
  await openFile(h.page, "frame.mdpa");
  await palette(h.page, "Open Preview");
  const f = await webviewFrame(h.page);
  await h.page.waitForTimeout(3000);
  ok("clean before edit", !(await dirty()));
  await f.evaluate(() => window.__api.postMessage({ type: "applyOp", op: "translate", dx: 1, dy: 0, dz: 0 }));
  await h.page.waitForTimeout(2500);
  ok("edit marks tab dirty", await dirty());
  // Save through the extension's own route (Ctrl+S) with auto-save off.
  await palette(h.page, "Kratos MDPA: Save Mesh"); await h.page.waitForTimeout(3000);
  await h.page.screenshot({ path: join(ROOT, "out/host/commands-save.png") });
  // First save shows a one-time overwrite warning modal.
  const labels = await h.page.locator(".monaco-dialog-box .monaco-button").allInnerTexts(); console.log("modal buttons", labels);
  const btn = labels.length ? h.page.locator(".monaco-dialog-box .monaco-button").filter({ hasText: /overwrite|save|continue|yes/i }).first() : null;
  if (btn) { console.log("overwrite modal shown; accepting"); await btn.click(); await h.page.waitForTimeout(3000); }
  const after = readFileSync(join(ws, "frame.mdpa"), "utf8");
  ok("save wrote the edited mesh", after !== before, { changed: after !== before });
  ok("dirty cleared after save", !(await dirty()));
  // Palette parity: Kratos commands are discoverable.
  const titles = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).contributes.commands.length;
  let found = 0; const missing = [];
  for (const q of ["Kratos MDPA: Show What", "Kratos MDPA: Reset", "Kratos MDPA: Take Screenshot", "Kratos MDPA: Command"]) {
    await h.page.keyboard.press("F1"); await h.page.waitForSelector(".quick-input-widget", { state: "visible" });
    await h.page.keyboard.type(">" + q); await h.page.waitForTimeout(900);
    const c = await h.page.locator(".quick-input-list .monaco-list-row").count();
    if (c > 0) found++; else missing.push(q);
    await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(300);
  }
  ok("palette finds Kratos commands", found === 4, { found, missing, manifestCommands: titles });
  // Activity-bar container.
  const ab = await h.page.locator('[aria-label*="Kratos"]').count();
  ok("Kratos activity-bar entry present", ab > 0, { matches: ab });
  await h.page.screenshot({ path: join(ROOT, "out/host/commands.png") });
} catch (e) { console.error(e); await h.page.screenshot({ path: join(ROOT, "out/host/commands-fail.png") }).catch(() => {}); process.exitCode = 1; }
finally { await h.stop(); }
