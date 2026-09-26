#!/usr/bin/env node
// Capture the render-parity scene catalog (scenes.mjs) against the CURRENT
// webview bundle (media/webview.js): one PNG of #render-root and one JSON
// sidecar per scene, under out/render-parity/<label>/.
//
//   npm run compile && npm run build:tests
//   NODE_PATH=<dir with playwright-core> node scripts/render-parity/capture.mjs --label vtkjs-pre [--only a0] [--skip-build]
//
// Every scene gets a fresh page, so no state leaks from one to the next. The
// harness is built once per mesh environment into out/render-parity/harness/<env>/.
// Chromium runs with SwiftShader like every other harness script; the parity
// question is "did this change alter what is drawn", which a deterministic
// software rasterizer answers better than a GPU would.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENVS, SCENES } from "./scenes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const require = createRequire(import.meta.url);

function resolvePlaywright() {
  for (const c of ["playwright-core", join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright-core not found — npm-install it somewhere and pass NODE_PATH");
}

function arg(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

export function harnessDir(env) {
  return join(ROOT, "out", "render-parity", "harness", env);
}

export function buildHarness(env, extraEnv = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "screenshots", "build-harness.mjs")], {
    cwd: ROOT,
    env: { ...process.env, ...ENVS[env], ...extraEnv, HARNESS_OUT: harnessDir(env) },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`build-harness (${env}) failed:\n${r.stderr || r.stdout}`);
}

const SETTLE_MS = 500;

async function runAction(page, root, a) {
  if (a.ui) await page.evaluate((action) => window.postMessage({ type: "uiAction", action }, "*"), a.ui);
  else if (a.msg) await page.evaluate((m) => window.postMessage(m, "*"), a.msg);
  else if (a.click) await page.click(a.click, { timeout: 10_000 });
  else if (a.key) await page.keyboard.press(a.key);
  else if (a.select) await page.selectOption(a.select[0], a.select[1], { timeout: 10_000 });
  else if (a.canvasClick) {
    const box = await root.boundingBox();
    await page.mouse.click(box.x + box.width * a.canvasClick[0], box.y + box.height * a.canvasClick[1]);
  } else if (a.wait) await page.waitForTimeout(a.wait);
}

export async function runScene(browser, scene, { harness = harnessDir(scene.env), width = 1400, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scene.dpr ?? 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`.slice(0, 300)));
  await page.goto(pathToFileURL(join(harness, "index.html")).href);
  await page.waitForSelector("#app", { state: "visible", timeout: 60_000 });
  await page.waitForTimeout(2500);
  const root = page.locator("#render-root");
  const actionErrors = [];
  for (const a of scene.actions) {
    try {
      await runAction(page, root, a);
    } catch (e) {
      // Recorded, not fatal: a missing control is itself a parity signal, and
      // one broken scene must not cost the rest of the catalog.
      actionErrors.push(`${JSON.stringify(a)}: ${String(e.message || e).split("\n")[0]}`);
    }
    await page.waitForTimeout(SETTLE_MS);
  }
  await page.waitForTimeout(1000);
  const png = await root.screenshot({ animations: "disabled" });
  const sidecar = await page.evaluate((recordSels) => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el && el.offsetParent !== null ? el.innerText : null;
    };
    const rec = {};
    for (const s of recordSels) rec[s] = text(s);
    return {
      stats: text("#stats"),
      record: rec,
      sentTypes: (window.SENT_MESSAGES ?? []).map((m) => m.type),
    };
  }, scene.record ?? []);
  await context.close();
  return { png, sidecar: { ...sidecar, actionErrors, consoleErrors } };
}

async function main() {
  const argv = process.argv.slice(2);
  const label = arg(argv, "label", undefined);
  if (!label) throw new Error("--label <name> is required");
  const only = arg(argv, "only", "");
  const scenes = SCENES.filter((s) => s.id.startsWith(only));
  const outDir = join(ROOT, "out", "render-parity", label);
  mkdirSync(outDir, { recursive: true });
  if (!argv.includes("--skip-build")) {
    for (const env of new Set(scenes.map((s) => s.env))) buildHarness(env);
  }
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const index = {};
  for (const scene of scenes) {
    const t0 = Date.now();
    const { png, sidecar } = await runScene(browser, scene);
    writeFileSync(join(outDir, `${scene.id}.png`), png);
    writeFileSync(join(outDir, `${scene.id}.json`), JSON.stringify(sidecar, null, 2));
    index[scene.id] = { ms: Date.now() - t0, errors: sidecar.consoleErrors.length };
    console.log(`${scene.id.padEnd(24)} ${String(Date.now() - t0).padStart(6)} ms  errors=${sidecar.consoleErrors.length}${sidecar.actionErrors.length ? `  ACTION-ERRORS: ${sidecar.actionErrors.join(" | ")}` : ""}`);
  }
  await browser.close();
  writeFileSync(join(outDir, "index.json"), JSON.stringify({ label, date: new Date().toISOString(), scenes: index }, null, 2));
  console.log(`-> ${outDir}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
