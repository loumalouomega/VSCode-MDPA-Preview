// Roadmap item 17: the Inspect-panel "save monitor" host flow (QuickPick for
// the case, InputBox for the name, sidecar written) under a real VS Code host.
import { mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, startHost, palette, openFile, webviewFrame } from "./host.mjs";
const ws = join(ROOT, "out/host/ws4"); mkdirSync(ws, { recursive: true });
copyFileSync(join(ROOT, "example/VTK/Main_0_2.vtk"), join(ws, "Main_0_2.vtk"));
for (const s of ["alpha", "beta"]) { writeFileSync(join(ws, `${s}.kratoscase.json`), "{}"); writeFileSync(join(ws, `${s}.mdpa`), "Begin ModelPartData\nEnd ModelPartData\n"); }
const h = await startHost({ workspace: ws });
const ok = (n, p, x = {}) => { console.log(p ? "PASS" : "FAIL", n, JSON.stringify(x)); if (!p) process.exitCode = 1; };
try {
  await h.page.addInitScript(() => { let real; Object.defineProperty(window, "acquireVsCodeApi", { configurable: true,
    get() { return real ? () => { const a = real(); window.__api = a; return a; } : undefined; }, set(v) { real = v; } }); });
  await openFile(h.page, "Main_0_2.vtk"); await palette(h.page, "Open VTK Preview");
  const f = await webviewFrame(h.page); await h.page.waitForTimeout(3000);
  await f.evaluate(() => window.__api.postMessage({ type: "saveMonitor", kind: "Nodal", entityId: 1, variable: "DISPLACEMENT" }));
  await h.page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 15000 });
  const title = await h.page.locator(".quick-input-title").innerText().catch(() => "");
  const rows = await h.page.locator(".quick-input-list .monaco-list-row").allInnerTexts();
  ok("case QuickPick offered for two cases", /which case/i.test(title) && rows.length === 2, { title, rows: rows.length });
  await h.page.keyboard.press("Enter"); // first case (alpha)
  await h.page.waitForSelector(".quick-input-widget input", { state: "visible", timeout: 15000 });
  await h.page.waitForTimeout(500);
  const name = await h.page.locator(".quick-input-widget input").first().inputValue();
  ok("InputBox prefilled with a monitor name", name.length > 0, { name });
  await h.page.keyboard.press("Enter");
  await h.page.waitForTimeout(2500);
  const side = join(ws, "alpha.kratosmonitors.json");
  ok("monitor sidecar written", existsSync(side));
  if (existsSync(side)) { const j = JSON.parse(readFileSync(side, "utf8")); ok("sidecar holds the monitor", Array.isArray(j.monitors) && j.monitors.length === 1, { monitors: j.monitors?.length }); }
  ok("other case untouched", !existsSync(join(ws, "beta.kratosmonitors.json")));
} catch (e) { console.error(e); await h.page.screenshot({ path: join(ROOT, "out/host/monitors-fail.png") }).catch(() => {}); process.exitCode = 1; } finally { await h.stop(); }
