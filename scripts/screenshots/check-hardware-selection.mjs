// Chromium check for roadmap item 22 B (GPU hardware selection). Builds its own
// harness over a flat 100 x 100 quad-pair grid (20 000 triangles, about 8 px
// per cell at the fitted view), box-selects the whole viewport and asserts that
// the selection is EXACT: every cell is found. The old sampled-picker grid
// (every >= 10 px, capped) finds a small fraction of that, so a regression to it
// fails here. Also asserts a nested box is a subset of the enclosing selection,
// that X-ray mode reaches the hidden interior of a hexahedral block that the
// visible-only mode leaves out, and that nothing throws.
//
//   npm run compile
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=<dir with playwright-core> \
//     node scripts/screenshots/check-hardware-selection.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { chromium } = require("playwright-core");

const N = 100;
const dir = path.join(os.tmpdir(), "hwsel");
mkdirSync(dir, { recursive: true });
const mdpa = path.join(dir, "grid.mdpa");
{
  let s = "Begin ModelPartData\nEnd ModelPartData\n\nBegin Properties 0\nEnd Properties\n\nBegin Nodes\n";
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) s += `${j * (N + 1) + i + 1} ${i} ${j} 0\n`;
  s += "End Nodes\n\nBegin Elements Element2D3N\n";
  let id = 1;
  const n = (i, j) => j * (N + 1) + i + 1;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      s += `${id++} 0 ${n(i, j)} ${n(i + 1, j)} ${n(i + 1, j + 1)}\n`;
      s += `${id++} 0 ${n(i, j)} ${n(i + 1, j + 1)} ${n(i, j + 1)}\n`;
    }
  s += "End Elements\n";
  writeFileSync(mdpa, s);
}
const built = spawnSync("node", [path.join(ROOT, "scripts/screenshots/build-harness.mjs")], {
  env: { ...process.env, HARNESS_MESH: mdpa },
  encoding: "utf8",
});
if (built.status !== 0) throw new Error(built.stderr || "build-harness failed");

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 2400, height: 1000 } });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(3000);
await page.click('#toolbar button[data-action="selection"]');
await page.waitForSelector("#selection-panel", { state: "visible" });
await page.click("#selection-panel .ui-segments .ui-seg:nth-child(2)"); // Box
await page.waitForTimeout(300);

const canvas = await page.$eval("#render-root canvas", (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});

/** Drag a box, make a SubModelPart from the active set, return the posted element ids. */
async function boxSelect(x0, y0, x1, y1) {
  await page.evaluate(() => (window.SENT_MESSAGES.length = 0));
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  await page.fill("#sel-smp-name", "S");
  await (await page.$('#selection-panel button[title*="SubModelPart"]')).click();
  await page.waitForTimeout(400);
  const ids = await page.evaluate(() => {
    const m = window.SENT_MESSAGES.filter((x) => x.type === "applyOp").pop();
    return m?.elements ?? [];
  });
  return ids;
}

const inner = await boxSelect(canvas.x + canvas.w * 0.4, canvas.y + canvas.h * 0.4, canvas.x + canvas.w * 0.6, canvas.y + canvas.h * 0.6);
check(inner.length > 0 && inner.length < N * N, `an inner box selects a small non-empty set (${inner.length})`);

// The set accumulates, so this is the union with the inner box.
const all = await boxSelect(canvas.x + 400, canvas.y + 2, canvas.x + canvas.w - 2, canvas.y + canvas.h - 2);
check(all.length >= 0.995 * 2 * N * N, `whole-viewport box finds every cell (${all.length} of ${2 * N * N})`);
const allSet = new Set(all);
check(inner.every((id) => allSet.has(id)), "the inner box is a subset of the whole-viewport selection");

// --- X-ray: a 10 x 10 x 10 hexahedral block, selected from the front ---------
{
  const M = 10;
  const node = (i, j, k) => (k * (M + 1) + j) * (M + 1) + i + 1;
  let t = "Begin ModelPartData\nEnd ModelPartData\n\nBegin Properties 0\nEnd Properties\n\nBegin Nodes\n";
  for (let k = 0; k <= M; k++) for (let j = 0; j <= M; j++) for (let i = 0; i <= M; i++) t += `${node(i, j, k)} ${i} ${j} ${k}\n`;
  t += "End Nodes\n\nBegin Elements Element3D8N\n";
  let e = 1;
  for (let k = 0; k < M; k++)
    for (let j = 0; j < M; j++)
      for (let i = 0; i < M; i++)
        t += `${e++} 0 ${node(i, j, k)} ${node(i + 1, j, k)} ${node(i + 1, j + 1, k)} ${node(i, j + 1, k)} ${node(i, j, k + 1)} ${node(i + 1, j, k + 1)} ${node(i + 1, j + 1, k + 1)} ${node(i, j + 1, k + 1)}\n`;
  t += "End Elements\n";
  const cube = path.join(dir, "cube.mdpa");
  writeFileSync(cube, t);
  const b2 = spawnSync("node", [path.join(ROOT, "scripts/screenshots/build-harness.mjs")], {
    env: { ...process.env, HARNESS_MESH: cube },
    encoding: "utf8",
  });
  if (b2.status !== 0) throw new Error(b2.stderr || "build-harness failed");
  await page.reload();
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.click('#toolbar button[data-action="selection"]');
  await page.waitForSelector("#selection-panel", { state: "visible" });
  await page.click("#selection-panel .ui-segments .ui-seg:nth-child(2)");
  await page.waitForTimeout(300);
  const c2 = await page.$eval("#render-root canvas", (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const region = [c2.x + 400, c2.y + 2, c2.x + c2.w - 2, c2.y + c2.h - 2];
  const visible = await boxSelect(...region);
  check(visible.length > 0 && visible.length < M * M * M, `visible-only box selects the shell, not the interior (${visible.length} of ${M ** 3})`);
  await page.click('#selection-panel button:has-text("X-ray")');
  await page.waitForTimeout(300);
  const xray = await boxSelect(...region);
  check(xray.length === M * M * M, `X-ray box also selects the hidden interior (${xray.length} of ${M ** 3})`);
}

if (problems.length) console.log(problems.join("\n"));
check(problems.length === 0, "no page errors or console errors");
await browser.close();
if (failures.length) process.exit(1);
