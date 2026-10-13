// Harness smoke check for in-preview comparison (roadmap item 3): the
// Advanced ▸ Compare in split… entry posts `comparePick` for the focused
// pane, a host `compareModel` installs the peer as outline `Compare:` layers
// without posting an edit, the compare pane follows the shared field, the
// saved view carries the per-pane peer identity, reopening re-asks the host
// for it, and toggling the entry clears it again. Run after `npm run compile`
// and (panefields scene, for a primary with real fields):
//   HARNESS_SCENE=panefields node scripts/screenshots/build-harness.mjs
//   NODE_PATH=<dir with playwright-core>/node_modules node scripts/screenshots/check-compare-split.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const harnessDir = path.resolve(process.cwd(), "out/screenshot-harness");

function chromiumOf() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const base of [path.join(process.env.HOME ?? "~", ".cache", "ms-playwright"), "/opt/pw-browsers"]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

const browser = await chromium.launch({
  executablePath: chromiumOf(),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const fail = (m) => { throw new Error(m); };

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(800);
  return page;
}
const sent = (page, type) => page.evaluate((t) => (window.SENT_MESSAGES ?? []).filter((m) => m.type === t), type);
const host = (page, msg) => page.evaluate((m) => window.postMessage(m, "*"), msg);

// A small peer sharing the primary's PRESSURE variable under its own ids.
const peerOf = (key) => {
  const sep = key.indexOf(":");
  const kind = sep < 0 ? "Nodal" : key.slice(0, sep);
  const variable = sep < 0 ? key : key.slice(sep + 1);
  return {
    nodeIds: new Int32Array([101, 102, 103, 104]),
    coords: new Float32Array([0, 0, 0, 3, 0, 0, 3, 3, 0, 0, 3, 0]),
    blocks: [{
      kind: "Elements", name: "Element2D3N", vtkCellType: 5, stride: 3, count: 2,
      connectivity: new Int32Array([101, 102, 103, 101, 103, 104]),
      entityIds: new Int32Array([101, 102]),
    }],
    subModelParts: [],
    fields: [{
      kind, variable, components: 1,
      ids: new Int32Array([101, 102, 103, 104]),
      values: new Float32Array([10, 20, 30, 40]),
    }],
    bounds: { min: [0, 0, 0], max: [3, 3, 0] },
    diagnostics: [],
  };
};

try {
  const a = await openPage();
  await host(a, { type: "viewLayers", layers: [] });
  await a.waitForTimeout(400);

  // ---- 1. A split layout, then compare in the right pane -------------------
  await a.click('#toolbar button[data-action="viewMenu"]');
  await a.click('#view-popup [data-action="layout:1x2"]');
  await a.keyboard.press("Escape");
  await a.waitForTimeout(400);
  // Focus the right pane (the latch follows the pointer, not the menu).
  const rect = await a.$eval("#render-root canvas", (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  await a.mouse.click(rect.x + rect.width * 0.75, rect.y + rect.height * 0.5);
  await a.waitForTimeout(300);
  await a.click('#toolbar button[data-action="advanced"]');
  await a.click('#advanced-popup [data-action="compareSplit"]');
  await a.waitForTimeout(300);
  const pick = (await sent(a, "comparePick")).at(-1);
  if (!pick || pick.paneIndex !== 1) fail(`comparePick not posted for pane 1: ${JSON.stringify(pick)}`);
  console.log("ok: comparePick posted for the focused pane");

  // ---- 2. The host answers: peer layers install, nothing is edited ---------
  await a.click('#toolbar button[data-action="field"]');
  await a.waitForTimeout(400);
  const before = await a.$eval("#field-panel select", (el) => el.value);
  if (!before) fail("no field selected in the panefields scene");
  await host(a, { type: "compareModel", paneIndex: 1, model: peerOf(before), fileName: "other.mdpa", peer: "../peer/other.mdpa", warnings: [] });
  await a.waitForTimeout(1000);
  const outline = await a.$eval("#outline", (el) => el.textContent ?? "");
  if (!/Compare: other\.mdpa/.test(outline)) fail(`no Compare section in the outline: ${outline.slice(0, 200)}`);
  if ((await sent(a, "applyOp")).length) fail("installing a compare posted an applyOp");
  const after = await a.$eval("#field-panel select", (el) => el.value);
  if (after !== before) fail(`compare pane did not follow the shared field (was ${before}, now ${after})`);
  const saved = (await sent(a, "viewLayersSave")).at(-1)?.view;
  if (saved?.panes?.[1]?.comparePeer !== "../peer/other.mdpa") fail(`peer identity not saved: ${JSON.stringify(saved?.panes?.map((p) => p.comparePeer))}`);
  if (saved?.panes?.[0]?.comparePeer) fail("the primary pane must not carry a peer identity");
  console.log("ok: peer installed, field followed, identity saved");
  if (a.errors.length) fail(`page errors: ${a.errors.join("; ")}`);
  await a.close();

  // ---- 3. Reopen: the identity is handed to the host, then reinstalled -----
  const b = await openPage();
  await host(b, { type: "viewLayers", layers: [], view: saved });
  await b.waitForTimeout(1000);
  const restore = (await sent(b, "compareRestore")).at(-1);
  if (!restore || restore.peer !== "../peer/other.mdpa" || restore.paneIndex !== 1) fail(`restore not posted: ${JSON.stringify(restore)}`);
  if ((await sent(b, "viewLayersSave")).length) fail("restore echoed a save before the peer arrived");
  if ((await sent(b, "applyOp")).length) fail("restore posted an applyOp");
  // The peer is gone from disk: the pane reports it and stays usable.
  await host(b, { type: "compareNote", message: 'Could not read "other.mdpa" for comparison: ENOENT' });
  await b.waitForTimeout(400);
  if (!/Could not read/.test(await b.$eval("#message", (el) => el.textContent ?? ""))) fail("an unloadable peer was not reported");
  // ...while a peer that does arrive installs without an edit.
  await host(b, { type: "viewLayers", layers: [] });
  await host(b, { type: "compareModel", paneIndex: 1, model: peerOf("Nodal:PRESSURE"), fileName: "other.mdpa", peer: "../peer/other.mdpa", warnings: [] });
  await b.waitForTimeout(1000);
  if (!/Compare: other\.mdpa/.test(await b.$eval("#outline", (el) => el.textContent ?? ""))) fail("reinstalled peer missing from the outline");
  if ((await sent(b, "applyOp")).length) fail("reinstall posted an applyOp");
  if (b.errors.length) fail(`page errors: ${b.errors.join("; ")}`);
  console.log("ok: restore re-asks the host; a missing peer is reported, a present one installs");
  await b.close();

  // ---- 4. Toggling the entry in the compare pane clears it -----------------
  const c = await openPage();
  await host(c, { type: "viewLayers", layers: [] });
  await c.waitForTimeout(400);
  await c.click('#toolbar button[data-action="viewMenu"]');
  await c.click('#view-popup [data-action="layout:1x2"]');
  await c.keyboard.press("Escape");
  await c.waitForTimeout(300);
  await host(c, { type: "compareModel", paneIndex: 0, model: peerOf("Nodal:PRESSURE"), fileName: "other.mdpa", peer: "../peer/other.mdpa", warnings: [] });
  await c.waitForTimeout(900);
  if (!/Compare: other\.mdpa/.test(await c.$eval("#outline", (el) => el.textContent ?? ""))) fail("peer did not install in pane 0");
  // Focus pane 0 (its canvas half) and toggle the same entry: it clears.
  const rectC = await c.$eval("#render-root canvas", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  await c.mouse.click(rectC.x + rectC.width * 0.25, rectC.y + rectC.height * 0.5);
  await c.waitForTimeout(300);
  await c.click('#toolbar button[data-action="advanced"]');
  await c.click('#advanced-popup [data-action="compareSplit"]');
  await c.waitForTimeout(900);
  if (/Compare: other\.mdpa/.test(await c.$eval("#outline", (el) => el.textContent ?? ""))) fail("toggling did not clear the compare");
  const cleared = (await sent(c, "viewLayersSave")).at(-1)?.view;
  if ((cleared?.panes ?? []).some((p) => p.comparePeer)) fail("a cleared compare kept its identity");
  if (c.errors.length) fail(`page errors: ${c.errors.join("; ")}`);
  console.log("ok: toggling in the compare pane clears it and drops the identity");

  console.log("check-compare-split: OK");
} catch (e) {
  console.error("check-compare-split FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
