#!/usr/bin/env node
// Phase 5 performance and disposal measurements for the renderer migration
// (roadmap item 18): the SAME operations timed on the vtk.js and VTK-wasm
// backends, over the screenshot harness, in Chromium with SwiftShader. A
// software rasterizer bounds GPU-side costs from above and is no substitute
// for the real-GPU checklist; what it does measure fairly is everything the
// two backends do on the CPU — scene construction, uploads, per-call
// overhead, picking — and memory.
//
//   npm run compile && npm run build:tests
//   NODE_PATH=<dir with playwright-core> node scripts/render-parity/perf.mjs [--runs 3]
//
// Fixtures: the double arch (63k tetrahedra) and two synthetic hexahedral
// grids (100k and 500k cells) written to out/render-parity/fixtures/.
// Results: out/vtk-wasm-eval/results/perf.json.
//
// What each number is:
// - startMs: page load until the scene is drawn (#app shown, first model built).
// - replaceMs: re-posting the whole model (what a timeline step or an edit
//   does): message dispatch until the handler has rebuilt and rendered.
// - renderStepMs: one camera change + synchronous render, via the `1`/`2`
//   standard-view shortcuts, whose handler renders before returning.
// - toggleMs: hiding and showing the main layer through its outline checkbox.
// - pickMs: an Inspect click resolved end to end.
// - rssMB / rssAfterSwapsMB: the renderer processes' resident memory after
//   load and after 30 more model replacements (the disposal check).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer } from "../vtk-wasm/serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const RUNS = Number(argv.includes("--runs") ? argv[argv.indexOf("--runs") + 1] : 3);

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

const FIX = join(ROOT, "out", "render-parity", "fixtures");
async function fixtures() {
  mkdirSync(FIX, { recursive: true });
  const { hexGrid } = await import("../screenshots/opFixtures.mjs");
  const { writeMdpa } = require(join(ROOT, "out", "parser", "writers", "mdpaWriter"));
  const out = { arch: join(ROOT, "example", "MDPA", "double_arch.mdpa") };
  for (const [name, dims] of [
    ["hex100k", [50, 50, 40]],
    ["hex500k", [100, 100, 50]],
  ]) {
    const f = join(FIX, `${name}.mdpa`);
    if (!existsSync(f)) writeFileSync(f, writeMdpa(hexGrid(...dims, 0.01)));
    out[name] = f;
  }
  return out;
}

function buildHarness(dir, mesh, renderer) {
  const env = { ...process.env, HARNESS_OUT: dir, HARNESS_MESH: mesh };
  if (renderer === "vtkwasm") Object.assign(env, { HARNESS_RENDERER: "vtkwasm", HARNESS_CSP: "1" });
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "screenshots", "build-harness.mjs")], { cwd: ROOT, env, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`build-harness failed:\n${r.stderr || r.stdout}`);
}

function psRows() {
  const out = execFileSync("ps", ["-e", "-o", "pid=,ppid=,rss=,args="], { encoding: "utf8" });
  return out.trim().split("\n").map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] } : undefined;
  }).filter(Boolean);
}

/** The browser this script launched: a child of this Node process. */
function browserPids() {
  return new Set(psRows().filter((r) => r.ppid === process.pid && /chrom/.test(r.args)).map((r) => r.pid));
}

/**
 * Resident memory (MB, Linux) of the launched browser's renderer and GPU
 * processes — the renderer holds the JS and wasm heaps, the GPU process
 * SwiftShader's buffers.
 */
function processRssMB(roots) {
  const rows = psRows();
  const kids = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (kids.has(r.ppid) && !kids.has(r.pid)) (kids.add(r.pid), (grew = true));
  }
  const sum = (type) => Math.round(rows.filter((r) => kids.has(r.pid) && r.args.includes(`--type=${type}`)).reduce((s, r) => s + r.rss, 0) / 1024);
  return { renderer: sum("renderer"), gpu: sum("gpu-process") };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];

async function measure(browser, browserPid, url) {
  if (!browserPid.size) throw new Error("could not find the launched browser process");
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById("app")?.style.display !== "none" && document.getElementById("stats")?.innerText, null, { timeout: 180_000 });
  const startMs = Date.now() - t0;
  await page.waitForTimeout(1000);
  const rssMB = processRssMB(browserPid);

  const r = await page.evaluate(async () => {
    const revive = (v) => {
      if (v && typeof v === "object") {
        if (v.__ta) return new self[v.__ta](v.data);
        if (Array.isArray(v)) return v.map(revive);
        const o = {};
        for (const k of Object.keys(v)) o[k] = revive(v[k]);
        return o;
      }
      return v;
    };
    const msg = revive(window.HARNESS_MESSAGES.find((m) => m.type === "model"));
    const renderer = document.body.dataset.renderer ?? "vtkjs";
    const onceHandled = () =>
      new Promise((res) => {
        const t = performance.now();
        const done = () => {
          window.removeEventListener("message", done);
          res(performance.now() - t);
        };
        // Registered after main.ts's listener, so it runs when the rebuild is done.
        window.addEventListener("message", done);
        window.postMessage({ ...msg, keepCamera: true }, "*");
      });
    const replace = [];
    for (let i = 0; i < 5; i++) replace.push(await onceHandled());

    const key = (k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    const steps = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      key(i % 2 ? "1" : "2");
      steps.push(performance.now() - t);
    }
    key("1");

    // Frame time: one camera change + render per animation frame, timed
    // frame to frame, so the rasterizer's work is in the number.
    const frames = await new Promise((res) => {
      const ts = [];
      let n = 0;
      const tick = (t) => {
        ts.push(t);
        if (n++ >= 61) return res(ts.slice(1).map((x, i) => x - ts[i]));
        key(n % 2 ? "1" : "2");
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    key("1");

    const box = document.querySelector("#outline input[type=checkbox]");
    const toggles = [];
    for (let i = 0; i < 20 && box; i++) {
      const t = performance.now();
      box.click();
      toggles.push(performance.now() - t);
    }

    window.postMessage({ type: "uiAction", action: "inspect" }, "*");
    await new Promise((r2) => setTimeout(r2, 300));
    const root = document.getElementById("render-root");
    const rect = root.getBoundingClientRect();
    const picks = [];
    for (let i = 0; i < 20; i++) {
      const x = rect.left + rect.width * (0.35 + 0.3 * ((i * 7) % 20) / 19);
      const y = rect.top + rect.height * (0.4 + 0.25 * ((i * 11) % 20) / 19);
      const target = document.elementFromPoint(x, y) ?? root;
      const ev = (type) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === "pointerdown" ? 1 : 0, bubbles: true, pointerId: 1, isPrimary: true, pointerType: "mouse" });
      const t = performance.now();
      target.dispatchEvent(ev("pointerdown"));
      target.dispatchEvent(ev("pointerup"));
      picks.push(performance.now() - t);
    }
    return { renderer, replace, steps, frames, toggles, picks, inspect: (document.querySelector("#inspect-panel")?.innerText ?? "").slice(0, 40) };
  });

  // Disposal: 30 more whole-model replacements, then memory again.
  await page.evaluate(async () => {
    const msg = window.HARNESS_MESSAGES.find((m) => m.type === "model");
    const revive = (v) => (v && typeof v === "object" ? (v.__ta ? new self[v.__ta](v.data) : Array.isArray(v) ? v.map(revive) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]))) : v);
    const m = revive(msg);
    for (let i = 0; i < 30; i++) {
      window.postMessage({ ...m, keepCamera: true }, "*");
      await new Promise((r2) => setTimeout(r2, 0));
    }
    await new Promise((r2) => setTimeout(r2, 500));
  });
  await page.waitForTimeout(1500);
  const rssAfterSwapsMB = processRssMB(browserPid);
  await context.close();
  return {
    renderer: r.renderer,
    startMs,
    replaceMs: +median(r.replace).toFixed(1),
    renderStepMs: { median: +median(r.steps).toFixed(2), p95: +p95(r.steps).toFixed(2) },
    frameMs: { median: +median(r.frames).toFixed(1), p95: +p95(r.frames).toFixed(1) },
    toggleMs: +median(r.toggles).toFixed(2),
    pickMs: +median(r.picks).toFixed(2),
    rssMB,
    rssAfterSwapsMB,
    errors,
  };
}

async function main() {
  const fx = await fixtures();
  const server = await startServer(0);
  const { chromium } = playwright();
  const results = {};
  for (const [name, mesh] of Object.entries(fx)) {
    for (const renderer of ["vtkjs", "vtkwasm"]) {
      const dir = join(ROOT, "out", "render-parity", "perf-harness", `${name}-${renderer}`);
      buildHarness(dir, mesh, renderer);
      const url = renderer === "vtkwasm" ? `${server.origin}/out/render-parity/perf-harness/${name}-${renderer}/index.html` : pathToFileURL(join(dir, "index.html")).href;
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        // A fresh browser per run: nothing (compiled wasm, shader caches) carries over.
        const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
        runs.push(await measure(browser, browserPids(), url));
        await browser.close();
      }
      const pick = (f) => median(runs.map(f));
      results[`${name}/${renderer}`] = {
        runs: runs.length,
        startMs: pick((r) => r.startMs),
        replaceMs: pick((r) => r.replaceMs),
        renderStepMedianMs: pick((r) => r.renderStepMs.median),
        renderStepP95Ms: pick((r) => r.renderStepMs.p95),
        frameMedianMs: pick((r) => r.frameMs.median),
        frameP95Ms: pick((r) => r.frameMs.p95),
        toggleMs: pick((r) => r.toggleMs),
        pickMs: pick((r) => r.pickMs),
        rendererMB: pick((r) => r.rssMB.renderer),
        gpuMB: pick((r) => r.rssMB.gpu),
        rendererAfterSwapsMB: pick((r) => r.rssAfterSwapsMB.renderer),
        gpuAfterSwapsMB: pick((r) => r.rssAfterSwapsMB.gpu),
        errors: runs.flatMap((r) => r.errors).slice(0, 5),
      };
      console.log(`${`${name}/${renderer}`.padEnd(18)} ${JSON.stringify(results[`${name}/${renderer}`])}`);
    }
  }
  await server.close();
  const outDir = join(ROOT, "out", "vtk-wasm-eval", "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "perf.json"), JSON.stringify({ date: new Date().toISOString(), rasterizer: "SwiftShader", results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
