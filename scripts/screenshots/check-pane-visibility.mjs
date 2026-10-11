// Harness smoke check for per-pane layer visibility (roadmap item 3): in a
// split layout every outline row gets a "panes" popup, hiding a layer in one
// pane leaves the others drawing it, the master checkbox keeps its meaning
// (off hides everywhere, and ticking it back keeps the pane scope), the scope
// is saved in the view sidecar and restored without echoing a save, and a
// layout switch reseeds every pane from the kept pane. Panes are judged by
// pixels: an emptied pane compresses to a far smaller PNG than one drawing a
// mesh, and an untouched pane screenshots byte-identically.
// Run after `npm run compile`, `npm run build:tests` and:
//   HARNESS_SCENE=panefields node scripts/screenshots/build-harness.mjs
//   NODE_PATH=<dir with playwright-core>/node_modules node scripts/screenshots/check-pane-visibility.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
const hostSends = (page, msg) => page.evaluate((m) => window.postMessage(m, "*"), msg);
const layout = async (page, id) => {
  await page.click('#toolbar button[data-action="viewMenu"]');
  await page.click(`#view-popup [data-action="layout:${id}"]`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
};

/** A pane's pixels: PNG bytes of its half of the render root. `side`: left/right/top/bottom. */
async function pane(page, side) {
  const box = await (await page.$("#render-root")).boundingBox();
  const half = { left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5] }[side];
  // Stay clear of the nav dock and the toolbar so only the pane's viewport is compared.
  const clip = {
    x: box.x + half[0] * box.width + 10,
    y: box.y + half[1] * box.height + 70,
    width: half[2] * box.width - 20,
    height: half[3] * box.height - 200,
  };
  const png = await page.screenshot({ clip });
  return { size: png.length, hash: crypto.createHash("sha1").update(png).digest("hex") };
}

/** Opens the panes popup of the n-th layer row and sets pane `index` to `shown`. */
async function setPane(page, rowIndex, index, shown) {
  await page.evaluate((i) => document.querySelectorAll("#outline .outline-pane-btn")[i].click(), rowIndex);
  await page.waitForSelector(".outline-pane-menu");
  await page.evaluate(({ index, shown }) => {
    const box = document.querySelectorAll(".outline-pane-menu input[type=checkbox]")[index];
    if (box.checked !== shown) box.click();
  }, { index, shown });
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.body.click());
  await page.waitForTimeout(150);
}
const paneButtons = (page) => page.$$eval("#outline .outline-pane-btn", (b) => b.length);
const masterChecks = (page) => page.$$eval("#outline .outline-row:has(.outline-pane-btn) > input[type=checkbox]", (c) => c.map((x) => x.checked));

try {
  const a = await openPage();
  await hostSends(a, { type: "viewLayers", layers: [] });
  await a.waitForTimeout(500);

  // ---- 1. Single pane: no scope control at all --------------------------
  if ((await paneButtons(a)) !== 0) fail("a single-pane layout must not show the panes control");

  // ---- 2. Split: the control appears, both panes draw ---------------------
  await layout(a, "1x2");
  const n = await paneButtons(a);
  if (n < 1) fail("no panes control in a split layout");
  const base = { left: await pane(a, "left"), right: await pane(a, "right") };
  const checked = (await masterChecks(a)).filter(Boolean).length;
  if (checked < 1) fail("the fixture has no visible layer to scope");
  // Reference for "nothing drawn": the same pane with every layer switched off.
  await a.evaluate(() => document.querySelectorAll("#outline .outline-row:has(.outline-pane-btn) > input[type=checkbox]:checked").forEach((c) => c.click()));
  await a.waitForTimeout(300);
  const empty = { left: await pane(a, "left"), right: await pane(a, "right") };
  await a.evaluate(() => document.querySelectorAll("#outline .outline-row:has(.outline-pane-btn) > input[type=checkbox]:not(:checked)").forEach((c) => c.click()));
  await a.waitForTimeout(300);
  /** "Draws something": not byte-identical to the same pane drawing nothing (the render is deterministic). */
  const draws = (p, ref) => p.hash !== ref.hash && p.size > ref.size;
  if (!draws(base.left, empty.left) || !draws(base.right, empty.right)) fail(`panes should both draw the mesh (sizes ${base.left.size}/${base.right.size} vs empty ${empty.left.size}/${empty.right.size})`);

  // ---- 3. Hide every visible layer in pane 2 only --------------------------
  const rows = await a.$$eval("#outline .outline-row:has(.outline-pane-btn)", (r) => r.map((x) => x.querySelector("input[type=checkbox]").checked));
  for (let i = 0; i < rows.length; i++) if (rows[i]) await setPane(a, i, 1, false);
  await a.waitForTimeout(400);
  const hidden = { left: await pane(a, "left"), right: await pane(a, "right") };
  if (hidden.left.hash !== base.left.hash) fail("hiding in pane 2 changed pane 1");
  if (draws(hidden.right, empty.right)) fail(`pane 2 still draws (${hidden.right.size} vs empty ${empty.right.size})`);
  const badge = await a.$$eval("#outline .outline-pane-scope:not([hidden])", (b) => b.map((x) => x.textContent));
  if (badge.length < 1 || badge.some((t) => t !== "1")) fail(`at-rest badge should read "1" (drawn in pane 1 only), got ${JSON.stringify(badge)}`);
  if ((await masterChecks(a)).filter(Boolean).length !== checked) fail("pane scope must not change the master checkboxes");
  await a.waitForTimeout(700);
  const saves = await sent(a, "viewLayersSave");
  const scoped = saves.at(-1)?.view?.layerPaneHidden;
  if (!scoped || !Object.values(scoped).every((h) => JSON.stringify(h) === "[1]")) fail(`scope not saved: ${JSON.stringify(scoped)}`);
  if ((await sent(a, "applyOp")).length) fail("pane scope posted an applyOp");

  // ---- 4. The master checkbox is still the master ---------------------------
  await a.evaluate(() => document.querySelectorAll("#outline .outline-row:has(.outline-pane-btn) > input[type=checkbox]:checked").forEach((c) => c.click()));
  await a.waitForTimeout(300);
  const off = await pane(a, "left");
  if (draws(off, empty.left)) fail("master off should hide the layer in every pane");
  await a.evaluate(() => document.querySelectorAll("#outline .outline-row:has(.outline-pane-btn) > input[type=checkbox]:not(:checked)").forEach((c) => c.click()));
  await a.waitForTimeout(300);
  const back = { left: await pane(a, "left"), right: await pane(a, "right") };
  if (back.left.hash !== base.left.hash) fail("master back on should restore pane 1");
  if (draws(back.right, empty.right)) fail("master back on must keep the pane scope (pane 2 still hidden)");

  // ---- 5. A layout switch reseeds every pane from the kept (focused) pane ----
  await layout(a, "2x1");
  const stacked = { top: await pane(a, "top"), bottom: await pane(a, "bottom") };
  const toggleMasters = (on) =>
    a.evaluate((want) => document.querySelectorAll(`#outline .outline-row:has(.outline-pane-btn) > input[type=checkbox]${want ? ":not(:checked)" : ":checked"}`).forEach((c) => c.click()), on);
  await toggleMasters(false);
  await a.waitForTimeout(300);
  const stackedEmpty = { top: await pane(a, "top"), bottom: await pane(a, "bottom") };
  await toggleMasters(true);
  await a.waitForTimeout(300);
  if (!draws(stacked.top, stackedEmpty.top) || !draws(stacked.bottom, stackedEmpty.bottom)) {
    fail(`kept pane 1 shows the layer, so every new pane must (sizes ${stacked.top.size}/${stacked.bottom.size})`);
  }
  if (a.errors.length) fail(`page errors: ${a.errors.join("; ")}`);

  // ---- 6. Scope again, then restore it on a fresh page ------------------------
  await layout(a, "1x2");
  const rows2 = await a.$$eval("#outline .outline-row:has(.outline-pane-btn)", (r) => r.map((x) => x.querySelector("input[type=checkbox]").checked));
  for (let i = 0; i < rows2.length; i++) if (rows2[i]) await setPane(a, i, 1, false);
  await a.waitForTimeout(900);
  const view = (await sent(a, "viewLayersSave")).at(-1).view;
  await a.close();

  const b = await openPage();
  await hostSends(b, { type: "viewLayers", layers: [], view });
  await b.waitForTimeout(1200);
  const restored = { left: await pane(b, "left"), right: await pane(b, "right") };
  if (draws(restored.right, empty.right)) fail(`restored scope should leave pane 2 empty (${restored.left.size}/${restored.right.size} vs empty ${empty.right.size})`);
  if ((await sent(b, "viewLayersSave")).length) fail("restore echoed a viewLayersSave");
  const restoredBadge = await b.$$eval("#outline .outline-pane-scope:not([hidden])", (x) => x.length);
  if (restoredBadge < 1) fail("restored scope shows no at-rest badge");

  // ---- 7. A scope naming a layer the mesh lacks degrades, never applies --------
  const c = await openPage();
  const stale = JSON.parse(JSON.stringify(view));
  stale.layerPaneHidden = { "block:Elements:NoSuchBlock": [1] };
  await hostSends(c, { type: "viewLayers", layers: [], view: stale });
  await c.waitForTimeout(800);
  const toastText = await c.$eval("#message", (el) => el.textContent);
  if (!/no longer match a layer/.test(toastText)) fail(`vanished scoped layer not reported: ${JSON.stringify(toastText)}`);
  const staleSides = { left: await pane(c, "left"), right: await pane(c, "right") };
  if (!draws(staleSides.right, empty.right)) fail("a stale scope must not hide anything");
  if (b.errors.length || c.errors.length) fail(`page errors: ${[...b.errors, ...c.errors].join("; ")}`);

  console.log("check-pane-visibility: OK");
} catch (e) {
  console.error("check-pane-visibility FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
