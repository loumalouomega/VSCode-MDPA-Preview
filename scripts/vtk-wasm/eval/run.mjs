#!/usr/bin/env node
// Playwright driver for the VTK-wasm evaluation gates (roadmap item 18,
// Phase 0/1). One subcommand per gate; each writes
// out/vtk-wasm-eval/results/<gate>-<candidate>[-<variant>].json.
//
//   NODE_PATH=<dir with playwright-core> node scripts/vtk-wasm/eval/run.mjs <gate> \
//     [--candidate rel-9.7.0|latest-9.7.20260920] [--build vtkWebAssembly] \
//     [--glue orig|patched] [--csp none|<name>] [--dpr 1|2] [--headed]
//
// The page is generated per run into out/vtk-wasm-eval/pages/ and imports
// /eval/evalLib.mjs, which holds the gate implementations. Chromium runs with
// SwiftShader (as every other harness script in this repo), so frame times
// are CPU-rasterizer numbers — API/call overhead is meaningful, FPS is not.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const PAGES = join(ROOT, "out", "vtk-wasm-eval", "pages");
const RESULTS = join(ROOT, "out", "vtk-wasm-eval", "results");
const require = createRequire(import.meta.url);

export function resolvePlaywright() {
  for (const c of ["playwright-core", join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright-core not found — npm-install it somewhere and pass NODE_PATH");
}

/** Named CSP variants for the http evaluation pages. `none` = no meta tag. */
export const CSPS = {
  none: null,
  // Phase 0 measures API behaviour independently of the glue rewrite.
  permissive: "default-src 'none'; script-src 'self' 'nonce-EVAL' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; worker-src blob:",
  // What the shipped webview has plus the expected minimal delta, minus 'unsafe-eval'.
  strict: "default-src 'none'; script-src 'nonce-EVAL' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; worker-src blob:",
};

function arg(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

export async function runGate({ gate, candidate, build, glue, csp, dpr = 1, headed = false, extra = {} }) {
  const { chromium } = resolvePlaywright();
  const srv = await startServer(0);
  const config = {
    gate,
    candidate,
    build,
    glue,
    base: `${srv.origin}/out/vtk-wasm/${glue === "patched" ? `prepared-eval/${candidate}` : candidate}`,
    // The spike's condition: the same binary served from a directory with no vtk-methods.json.
    baseNoTable: `${srv.origin}/out/vtk-wasm/notable/${candidate}`,
    tarball: `${srv.origin}/out/vtk-wasm/cache/${candidate}.tar.gz`,
    ...extra,
  };
  const cspValue = CSPS[csp];
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
${cspValue ? `<meta http-equiv="Content-Security-Policy" content="${cspValue}">` : ""}
<title>vtk-wasm eval ${gate}</title>
<style>body{margin:0;background:#111;color:#ccc;font:12px monospace}canvas{display:block}</style></head>
<body><div id="log"></div>
<script nonce="EVAL" type="module">
  window.__VIOLATIONS__ = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__VIOLATIONS__.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample }));
  import("/eval/evalLib.mjs").then((lib) => lib.run(${JSON.stringify(config)}))
    .then((r) => { window.__RESULT__ = { ok: true, ...r }; })
    .catch((e) => { window.__RESULT__ = { ok: false, error: String(e && e.stack || e) }; });
</script></body></html>`;
  mkdirSync(PAGES, { recursive: true });
  const pageName = `${gate}-${candidate}-${glue}-${csp}.html`;
  writeFileSync(join(PAGES, pageName), html);

  const browser = await chromium.launch({
    headless: !headed,
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: dpr });
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 400)));
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`.slice(0, 400)));
  const t0 = Date.now();
  await page.goto(`${srv.origin}/out/vtk-wasm-eval/pages/${pageName}`);
  await page.waitForFunction(() => window.__RESULT__ !== undefined, null, { timeout: extra.timeoutMs ?? 600_000 });
  const result = await page.evaluate(() => window.__RESULT__);
  const violations = await page.evaluate(() => window.__VIOLATIONS__);
  const ua = await page.evaluate(() => navigator.userAgent);
  await browser.close();
  await srv.close();
  const out = {
    gate, candidate, build, glue, csp, dpr, userAgent: ua, wallMs: Date.now() - t0,
    violations, consoleErrors: consoleLines.filter((l) => /^(error|pageerror)/.test(l)).slice(0, 50),
    consoleCount: consoleLines.length, requests: srv.requests.filter((u) => !u.startsWith("/out/vtk-wasm-eval/pages/")),
    result,
  };
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `${gate}-${candidate}${glue === "patched" ? "-patched" : ""}${csp !== "none" ? `-${csp}` : ""}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  return { file, out };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const gate = argv[0];
  if (!gate) {
    console.error("usage: run.mjs <gate> [--candidate c] [--build b] [--glue orig|patched] [--csp none|permissive|strict] [--dpr n]");
    process.exit(2);
  }
  const { file, out } = await runGate({
    gate,
    candidate: arg(argv, "candidate", "rel-9.7.0"),
    build: arg(argv, "build", "vtkWebAssembly"),
    glue: arg(argv, "glue", "orig"),
    csp: arg(argv, "csp", "none"),
    dpr: Number(arg(argv, "dpr", "1")),
    headed: argv.includes("--headed"),
  });
  console.log(JSON.stringify({ ok: out.result.ok, violations: out.violations.length, consoleErrors: out.consoleErrors.length }, null, 0));
  if (!out.result.ok) console.log(out.result.error);
  console.log(`-> ${file}`);
}
