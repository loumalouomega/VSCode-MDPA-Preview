#!/usr/bin/env node
// Kill-switch G3 (minimal): can one actor reach an actual canvas, and — the
// single highest-value remaining question after G2's async finding — is
// Render() itself async too? webview/main.ts calls renderWindow.render()
// synchronously at 45 sites, many in tight interactive loops (camera drag,
// timeline scrub). If Render() is also Promise-returning, every one of those
// call sites needs restructuring, not just a swap.
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
  const nonce = "SPIKERENDERNONCE";
  const csp = applyCspDelta(await shippedCsp(origin, nonce), origin);

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>vtk-wasm render test</title>
<style nonce="${nonce}">body{font:13px monospace;background:#1e1e1e;color:#ddd;padding:16px;white-space:pre-wrap}canvas{border:1px solid #555;background:#000}</style>
</head><body>
<canvas id="spike-canvas" width="400" height="300"></canvas>
<div id="log">running…</div>
<script nonce="${nonce}" type="module">
  const log = document.getElementById("log");
  const lines = [];
  function report(l) { lines.push(l); log.textContent = lines.join("\\n"); console.log("[render]", l); }
  async function unwrap(v) { return v instanceof Promise ? await v : v; }

  try {
    const { loadAsync } = await import("/vtk-wasm/loader/package/dist/esm/index.mjs");
    // exec:"sync" was tested explicitly and made NO difference (render() is
    // still a Promise either way) — the docs say as much for single-binary
    // bundles ("the proxy feature-detects invokeAsync at runtime"), and this
    // confirms it empirically for the pinned v3.0.5 wasm32 artifact: there
    // is no public option to opt out of async mode when invokeAsync exists.
    const runtime = await loadAsync({ url: "${origin}/vtk-wasm/wasm32", urlIsGzip: false });
    const session = runtime.createStandaloneSession();
    const vtk = session.vtk;
    report("session ready");

    const canvas = document.getElementById("spike-canvas");
    const key = session.registerCanvas("!spike-canvas", canvas);
    report("canvas registered as " + key);

    // A single triangle, matching the shape buildPolyData emits (points +
    // legacy n,i0,i1,... polys), to prove real geometry reaches the screen.
    const points = new Float32Array([0, 0, 0,  1, 0, 0,  0.5, 1, 0]);
    const polysLegacy = new Int32Array([3, 0, 1, 2]); // n,i0,i1,i2

    const pointsArr = session.typedArrayInterface.toVTKAoSArray(points, 3, "points");
    report("typed arrays uploaded (constructors are sync — confirmed in G2)");

    // setData takes exactly ONE argument (vtkDataArray) — the component
    // count is already baked into pointsArr via toVTKAoSArray's own
    // numberOfComponents param. A stray second argument here silently left
    // vtkPoints with 0 points (measured: getNumberOfPoints() === 0, bounds
    // === the VTK uninitialized-bounds sentinel [1,-1,1,-1,1,-1]) rather
    // than throwing — a real footgun for a port of code that isn't
    // scrupulously up to date with the exact current signature.
    const vtkPoints = await unwrap(vtk.vtkPoints());
    await unwrap(vtkPoints.setData(pointsArr));

    // MEASURED (per the plan's named risk): VTK 9.x's vtkCellArray stores
    // (offsets, connectivity), NOT the legacy n,i0,i1,... layout
    // webview/meshBuilder.ts emits. cellArray.setData(polysArr) with a
    // single legacy-shaped array is silently ACCEPTED (no error) but wrong —
    // it produced a black canvas with zero visible geometry. The correct
    // route is vtkCellArray::ImportLegacyFormat(vtkIdTypeArray), which
    // exists exactly as documented. vtkIdTypeArray is NOT one of
    // toVTKAoSArray's fixed-width target classes (that lookup only builds
    // vtkTypeXxxArray), so it must be built manually via the session's
    // lower-level HeapInterface primitives (copyToHeap/toSizeType), the same
    // primitives toVTKAoSArray uses internally. vtkIdType is 32-bit on this
    // wasm32 build (confirmed via SetArray's Int32 pointer type in
    // vtkIdTypeArray.json) — wasm64 must be re-checked independently.
    const idArray = await unwrap(vtk.vtkIdTypeArray());
    const heapPtr = session.typedArrayInterface.copyToHeap(polysLegacy);
    await unwrap(idArray.setArray(heapPtr, session.typedArrayInterface.toSizeType(polysLegacy.length), 0));
    const cellArray = await unwrap(vtk.vtkCellArray());
    const imported = await unwrap(cellArray.importLegacyFormat(idArray));
    report("cellArray.importLegacyFormat() -> " + imported);

    const polyData = await unwrap(vtk.vtkPolyData());
    await unwrap(polyData.setPoints(vtkPoints));
    await unwrap(polyData.setPolys(cellArray));
    report("vtkPolyData assembled");

    const mapper = await unwrap(vtk.vtkPolyDataMapper());
    await unwrap(mapper.setInputData(polyData));

    const actor = await unwrap(vtk.vtkActor());
    await unwrap(actor.setMapper(mapper));
    const prop = await unwrap(actor.getProperty());
    await unwrap(prop.setColor(1, 0, 0));
    report("actor + mapper wired");

    const nPts = await unwrap(polyData.getNumberOfPoints());
    const nCells = await unwrap(polyData.getNumberOfCells());
    report(\`polyData: \${nPts} points, \${nCells} cells\`);
    const bounds = await unwrap(mapper.getBounds());
    report("mapper bounds: " + JSON.stringify(bounds));

    const renderer = await unwrap(vtk.vtkRenderer());
    await unwrap(renderer.addActor(actor));
    await unwrap(renderer.setBackground(0.1, 0.1, 0.15));
    await unwrap(renderer.resetCamera());
    const cam = await unwrap(renderer.getActiveCamera());
    const pos = await unwrap(cam.getPosition());
    const fp = await unwrap(cam.getFocalPoint());
    report(\`camera after resetCamera: pos=\${JSON.stringify(pos)} focalPoint=\${JSON.stringify(fp)}\`);

    const renderWindow = await unwrap(vtk.vtkWebAssemblyOpenGLRenderWindow());
    await unwrap(renderWindow.setCanvasSelector(key));
    await unwrap(renderWindow.addRenderer(renderer));
    await unwrap(renderWindow.setSize(400, 300));
    report("render window assembled, calling Render()...");

    const renderCall = renderWindow.render();
    const renderIsAsync = renderCall instanceof Promise;
    report("renderWindow.render() -> instanceof Promise: " + renderIsAsync);
    await unwrap(renderCall);

    // Time a representative run of repeated Render() calls, the way an
    // interactive camera drag or timeline scrub calls it many times/second.
    const N_RENDERS = 60;
    const t0 = performance.now();
    for (let i = 0; i < N_RENDERS; i++) await unwrap(renderWindow.render());
    const t1 = performance.now();
    const msPerRender = (t1 - t0) / N_RENDERS;
    report(\`\${N_RENDERS} sequential awaited Render() calls: \${(t1-t0).toFixed(1)}ms total, \${msPerRender.toFixed(2)}ms/render (\${(1000/msPerRender).toFixed(0)} fps ceiling from call overhead alone, one triangle)\`);

    // Read back actual pixels to confirm this is not a black/empty canvas.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // vtkWebAssemblyOpenGLRenderWindow draws into the SAME canvas element via
    // its own WebGL context, not the 2D context above — read back via
    // toDataURL/getImageData against the canvas element itself instead.
    let nonBackgroundPixels = 0;
    try {
      const bmp = await createImageBitmap(canvas);
      const off = new OffscreenCanvas(bmp.width, bmp.height);
      const octx = off.getContext("2d");
      octx.drawImage(bmp, 0, 0);
      const data = octx.getImageData(0, 0, bmp.width, bmp.height).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 40 || data[i+1] > 40 || data[i+2] > 60) nonBackgroundPixels++;
      }
    } catch (e) { report("pixel readback failed: " + e.message); }
    report(\`non-background pixels detected: \${nonBackgroundPixels} (0 would mean a black/empty canvas)\`);

    session.dispose();
    window.__SPIKE_RESULT__ = { ok: true, renderIsAsync, msPerRender, nonBackgroundPixels };
  } catch (err) {
    report("FAILED: " + (err && err.message || err));
    window.__SPIKE_RESULT__ = { ok: false, reason: String(err && err.message || err) };
  }
</script>
</body></html>`;

  writeFileSync(join(OUT_DIR, "render.html"), html);
  console.log(`wrote ${join(OUT_DIR, "render.html")}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
