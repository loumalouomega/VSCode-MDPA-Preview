// Harness smoke check for linked previews (roadmap item 3): the Link panel opens
// from the Advanced menu, asking to link posts `linkPick`, the preview that
// asked reports its view once (and only changed settings after that), a camera /
// field / colour-range / clip / time change from the host is applied WITHOUT
// being echoed back, a field the mesh lacks is disclosed instead of applied,
// per-setting switches post `linkSettings`, the compared-run identity rides the
// view sidecar and a restored one posts `linkRestore`. The harness has no host,
// so the hub's replies are dispatched as `message` events (the hub itself is
// covered by previewLinkHub.test.ts).
// Run after `npm run compile`, `npm run build:tests` and:
//   HARNESS_SCENE=panefields node scripts/screenshots/build-harness.mjs
//   NODE_PATH=<dir with playwright-core>/node_modules node scripts/screenshots/check-link-previews.mjs
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
const events = async (page, kind) => (await sent(page, "linkEvent")).filter((m) => m.kind === kind);
const panelText = (page) => page.$eval("#link-panel", (el) => el.textContent);
const SETTINGS = { camera: true, field: true, range: true, clip: true, time: true, timeMethod: "exact", timeTolerance: 0 };
const linkedState = (extra = {}) => ({ type: "linkState", linked: true, peers: [{ name: "run2.vtu", path: "../run2/out.vtu" }], settings: SETTINGS, candidates: 0, initiator: false, ...extra });

try {
  const a = await openPage();
  await host(a, { type: "viewLayers", layers: [] });
  await a.waitForTimeout(400);

  // ---- 1. The panel, unlinked ------------------------------------------------
  await a.click('#toolbar button[data-action="advanced"]');
  await a.click('#advanced-popup [data-action="linkPreviews"]');
  await a.waitForSelector("#link-panel", { state: "visible" });
  if (!/Not linked/.test(await panelText(a))) fail("unlinked panel should say so");
  if (await a.$eval("#link-panel input[type=checkbox]", (c) => !c.disabled)) fail("settings must be disabled until linked");
  if (!(await sent(a, "linkStateRequest")).length) fail("opening the panel should ask the host for its state");
  await a.evaluate(() => [...document.querySelectorAll("#link-panel button")].find((b) => /Link with/.test(b.textContent)).click());
  if (!(await sent(a, "linkPick")).length) fail("Link with… did not post linkPick");

  // ---- 2. Linked, as the initiator: reports its view once ----------------------
  await host(a, linkedState({ initiator: true }));
  await a.waitForTimeout(500);
  if (!/Linked with run2\.vtu/.test(await panelText(a))) fail(`panel should name the peer: ${await panelText(a)}`);
  const firstCam = await events(a, "camera");
  if (firstCam.length !== 1) fail(`the initiator should report its camera once, got ${firstCam.length}`);
  if ((await events(a, "field")).length !== 1 || (await events(a, "clip")).length !== 1 || (await events(a, "range")).length !== 1) fail("the initiator should report field, range and clip once each");
  await a.waitForTimeout(400);
  if ((await events(a, "camera")).length !== 1) fail("an unchanged view must not be re-reported");

  // ---- 3. A linked camera is applied and NOT echoed ------------------------------
  const cam = { position: [3, 4, 5], focalPoint: [0.5, 0.5, 0.5], viewUp: [0, 0, 1], parallelScale: 7 };
  await host(a, { type: "linkApply", kind: "camera", payload: cam, from: "run2.vtu" });
  await a.waitForTimeout(900);
  if ((await events(a, "camera")).length !== 1) fail("an applied camera was echoed back");
  const view = (await sent(a, "viewLayersSave")).at(-1)?.view;
  const saved = view?.panes?.[0]?.camera;
  if (!saved || JSON.stringify(saved.position) !== JSON.stringify(cam.position)) fail(`camera not applied: ${JSON.stringify(saved)}`);
  if (!view.link || view.link.peers[0] !== "../run2/out.vtu") fail(`the compared-run identity was not saved: ${JSON.stringify(view.link)}`);
  await host(a, { type: "linkApply", kind: "camera", payload: { position: [1] }, from: "x" });
  await a.waitForTimeout(300);

  // ---- 4. Field: a missing field is disclosed, a malformed payload ignored -------
  await host(a, { type: "linkApply", kind: "field", payload: { selectedKey: "Nodal:NO_SUCH", component: "mag", modes: ["contour"], deformKey: "" }, from: "run2.vtu" });
  await a.waitForTimeout(300);
  if (!/not in this mesh/.test(await panelText(a))) fail("a field the mesh lacks must be disclosed in the panel");
  if ((await events(a, "field")).length !== 1) fail("a rejected field was echoed");

  // ---- 5. Colour range and clip apply, without echo -----------------------------
  await host(a, { type: "linkApply", kind: "range", payload: { colormap: "Viridis", rangeOverride: [1, 2], log: false, bands: 5 }, from: "run2.vtu" });
  await host(a, { type: "linkApply", kind: "clip", payload: { active: true, axis: 0, flipped: false, freeNormal: [0, 0, 1], t: 0.25 }, from: "run2.vtu" });
  await a.waitForTimeout(700);
  if ((await events(a, "range")).length !== 1 || (await events(a, "clip")).length !== 1) fail("applied range/clip were echoed");
  const v2 = (await sent(a, "viewLayersSave")).at(-1).view.panes[0];
  if (v2.field.bands !== 5 || JSON.stringify(v2.field.rangeOverride) !== "[1,2]") fail(`range not applied: ${JSON.stringify(v2.field)}`);
  if (!v2.clip.active || v2.clip.axis !== 0 || v2.clip.t !== 0.25) fail(`clip not applied: ${JSON.stringify(v2.clip)}`);

  // ---- 6. Time: the host names the matched index; the frame is requested ----------
  await host(a, { type: "linkApply", kind: "time", payload: { index: 2, time: 1, delta: 0 }, from: "run2.vtu" });
  await a.waitForTimeout(200);
  const req = (await sent(a, "vtkRequestFrame")).at(-1);
  if (!req || req.frameIndex !== 2) fail(`linked time did not request frame 2: ${JSON.stringify(req)}`);
  await host(a, { type: "linkNote", message: "t = 7 has no frame in run2.vtu: no frame at exactly t = 7. It stays on its own frame." });
  await a.waitForTimeout(200);
  if (!/no frame at exactly t = 7/.test(await panelText(a))) fail("an unmatched time must be disclosed");

  // ---- 7. Per-setting switches post linkSettings ------------------------------------
  await a.evaluate(() => document.querySelectorAll("#link-panel input[type=checkbox]")[0].click());
  const st = (await sent(a, "linkSettings")).at(-1);
  if (!st || st.settings.camera !== false || st.settings.field !== true) fail(`camera switch not posted: ${JSON.stringify(st)}`);
  await host(a, linkedState({ settings: { ...SETTINGS, camera: false } }));
  await host(a, { type: "linkApply", kind: "camera", payload: { ...cam, parallelScale: 9 }, from: "run2.vtu" });
  await a.waitForTimeout(500);
  const camAfter = (await sent(a, "viewLayersSave")).at(-1).view.panes[0].camera;
  if (camAfter.parallelScale === 9) fail("a switched-off camera link must not apply");

  // ---- 7b. Pane scope and the time mapping post linkSettings ----------------------
  const scopeSegs = await a.$$("#link-panel .ui-segments .ui-seg");
  if (scopeSegs.length !== 2) fail(`pane scope track has ${scopeSegs.length} segments, expected 2 (Focused/All panes)`);
  await a.evaluate(() => [...document.querySelectorAll("#link-panel .ui-segments .ui-seg")].find((b) => /All panes/.test(b.textContent)).click());
  const scopePosted = (await sent(a, "linkSettings")).at(-1);
  if (!scopePosted || scopePosted.settings.paneScope !== "all") fail(`pane scope not posted: ${JSON.stringify(scopePosted)}`);
  await a.fill('#link-panel input[aria-label="Time offset"]', "5");
  await a.fill('#link-panel input[aria-label="Time scale"]', "1000");
  // Firing `change` commits the mapping (fill alone does not).
  await a.evaluate(() => document.querySelector('#link-panel input[aria-label="Time scale"]').dispatchEvent(new Event("change", { bubbles: true })));
  const mapPosted = (await sent(a, "linkSettings")).at(-1);
  if (!mapPosted || mapPosted.settings.timeOffset !== 5 || mapPosted.settings.timeScale !== 1000) fail(`time mapping not posted: ${JSON.stringify(mapPosted)}`);

  // ---- 8. Unlinking forgets the identity ----------------------------------------------
  await a.evaluate(() => [...document.querySelectorAll("#link-panel button")].find((b) => b.textContent === "Unlink").click());
  if (!(await sent(a, "linkUnlink")).length) fail("Unlink did not post linkUnlink");
  await host(a, { type: "linkState", linked: false, peers: [], settings: SETTINGS, candidates: 1, initiator: false });
  await a.waitForTimeout(900);
  const afterUnlink = (await sent(a, "viewLayersSave")).at(-1).view;
  if (afterUnlink.link) fail("an unlinked view must not keep the compared-run identity");
  if (a.errors.length) fail(`page errors: ${a.errors.join("; ")}`);
  const savedView = view;
  await a.close();

  // ---- 9. Reopen: the saved identity is handed to the host, and survives view saves -----
  const b = await openPage();
  await host(b, { type: "viewLayers", layers: [], view: savedView });
  await b.waitForTimeout(1000);
  const restore = (await sent(b, "linkRestore")).at(-1);
  if (!restore || restore.saved.peers[0] !== "../run2/out.vtu") fail(`restore not posted: ${JSON.stringify(restore)}`);
  if ((await sent(b, "viewLayersSave")).length) fail("restoring echoed a save");
  // Until the peer opens, a view change must not drop the remembered identity.
  await b.click('#toolbar button[data-action="viewMenu"]');
  await b.click('#view-popup [data-action="layout:1x2"]');
  await b.keyboard.press("Escape");
  await b.waitForTimeout(900);
  const later = (await sent(b, "viewLayersSave")).at(-1);
  if (later?.view?.link?.peers?.[0] !== "../run2/out.vtu") fail(`the pending identity was lost: ${JSON.stringify(later?.view?.link)}`);
  if (b.errors.length) fail(`page errors: ${b.errors.join("; ")}`);

  console.log("check-link-previews: OK");
} catch (e) {
  console.error("check-link-previews FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
