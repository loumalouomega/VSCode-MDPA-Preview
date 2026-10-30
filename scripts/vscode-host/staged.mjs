// Roadmap item 7: staged field delivery (> 2 M field rows) and load time in a
// real VS Code host: geometry first, then rows on demand (`modelField`).
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { ROOT, startHost, palette, openFile, webviewFrame } from "./host.mjs";
const N = Number(process.env.HOST_N ?? 100), FIELDS = 3;
const ws = join(ROOT, "out/host/ws5"); mkdirSync(ws, { recursive: true });
{
  const w = createWriteStream(join(ws, "huge.mdpa")); const put = async (s) => { if (!w.write(s)) await once(w, "drain"); };
  const idx = (i, j, k) => i + j * (N + 1) + k * (N + 1) * (N + 1) + 1, NP = (N + 1) ** 3;
  await put("Begin ModelPartData\nEnd ModelPartData\nBegin Properties 0\nEnd Properties\nBegin Nodes\n");
  for (let k = 0; k <= N; k++) { let s = ""; for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) s += `${idx(i, j, k)} ${i} ${j} ${k}\n`; await put(s); }
  await put("End Nodes\nBegin Elements Element3D8N\n"); let c = 1;
  for (let k = 0; k < N; k++) { let s = ""; for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) s += `${c++} 0 ${[idx(i,j,k),idx(i+1,j,k),idx(i+1,j+1,k),idx(i,j+1,k),idx(i,j,k+1),idx(i+1,j,k+1),idx(i+1,j+1,k+1),idx(i,j+1,k+1)].join(" ")}\n`; await put(s); }
  await put("End Elements\n");
  for (let f = 0; f < FIELDS; f++) { await put(`Begin NodalData FIELD_${f}\n`); for (let p = 1; p <= NP; p += 100000) { let s = ""; for (let q = p; q < Math.min(NP + 1, p + 100000); q++) s += `${q} 0 ${Math.sin(q * 0.001 + f)}\n`; await put(s); } await put("End NodalData\n"); }
  w.end(); await once(w, "finish");
}
const h = await startHost({ workspace: ws, settings: { "workbench.editorAssociations": { "*.mdpa": "kratos.mdpaPreview" } } });
const ok = (n, p, x = {}) => { console.log(p ? "PASS" : "FAIL", n, JSON.stringify(x)); if (!p) process.exitCode = 1; };
try {
  await h.page.addInitScript(() => {
    window.__types = []; const orig = Window.prototype.addEventListener;
    Window.prototype.addEventListener = function (t, fn, o) {
      if (t === "message" && typeof fn === "function") { const w = fn; fn = function (e) { try { if (e.data && e.data.type === "model") window.__staged = (e.data.model.fields ?? []).map((x) => x.pendingRows ?? -1); if (e.data && e.data.type) window.__types.push([e.data.type, Math.round(performance.now())]); } catch {} return w.call(this, e); }; }
      return orig.call(this, t, fn, o); };
    let real; Object.defineProperty(window, "acquireVsCodeApi", { configurable: true,
      get() { return real ? () => { const a = real(); window.__api = a; return a; } : undefined; }, set(v) { real = v; } });
  });
  const t0 = Date.now();
  await openFile(h.page, "huge.mdpa");
  const f = await webviewFrame(h.page, "#stats", 300000);
  await f.waitForFunction(() => document.querySelector("#stats")?.innerText.includes("Elements"), null, { timeout: 300000 });
  const loadMs = Date.now() - t0;
  await h.page.waitForTimeout(8000);
  const types = await f.evaluate(() => window.__types);
  const counts = {}; for (const [t] of types) counts[t] = (counts[t] ?? 0) + 1;
  console.log("load ms (incl. palette)", loadMs, JSON.stringify(counts));
  const staged = await f.evaluate(() => window.__staged);
  ok("fields travel as metadata (rows on demand)", Array.isArray(staged) && staged.length === 3 && staged.every((n) => n > 1_000_000), { pendingRows: staged });
  ok("model posted", (counts.model ?? 0) >= 1, counts);
  writeFileSync(join(ROOT, "out/host/staged.json"), JSON.stringify({ N, fieldRows: FIELDS * (N + 1) ** 3, loadMs, counts }, null, 2));
} catch (e) { console.error(e); await h.page.screenshot({ path: join(ROOT, "out/host/staged-fail.png") }).catch(() => {}); process.exitCode = 1; } finally { await h.stop(); }
