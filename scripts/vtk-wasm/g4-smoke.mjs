#!/usr/bin/env node
// G4 smoke check for the experimental VTK-wasm renderer (roadmap item 18,
// Phase 4), in Chromium over the screenshot harness. Every check FAILS
// loudly rather than passing vacuously; results go to
// out/vtk-wasm-eval/results/g4-smoke.json.
//
//   npm run compile && npm run build:tests
//   NODE_PATH=<dir with playwright-core> node scripts/vtk-wasm/g4-smoke.mjs
//
// 1. boot: the VTK-wasm backend (not the fallback) draws under the REAL
//    preview CSP with zero violations, zero console errors and zero backend
//    warnings, and fetches nothing but same-origin assets.
// 2. screenshot: View > Screenshot posts a non-blank PNG.
// 3. recording: a 5-frame PNG turntable posts 5 non-blank frames in order.
// 4. inspect: 20 fixed Inspect clicks hit or miss exactly where the vtk.js
//    backend does. Entity agreement is REPORTED, not gated: vtk.js picks with
//    a 2.5%-of-diagonal tolerance and is not ground truth (an exact ray cast
//    over this mesh showed the backends' remaining disagreements are near-edge
//    clicks where that tolerance lets a neighbouring triangle win — see
//    doc/vtk-wasm-migration.md, Phase 4).
// 5. fallbacks: without WebAssembly.Suspending (JSPI) and with a corrupt
//    .wasm, the preview still renders — on vtk.js — and says why.
//
// The host-side fallback (runtime missing from the installation) is decided
// before any page exists and is covered by src/test/rendererSelect.test.ts
// and previewHtml.test.ts.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer } from "./serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const require = createRequire(import.meta.url);

function playwright() {
  for (const c of ["playwright-core", join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright-core not found — npm-install it somewhere and pass NODE_PATH");
}

function buildHarness(out, env) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "screenshots", "build-harness.mjs")], {
    cwd: ROOT,
    env: { ...process.env, ...env, HARNESS_OUT: out },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`build-harness failed:\n${r.stderr || r.stdout}`);
}

const WASM_DIR = join(ROOT, "out", "vtk-wasm-eval", "g4-harness-wasm");
const JS_DIR = join(ROOT, "out", "vtk-wasm-eval", "g4-harness-vtkjs");

async function openPage(browser, url, { init, route } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const log = { errors: [], warnings: [] };
  page.on("console", (m) => {
    if (m.type() === "error") log.errors.push(m.text().slice(0, 300));
    else if (m.type() === "warning" && m.text().startsWith("VTK-wasm")) log.warnings.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => log.errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.CSP_VIOLATIONS = [];
    document.addEventListener("securitypolicyviolation", (e) => window.CSP_VIOLATIONS.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  if (init) await page.addInitScript(init);
  if (route) await page.route(route.pattern, route.handler);
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForSelector("#app", { state: "visible", timeout: 90_000 });
  await page.waitForTimeout(1500);
  return { context, page, log, requests, bootMs: Date.now() - t0 };
}

/** Non-background pixels of a PNG data URL (or bytes), decoded in the page. */
function litPixels(page, data) {
  return page.evaluate(async (d) => {
    const src = typeof d === "string" ? d : URL.createObjectURL(new Blob([new Uint8Array(Object.values(d))], { type: "image/png" }));
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = src;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const px = x.getImageData(0, 0, c.width, c.height).data;
    const bg = [px[0], px[1], px[2]];
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 40) n++;
    return { lit: n, w: c.width, h: c.height };
  }, data);
}

// 20 fixed Inspect clicks across the double arch (fractions of #render-root).
const CLICKS = Array.from({ length: 20 }, (_, i) => [0.3 + 0.4 * ((i * 7) % 20) / 19, 0.35 + 0.35 * ((i * 11) % 20) / 19]);

async function inspectAll(page) {
  await page.evaluate(() => window.postMessage({ type: "uiAction", action: "inspect" }, "*"));
  await page.waitForTimeout(500);
  const root = await page.locator("#render-root").boundingBox();
  const out = [];
  for (const [fx, fy] of CLICKS) {
    await page.mouse.click(root.x + root.width * fx, root.y + root.height * fy);
    await page.waitForTimeout(250);
    out.push(
      await page.evaluate(() => {
        const t = document.querySelector("#inspect-panel")?.innerText ?? "";
        const ent = t.match(/(ELEMENT|CONDITION|NODE)\s+(\d+)/)?.[0] ?? "none";
        const near = t.match(/NEAREST NODE\s+(\d+)/)?.[1] ?? "-";
        return `${ent} / ${near}`;
      })
    );
  }
  return out;
}

async function main() {
  buildHarness(WASM_DIR, { HARNESS_RENDERER: "vtkwasm", HARNESS_CSP: "1" });
  buildHarness(JS_DIR, {});
  const server = await startServer(0);
  const wasmUrl = `${server.origin}/out/vtk-wasm-eval/g4-harness-wasm/index.html`;
  const { chromium } = playwright();
  const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const results = {};
  const fail = [];
  const check = (name, ok, detail) => {
    results[name] = { ok, ...detail };
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail).slice(0, 240)}`);
    if (!ok) fail.push(name);
  };

  // 1-3 and 4 (wasm half) on one page.
  {
    const s = await openPage(browser, wasmUrl);
    const st = await s.page.evaluate(() => ({
      canvas: document.querySelector("#render-root canvas")?.id ?? null,
      csp: window.CSP_VIOLATIONS,
      message: document.getElementById("message")?.textContent ?? "",
    }));
    const foreign = s.requests.filter((u) => !u.startsWith(server.origin) && !u.startsWith("data:") && !u.startsWith("blob:"));
    check("boot", st.canvas === "vtk-wasm-canvas" && st.csp.length === 0 && s.log.errors.length === 0 && s.log.warnings.length === 0 && foreign.length === 0, {
      bootMs: s.bootMs,
      canvas: st.canvas,
      csp: st.csp,
      errors: s.log.errors,
      warnings: s.log.warnings,
      foreignRequests: foreign,
      message: st.message,
    });

    await s.page.evaluate(() => {
      window.SENT_MESSAGES = [];
      window.postMessage({ type: "takeScreenshot" }, "*");
    });
    await s.page.waitForFunction(() => (window.SENT_MESSAGES ?? []).some((m) => m.type === "screenshot"), null, { timeout: 30_000 }).catch(() => {});
    const shot = await s.page.evaluate(() => (window.SENT_MESSAGES ?? []).find((m) => m.type === "screenshot")?.data);
    const shotPx = shot ? await litPixels(s.page, shot) : { lit: 0 };
    check("screenshot", shotPx.lit > 5000, shotPx);

    await s.page.evaluate(() => {
      window.SENT_MESSAGES = [];
      window.postMessage({ type: "uiAction", action: "record" }, "*");
    });
    await s.page.waitForTimeout(500);
    const clickBtn = (label) =>
      s.page.$eval(
        "#record-panel",
        (panel, l) => {
          const b = [...panel.querySelectorAll("button")].find((x) => x.textContent.includes(l));
          if (!b || b.disabled) return false;
          b.click();
          return true;
        },
        label
      );
    const setup = (await clickBtn("Turntable")) && (await clickBtn("PNG frames"));
    await s.page.$eval("#record-panel", (panel) => {
      const row = [...panel.querySelectorAll(".field-row")].find((r) => r.textContent.includes("Frames"));
      const input = row?.querySelector("input");
      if (input) {
        input.value = "5";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await s.page.waitForTimeout(300);
    const started = setup && (await clickBtn("Record"));
    await s.page.waitForFunction(() => (window.SENT_MESSAGES ?? []).some((m) => m.type === "recordFramesDone"), null, { timeout: 120_000 }).catch(() => {});
    const frames = await s.page.evaluate(() => (window.SENT_MESSAGES ?? []).filter((m) => m.type === "recordFrame").map((m) => ({ index: m.index, data: m.data })));
    const lit = [];
    for (const f of frames) lit.push((await litPixels(s.page, f.data)).lit);
    const ordered = frames.every((f, i) => f.index === i);
    check("recording", started && frames.length === 5 && ordered && lit.every((n) => n > 5000), { frames: frames.length, ordered, lit });

    const wasmPicks = await inspectAll(s.page);
    await s.context.close();

    const j = await openPage(browser, pathToFileURL(join(JS_DIR, "index.html")).href);
    const jsPicks = await inspectAll(j.page);
    await j.context.close();
    const same = wasmPicks.filter((p, i) => p === jsPicks[i]).length;
    const hits = jsPicks.filter((p) => !p.startsWith("none")).length;
    const hitPattern = wasmPicks.every((p, i) => p.startsWith("none") === jsPicks[i].startsWith("none"));
    check("inspect", hitPattern && hits >= 10, {
      hitPattern,
      agree: `${same}/${CLICKS.length}`,
      hitsOnVtkJs: hits,
      differences: wasmPicks.map((p, i) => (p === jsPicks[i] ? null : { click: CLICKS[i], wasm: p, vtkjs: jsPicks[i] })).filter(Boolean),
    });
  }

  // 5. Webview-side fallbacks: still renders (on vtk.js) and says why.
  const fallback = async (name, opts, expect) => {
    const s = await openPage(browser, wasmUrl, opts);
    const st = await s.page.evaluate(() => ({
      canvas: document.querySelector("#render-root canvas")?.id ?? null,
      canvases: document.querySelectorAll("#render-root canvas").length,
      message: document.getElementById("message")?.textContent ?? "",
    }));
    // A page screenshot, not View > Screenshot: the fallback is vtk.js, whose
    // captureNextImage() never resolves under a software rasterizer.
    const png = await s.page.locator("#render-root").screenshot();
    const px = await litPixels(s.page, `data:image/png;base64,${png.toString("base64")}`);
    check(name, st.canvas !== "vtk-wasm-canvas" && st.canvases === 1 && expect.test(st.message) && px.lit > 5000, { ...st, lit: px.lit, bootMs: s.bootMs, errors: s.log.errors });
    await s.context.close();
  };
  await fallback("fallback-no-jspi", { init: () => delete WebAssembly.Suspending }, /JSPI/);
  await fallback(
    "fallback-corrupt-wasm",
    { route: { pattern: "**/vtkWebAssembly.wasm", handler: (r) => r.fulfill({ status: 200, contentType: "application/wasm", body: Buffer.from("not a wasm module") }) } },
    /failed to start/
  );

  await browser.close();
  await server.close();
  const outDir = join(ROOT, "out", "vtk-wasm-eval", "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "g4-smoke.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join(", ")}` : "\nall G4 smoke checks passed");
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
