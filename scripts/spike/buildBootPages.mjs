#!/usr/bin/env node
// Kill-switch G1 (see /home/vicente/.claude/plans/tackle-tier-0-of-lively-puddle.md):
// does @kitware/vtk-wasm boot under the SHIPPED CSP, and if not, exactly what
// minimal delta does it need? Writes two static pages differing ONLY in
// their <meta http-equiv="Content-Security-Policy"> content:
//
//   out/spike/boot-shipped.html    <- the real, unmodified CSP (expect failure)
//   out/spike/boot-augmented.html  <- + CSP_ADDITIONS from cspDelta.mjs
//
// A meta CSP tag only takes effect for resources requested AFTER it is
// parsed, so this generates two separate documents rather than one page
// toggling a header at runtime — the CSP must be baked in before the first
// script tag runs, exactly as buildPreviewHtml does it for the real preview.
//
// Usage: node scripts/spike/buildBootPages.mjs [--port 7317]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shippedCsp } from "./realCsp.mjs";
import { applyCspDelta, CSP_ADDITIONS } from "./cspDelta.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "..", "out", "spike");

function parsePort(argv) {
  const i = argv.indexOf("--port");
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : Number(process.env.SPIKE_PORT) || 7317;
}

function bootHtml({ csp, nonce, label, origin }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>vtk-wasm boot — ${label}</title>
<style nonce="${nonce}">
  body { font: 13px monospace; background: #1e1e1e; color: #ddd; padding: 16px; white-space: pre-wrap; }
  #log { border-top: 1px solid #444; margin-top: 12px; padding-top: 12px; }
</style>
</head>
<body>
<h3>vtk-wasm boot test — ${label}</h3>
<div>CSP: <code>${csp}</code></div>
<div id="log">booting…</div>
<script nonce="${nonce}" type="module">
  const log = document.getElementById("log");
  const lines = [];
  function report(line) {
    lines.push(line);
    log.textContent = lines.join("\\n");
    console.log("[boot]", line);
  }
  // Surface CSP violations explicitly — Chromium fires this event rather
  // than throwing a catchable JS error for a blocked network/module request.
  document.addEventListener("securitypolicyviolation", (e) => {
    report(\`CSP VIOLATION: directive="\${e.violatedDirective}" blocked="\${e.blockedURI}"\`);
    window.__SPIKE_RESULT__ = { ok: false, reason: "csp-violation", directive: e.violatedDirective, blockedURI: e.blockedURI };
  });
  report("importing @kitware/vtk-wasm loader…");
  try {
    const { loadAsync } = await import("/vtk-wasm/loader/package/dist/esm/index.mjs");
    report("loader module imported OK; calling loadAsync()…");
    const t0 = performance.now();
    // wasmBaseName defaults to "vtk", and the loader itself appends
    // "WebAssembly" to build the candidate filename (ae() in the runtime:
    // \`\${wasmBaseName}WebAssembly\` -> "vtkWebAssembly"), which is exactly
    // the name the fetched bundle ships (vtkWebAssembly.mjs/.wasm) — so the
    // default must be left alone, not overridden to "vtkWebAssembly" (which
    // would look for "vtkWebAssemblyWebAssembly.mjs" and 404/CSP-block).
    const runtime = await loadAsync({
      url: "${origin}/vtk-wasm/wasm32",
      urlIsGzip: false,
    });
    const t1 = performance.now();
    report(\`runtime loaded in \${(t1 - t0).toFixed(0)} ms\`);
    const session = runtime.createStandaloneSession();
    report("StandaloneSession created OK. session.vtk namespace: " + typeof session.vtk);
    const actor = session.vtk.vtkActor.newInstance ? session.vtk.vtkActor.newInstance() : session.vtk.vtkActor();
    report("vtkActor instance created: " + typeof actor);
    session.dispose();
    report("SUCCESS — booted, created an object, disposed cleanly.");
    window.__SPIKE_RESULT__ = { ok: true, loadMs: t1 - t0 };
  } catch (err) {
    report("FAILED: " + (err && err.message ? err.message : String(err)));
    if (err && err.cause) report("  cause: " + (err.cause.message || err.cause));
    window.__SPIKE_RESULT__ = { ok: false, reason: "exception", message: String(err && err.message || err) };
  }
</script>
</body>
</html>`;
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  const origin = `http://127.0.0.1:${port}`;
  mkdirSync(OUT_DIR, { recursive: true });

  const shipped = await shippedCsp(origin, "SPIKEBOOTNONCE");
  const augmented = applyCspDelta(shipped, origin);

  writeFileSync(join(OUT_DIR, "boot-shipped.html"), bootHtml({ csp: shipped, nonce: "SPIKEBOOTNONCE", label: "shipped CSP (expect failure)", origin }));
  writeFileSync(join(OUT_DIR, "boot-augmented.html"), bootHtml({ csp: augmented, nonce: "SPIKEBOOTNONCE", label: "augmented CSP", origin }));

  console.log("shipped CSP:  ", shipped);
  console.log("augmented CSP:", augmented);
  console.log("delta added:  ", CSP_ADDITIONS.map((a) => `${a.directive} ${a.value.replace("${cspSource}", origin)}`).join(" | "));
  console.log(`\nwrote ${join(OUT_DIR, "boot-shipped.html")}`);
  console.log(`wrote ${join(OUT_DIR, "boot-augmented.html")}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
