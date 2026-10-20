// Chromium smoke check for the bottom-left panel cluster (roadmap item 1,
// the panel docking and overflow increment).
//
// The bug it locks down: the Selection card and the two wide strips (the
// Probe chart and the Plot-over-time chart) used to be positioned
// independently, so a chart painted over the card's lower half and swallowed
// its clicks. Measured before the fix, at 1680x1000, the Probe strip covered
// Selection's "Delete entities" and "Clear" buttons, the whole seed builder
// and its "Add set" button. The KKSS embedding reproduced the same thing
// (a probe chart over the Selection panel's Box control).
//
// What it asserts, for each viewport size:
//   1. No control of the Selection panel is covered by another panel — every
//      one is the topmost element at its own centre (elementFromPoint).
//   2. The panels do not overlap each other.
//   3. Everything stays inside the viewport.
//   4. The card keeps its width, so its controls stay usable.
//   5. A draft typed into the card survives a resize (the layout only MOVES
//      the panels; it never re-renders their contents).
//
// Run after `npm run compile` and `npm run build:tests`:
//   HARNESS_MESH=example/VTK/Main_0_2.vtk node scripts/screenshots/build-harness.mjs
//   NODE_PATH=<dir with playwright-core>/node_modules node scripts/screenshots/check-panel-dock.mjs
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

const VIEWPORTS = [
  { width: 1680, height: 1000 },
  { width: 1280, height: 700 },
  { width: 1000, height: 650 },
];

/** The panels in the cluster, and the id the check reads them by. */
const PANELS = ["selection-panel", "probe-panel", "series-panel"];

const browser = await chromium.launch({
  executablePath: chromiumOf(),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: VIEWPORTS[0] });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const fail = (m) => {
  throw new Error(m);
};

/** Opens the Selection panel and fills it, so the card is at its tallest. */
async function openSelection() {
  await page.click('#toolbar button[data-action="selection"]');
  await page.waitForSelector("#selection-panel", { state: "visible", timeout: 5000 });
  await page.waitForTimeout(300);
  // A Ctrl+click creates the auto set, which renders the panel's full body
  // (the action rows and the seed builder) instead of just the hint.
  const box = await page.$eval("#render-root", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5);
  await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("Control");
  await page.waitForTimeout(500);
}

/** Opens the Probe chart: Inspect, "Probe line", then two picks on the mesh. */
async function openProbe() {
  await page.click('#toolbar button[data-action="inspect"]');
  await page.waitForTimeout(400);
  const btn = await page.$('#inspect-panel button:has-text("Probe line")');
  if (!btn) fail("the Inspect panel has no Probe line button");
  await btn.click();
  await page.waitForTimeout(300);
  const box = await page.$eval("#render-root", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  for (const [fx, fy] of [[0.5, 0.5], [0.6, 0.45]]) {
    await page.mouse.click(box.x + box.w * fx, box.y + box.h * fy);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1200);
}

/** The geometry of every panel, in the page's own coordinates. */
async function geometry() {
  return page.evaluate((ids) => {
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el || el.style.display === "none") {
        out[id] = null;
        continue;
      }
      const r = el.getBoundingClientRect();
      out[id] = { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
    }
    return out;
  }, PANELS);
}

/** Every control of the Selection panel, and what covers it. */
async function coverage() {
  return page.evaluate(() => {
    const panel = document.getElementById("selection-panel");
    if (!panel) return [];
    const pr = panel.getBoundingClientRect();
    const out = [];
    for (const el of panel.querySelectorAll("button, input, select")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Only the part of the control that is actually inside the card.
      if (r.bottom < pr.top || r.top > pr.bottom) continue;
      const x = r.left + r.width / 2;
      const y = Math.min(Math.max(r.top + r.height / 2, pr.top + 2), pr.bottom - 2);
      const hit = document.elementFromPoint(x, y);
      out.push({
        label: (el.textContent ?? "").trim().slice(0, 24) || el.id || el.getAttribute("aria-label") || el.tagName,
        x: Math.round(x),
        y: Math.round(y),
        covered: !!(hit && !hit.closest("#selection-panel")),
        hit: hit ? hit.tagName + (hit.id ? `#${hit.id}` : "") : "none",
      });
    }
    return out;
  });
}

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

try {
  await page.goto("file://" + path.join(harnessDir, "index.html"));
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => (document.getElementById("stats")?.textContent ?? "").length > 0, { timeout: 30000 });
  await page.waitForTimeout(800);

  await openSelection();
  await openProbe();

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(700);

    const geo = await geometry();
    const sel = geo["selection-panel"];
    if (!sel) fail(`the Selection panel is not open at ${vp.width}x${vp.height}`);
    if (sel.w < 299) fail(`the Selection card was squeezed to ${Math.round(sel.w)}px at ${vp.width}x${vp.height}`);

    // 2. The panels do not overlap each other.
    for (const id of PANELS) {
      const a = geo[id];
      if (!a) continue;
      for (const other of PANELS) {
        if (other === id) continue;
        const b = geo[other];
        if (!b) continue;
        if (overlaps(a, b)) {
          fail(`${id} overlaps ${other} at ${vp.width}x${vp.height}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        }
      }
    }

    // 3. Everything stays inside the viewport.
    for (const id of PANELS) {
      const p = geo[id];
      if (!p) continue;
      if (p.top < -1 || p.left < -1) fail(`${id} is outside the viewport at ${vp.width}x${vp.height}: ${JSON.stringify(p)}`);
      if (p.right > vp.width + 1) fail(`${id} runs past the right edge at ${vp.width}x${vp.height}: ${JSON.stringify(p)}`);
    }

    // 1. No control of the Selection panel is covered by another panel.
    const covered = (await coverage()).filter((c) => c.covered);
    if (covered.length > 0) {
      fail(
        `the Probe chart covers ${covered.length} Selection control(s) at ${vp.width}x${vp.height}: ` +
          covered.map((c) => `${c.label} (hit ${c.hit})`).join(", ")
      );
    }
    console.log(`ok: ${vp.width}x${vp.height} — the panels do not overlap and every Selection control is reachable`);
  }

  // 5. A draft typed into the card survives a resize: the layout only moves
  //    the panels, it never re-renders their contents.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(500);
  const nameInput = await page.$("#sel-seed-name");
  if (nameInput) {
    await nameInput.fill("Draft name");
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(700);
    const kept = await page.$eval("#sel-seed-name", (e) => e.value);
    if (kept !== "Draft name") fail(`the draft was lost across a resize: ${JSON.stringify(kept)}`);
    console.log("ok: a draft typed into the card survives a resize");
  }

  if (pageErrors.length) fail(`page errors: ${pageErrors.join(" | ")}`);
  console.log("PASS");
} catch (e) {
  console.error("FAIL:", e?.message ?? e);
  if (pageErrors.length) console.error("page errors:", pageErrors.join(" | "));
  process.exitCode = 1;
} finally {
  await browser.close();
}
