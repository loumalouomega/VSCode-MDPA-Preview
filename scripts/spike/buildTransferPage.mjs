#!/usr/bin/env node
// Kill-switch G2: does bulk typed-array transfer via toVTKAoSArray() work at
// scale, and does the documented ownership/view-invalidation contract
// actually hold? (types/base.d.ts: "the heap allocation is handed to VTK,
// which frees it along with the array — the caller has nothing to release";
// toJSTypedArray()'s view "aliases the wasm heap and is invalidated whenever
// the heap grows or the array reallocates".)
//
// Generates out/spike/transfer.html, driven by runTransferTest.mjs.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shippedCsp } from "./realCsp.mjs";
import { applyCspDelta } from "./cspDelta.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "..", "out", "spike");

function parsePort(argv) {
  const i = argv.indexOf("--port");
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : Number(process.env.SPIKE_PORT) || 7317;
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  const origin = `http://127.0.0.1:${port}`;
  mkdirSync(OUT_DIR, { recursive: true });
  const nonce = "SPIKETRANSFERNONCE";
  const csp = applyCspDelta(await shippedCsp(origin, nonce), origin);

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>vtk-wasm transfer test</title>
<style nonce="${nonce}">body{font:13px monospace;background:#1e1e1e;color:#ddd;padding:16px;white-space:pre-wrap}</style>
</head><body>
<div id="log">running…</div>
<script nonce="${nonce}" type="module">
  const log = document.getElementById("log");
  const lines = [];
  function report(l) { lines.push(l); log.textContent = lines.join("\\n"); console.log("[transfer]", l); }

  function mkFloat32(n) {
    // n points, 3 components (xyz), matching meshBuilder.ts's
    // Float32Array.from(localPoints) points layout.
    const a = new Float32Array(n * 3);
    for (let i = 0; i < a.length; i++) a[i] = Math.sin(i) * 100;
    return a;
  }

  const results = [];
  try {
    const { loadAsync } = await import("/vtk-wasm/loader/package/dist/esm/index.mjs");
    const runtime = await loadAsync({ url: "${origin}/vtk-wasm/wasm32", urlIsGzip: false });
    const session = runtime.createStandaloneSession();
    report("session ready");

    // Precisely classify which operations are sync vs async in this bundle,
    // rather than inferring from one call. main.ts's entire scene-build path
    // assumes every vtk.js call is synchronous.
    {
      const ctorResult = session.vtk.vtkActor();
      report(\`constructor call session.vtk.vtkActor() -> instanceof Promise: \${ctorResult instanceof Promise}\`);
      const actor = ctorResult instanceof Promise ? await ctorResult : ctorResult;
      const getterResult = actor.getVisibility();
      report(\`getter call actor.getVisibility() -> instanceof Promise: \${getterResult instanceof Promise}\`);
      const setterResult = actor.setVisibility(true);
      report(\`setter call actor.setVisibility(true) -> instanceof Promise: \${setterResult instanceof Promise}\`);
      if (getterResult instanceof Promise) await getterResult;
      if (setterResult instanceof Promise) await setterResult;
    }

    // Per-call overhead microbenchmark: main.ts makes many small, individual
    // VTK method calls per scene build (setColor, setEdgeVisibility,
    // addClippingPlane, one actor+mapper per layer per pane, ...). If every
    // call is a Promise, this quantifies the real per-call tax.
    {
      const N_CALLS = 2000;
      const actor = await session.vtk.vtkActor();
      const t0 = performance.now();
      for (let i = 0; i < N_CALLS; i++) {
        await actor.setVisibility(i % 2 === 0);
      }
      const t1 = performance.now();
      const perCallUs = ((t1 - t0) / N_CALLS) * 1000;
      report(\`async call overhead: \${N_CALLS} sequential awaited setVisibility() calls took \${(t1-t0).toFixed(1)}ms total, \${perCallUs.toFixed(1)} \u00b5s/call\`);
      window.__ASYNC_CALL_US__ = perCallUs;
    }

    const SIZES = [1e4, 1e5, 1e6, 5e6, 1e7]; // point counts
    for (const n of SIZES) {
      const arr = mkFloat32(n);
      const bytesIn = arr.byteLength;
      const t0 = performance.now();
      const vtkArr = session.typedArrayInterface.toVTKAoSArray(arr, 3, "points");
      const t1 = performance.now();
      if (n === SIZES[0]) {
        const dt = await vtkArr.getDataType();
        report(\`diag: className=\${vtkArr.className} AWAITED getDataType()=\${dt} (a Promise means EVERY vtk method call is async in this bundle — invokeAsync is present)\`);
      }
      // Round-trip via toJSTypedArray: DOCUMENTED to be broken under this
      // bundle (see the diag above) — its own internal implementation calls
      // s.getDataType() synchronously and never awaits it, so under a build
      // where every instance method returns a Promise (this one), it always
      // computes Number(Promise) = NaN and throws. Caught here so the write-
      // side bandwidth numbers below are not lost to this separate defect.
      let roundTripOk = "toJSTypedArray broken under this bundle (see diag)";
      try {
        const view = await session.typedArrayInterface.toJSTypedArray(vtkArr);
        roundTripOk = view.length === arr.length && view[0] === arr[0] && view[arr.length - 1] === arr[arr.length - 1];
      } catch (e) { /* expected — recorded via the diag line above */ }
      const t2 = performance.now();
      const mbPerSec = (bytesIn / 1048576) / ((t1 - t0) / 1000);
      results.push({ n, bytesIn, transferMs: t1 - t0, readbackMs: t2 - t1, roundTripOk, mbPerSec });
      report(\`n=\${n.toExponential(0)}  bytesIn=\${(bytesIn/1048576).toFixed(1)}MB  transfer=\${(t1-t0).toFixed(1)}ms  (\${mbPerSec.toFixed(0)} MB/s)  roundTrip=\${roundTripOk}\`);
    }

    // View-invalidation test SKIPPED: it depends on toJSTypedArray(), which is
    // broken under this bundle (see above) — there is no working zero-copy
    // read-back path to test invalidation against in this artifact.
    report("--- view invalidation test: SKIPPED (toJSTypedArray is broken under this bundle) ---");

    session.dispose();
    window.__SPIKE_RESULT__ = { ok: true, sizes: results, invalidation: "skipped (toJSTypedArray broken under this bundle)", asyncCallOverheadUs: window.__ASYNC_CALL_US__ };
  } catch (err) {
    report("FAILED: " + (err && err.message || err));
    window.__SPIKE_RESULT__ = { ok: false, reason: String(err && err.message || err) };
  }
</script>
</body></html>`;

  writeFileSync(join(OUT_DIR, "transfer.html"), html);
  console.log(`wrote ${join(OUT_DIR, "transfer.html")}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
