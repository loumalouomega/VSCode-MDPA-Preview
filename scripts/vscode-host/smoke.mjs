import { mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, startHost, palette, openFile, webviewFrame } from "./host.mjs";
const ws = join(ROOT, "out/host/ws"); mkdirSync(ws, { recursive: true });
copyFileSync(join(ROOT, "src/test/fixtures/mdpa/beam_frame.mdpa"), join(ws, "frame.mdpa"));
const h = await startHost({ workspace: ws });
try {
  await openFile(h.page, "frame.mdpa");
  await h.page.waitForTimeout(1500);
  await palette(h.page, "Open Preview");
  const f = await webviewFrame(h.page);
  await h.page.waitForTimeout(3000);
  console.log((await f.innerText("#stats")).slice(0, 300));
  await h.page.screenshot({ path: join(ROOT, "out/host/smoke.png") });
} catch (e) { console.error(e); await h.page.screenshot({ path: join(ROOT, "out/host/smoke-fail.png") }); process.exitCode = 1; }
finally { await h.stop(); }
