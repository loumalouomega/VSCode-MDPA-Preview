# VTK-wasm rendering-runtime spike — findings

Evaluation of `doc/roadmap.md` Tier 0 (2026-09-18): can `@kitware/vtk-wasm` — VTK's C++ library compiled to WebAssembly — replace or complement the current vtk.js reimplementation in the webview? This is the record the roadmap's Tier 0 items point to; their removal from `roadmap.md` is explained here.

## Verdict

| Item | Verdict | One-line reason |
|---|---|---|
| 0 — standalone-session rendering spike | **Drop** | Every bound C++ method call is `Promise`-returning in the published artifact (`invokeAsync` is present and cannot be disabled via public API), and the CSP relaxation required (`'unsafe-eval'`, not merely `'wasm-unsafe-eval'`) is materially larger than the roadmap assumed. Both are structural properties of this release, not integration bugs. |
| 1 — wasm64 large-mesh path | **Drop, moot** | Blocked behind item 0: a memory-ceiling comparison is worthless work on top of a renderer whose basic API shape does not fit the product. Not independently measured. |
| 2 — WebGPU/WebXR and effects track | **Drop, moot** | Same dependency on item 0. WebGPU/WebXR presence was confirmed in the bundle but not exercised. |

None of this changes the shipped extension. vtk.js remains the renderer. Every script in `scripts/spike/` and every fetched binary in `out/vtk-wasm/` is excluded from both git (`.gitignore:10`) and the `.vsix` (`.vscodeignore:13`) — this document and the roadmap edit are the only durable artifacts of the spike.

## Provenance

- Pinned commit: `51747d0a772a5359b5e9b8a5bc06aab16b20f3ca` (`Kitware/vtk-wasm`, branch `dist`, path `latest/`). **Correction to a mistaken assumption made while planning this spike**: the URL segment `dist/latest` is branch **`dist`**, path **`latest/...`** — not a branch literally named `dist/latest` (confirmed via `git ls-remote https://github.com/Kitware/vtk-wasm.git`, which lists `refs/heads/dist` and nothing matching `dist/latest`).
- `@kitware/vtk-wasm@3.0.5` (npm loader package, no binary).
- `wasm32` binary: 12,734,421 bytes gzip, sha256 `79ae16e4…`; unpacks to `vtkWebAssembly.wasm` = 80.6 MB, `vtkWebAssembly.mjs` = 270.6 KB.
- `wasm64` binary: 13,280,334 bytes gzip, sha256 `aadcdf0e…`; unpacks to 87.4 MB / 280.2 KB. **Fetched but not exercised** (item 1 is moot — see verdict).
- Exact pins, sizes and checksums: `scripts/spike/vtk-wasm-manifest.json`. Reproduce with `node scripts/spike/fetch-vtk-wasm.mjs --all`, which refuses to unpack anything not matching this manifest.
- Test browser: Playwright's bundled Chromium, version **153.0.8010.12**, launched headless with `--use-angle=swiftshader --enable-unsafe-swiftshader` (software rasterizer, no GPU).
- VS Code's own Electron/Chromium version for the `^1.137.0` engine this repo targets was **not conclusively established** in this session (a web search did not return a definitive number). This matters for two of the findings below and is flagged inline.
- Date: 2026-09-18.

## What was and was not measured

Stated up front, not as a footnote, because it bounds every claim below:

- **CSP was exercised at an `http://127.0.0.1` origin**, served by a purpose-built zero-dependency static server (`scripts/spike/serve-spike.mjs`) carrying no COOP/COEP headers and no CSP header of its own — the CSP under test lives entirely in each page's `<meta>` tag, exactly as `buildPreviewHtml` does it. `vscode-webview://<uuid>` is a custom scheme; custom-scheme handling of `connect-src`, dynamic `import()`, and `application/wasm` responses was **not** exercised and must be re-verified in code-server before any adoption decision, though nothing about the finding below (the `'unsafe-eval'` requirement) is origin-scheme-dependent — it comes from `new Function()` inside the wasm glue, which CSP treats identically regardless of scheme.
- **file:// was not usable at all**, confirmed rather than assumed: `fetch()` of a `file://` URL is blocked by Chromium regardless of CSP, and the loader's `loadAsync()` does a real `fetch()` for both the glue module and (in gzip mode) the tarball. This is why a static http server was necessary just to ask the CSP question honestly — the existing screenshot harness's `file://` approach (`scripts/screenshots/capture.mjs`) cannot host this spike.
- **Playwright's Chromium is not Electron's Chromium.** The CSP finding is unlikely to be Chromium-version-sensitive (CSP directive semantics are stable), but this was not cross-checked against VS Code's actual shipped Electron build.
- **No code-server / real VS Code webview run.** Per the approved plan, verification stopped at "harness + real CSP injected," not "drive the packaged extension in code-server." Everything here is the strongest claim obtainable without that step.
- **SwiftShader is a software rasterizer, not a GPU.** Every FPS-shaped number here (render-call overhead) is a software-rendering number and is not informative about real-GPU performance; it remains informative about *per-call API overhead*, which is CPU-side and rasterizer-independent.
- **wasm64, WebGPU, WebXR, split-view panes, picking-identity, capture-pixel-timing, and translucency/OIT were not exercised** — see the verdict table. The kill-switch ladder in the approved plan (G0 fetch/pin → G1 CSP boot → G2 bulk transfer → G3 minimal render → G4 capture → G5 picking → G6 panes) is designed to fail fast and stop before the more expensive later gates when an earlier one is decisive. G0–G3 surfaced a blocking architectural finding (below); G4–G6 were not run because no outcome there would change the verdict.

## Findings

### G0 — fetch, pin, and binary soundness: PASS

- `node scripts/spike/fetch-vtk-wasm.mjs --all` reproduces the exact pinned bytes (checksum-gated; a mismatch throws and refuses to unpack, so a later push to the `dist` branch cannot silently invalidate these numbers).
- The 80.6 MB `wasm32` binary **compiles in 97 ms** under plain Node `WebAssembly.compile`, with 282 imports from `env`/`wasi_snapshot_preview1` only and **zero imported memory**.
- **Zero genuine threading symbols** in the glue (`pthread_create`, `ENVIRONMENT_IS_PTHREAD`, `SharedArrayBuffer`, `_emscripten_futex`, and a shared `WebAssembly.Memory` constructor are all absent). This independently confirms the module is single-threaded.
- **Correction to the roadmap's inherited assumption**: Tier 0's baseline text says to "mirror the meshio++ loader lesson — threaded/sequential variant selection … no-`SharedArrayBuffer` fallback." That lesson does not transfer. `@meshioplusplus/wasm` genuinely ships two artifacts (`_mt`/sequential) because it uses real threads; `@kitware/vtk-wasm`'s published `wasm32`/`wasm64` artifacts need neither `crossOriginIsolated` nor a variant-selection mechanism. (A naive `/pthread/i` substring grep initially reported false positives — it matches inside `depthReadOnly`/`depthStoreOp`, WebGPU descriptor property names. `fetch-vtk-wasm.mjs`'s check was corrected to match real symbols only, and the zero result was re-confirmed.)
- **Correction to a specific factual claim**: the roadmap's baseline says to "vendor the roughly 12–15 MB runtime-cached binary into `media/`." The npm package (`@kitware/vtk-wasm`, 412 KB) contains **no binary at all** — 12.7 MB is the *download* size of a separately-hosted tarball, whose *unpacked* binary is 80.6 MB. Anyone vendoring this into `media/` (a real `.vsix` payload, unlike `out/`) would ship 80.6 MB on disk for an 11.8 MB (deflate-9) `.vsix` cost per architecture.

### G1 — boot under CSP: PASS, but the required delta is bigger than assumed

Two static pages, differing only in their `<meta http-equiv="Content-Security-Policy">` (a CSP meta tag only governs resources requested after it is parsed, so this has to be two documents, not one page toggling a header): `boot-shipped.html` carries the **exact, unmodified** CSP `buildPreviewHtml` (`src/webviewChrome.ts:922-937`) emits today, extracted from the real function's own output rather than hand-copied, so this cannot drift from the shipped policy. `boot-augmented.html` adds a measured delta.

- **`boot-shipped.html`: fails**, exactly as expected. `default-src 'none'` with no `connect-src` blocks the loader's `fetch()` of the glue module. This confirms the gap the approved plan set out to close (the screenshot harness has no CSP at all and would have silently skipped this).
- **`boot-augmented.html` with `connect-src` + `'wasm-unsafe-eval'`: still fails.** `WebAssembly.instantiate` succeeds (confirming `'wasm-unsafe-eval'` does what it should), but `createStandaloneSession()` throws `"vtkStandaloneSession is not a constructor"` alongside a genuine CSP violation naming plain **`eval`** — not wasm compilation.
- **Root cause, measured directly in the shipped glue, not inferred from the CSP error**: `vtkWebAssembly.mjs` contains Embind's `craftInvokerFunction`, which does `new Function(args1, invokerFnBody)` and `new Function(Object.keys(captures), functionBody)(...Object.values(captures))` to JIT a fast per-method trampoline **for every bound C++ class method**, the first time each is invoked — not once at module load. This is how this build's Embind layer works; Emscripten's `-sDYNAMIC_EXECUTION=0` flag exists specifically to disable it, but the published artifact was not built with that flag.
- **`boot-augmented.html` with `connect-src` + `'unsafe-eval'` (dropping `'wasm-unsafe-eval'`, which `'unsafe-eval'` subsumes per the CSP3 spec): succeeds.** A real `vtkActor` instance is created and the session disposes cleanly. Full log: `out/spike/results/g1-boot-test.json`.

**The finding a "keep" decision would have to accept**: shipping this today would require adding `'unsafe-eval'` to the webview's `script-src`, not the far narrower `'wasm-unsafe-eval'` the roadmap's baseline anticipated. `'unsafe-eval'` is a broad, standard CSP-hardening rollback (it permits arbitrary `eval()`/`new Function()` string-to-code execution anywhere a script in that context runs) — a materially different security posture than "allow this one WASM module to compile," and worth stating plainly as a cost rather than a footnote.

### G2 — bulk transfer and the async-call cost: the write path is fast; the whole API surface is asynchronous

- **`toVTKAoSArray` (write path) is fast and scales cleanly**: 10⁴ to 10⁷ points (up to 114 MB) transferred at roughly **3–8 GB/s**, comfortably fast enough that bulk geometry upload is not a bottleneck. Constructors (`session.vtk.vtkActor()`, the `toVTKAoSArray` factory path) are confirmed **synchronous** — they return real objects, not Promises.
- **Every bound instance method — every getter and every setter — returns a Promise.** Verified directly, not inferred: `actor.getVisibility() instanceof Promise === true`, `actor.setVisibility(true) instanceof Promise === true`. This is because the published artifact exposes `invokeAsync`, and the loader's proxy layer unconditionally routes every instance method call through it once that capability is present — confirmed by explicitly passing `LoadOptions.exec: "sync"` and observing **no change**: `render() instanceof Promise` was still `true`. The published documentation says as much for single-binary bundles ("the proxy feature-detects `invokeAsync` at runtime"); this spike confirms there is no public option to opt out when the capability exists in the binary, which it does in both published architectures.
- **Per-call overhead is real and non-trivial**: 2,000 sequential `await actor.setVisibility(...)` calls took ~110–118 µs each (measured three times, consistently in that band). For comparison, the equivalent vtk.js call is a synchronous property write costing nanoseconds.
- **A documented public API is broken under this specific artifact**: `toJSTypedArray()` — the zero-copy read-back half of `TypedArrayInterface`, used to read a VTK array's bytes back into a JS view — throws `TypeError: vtkTypeFloat32Array holds NaN-byte values of VTK data type NaN, which has no JavaScript TypedArray equivalent` on every call. Root cause, traced into the library's own transpiled source: its internal implementation computes `Number(vtkArray.getDataType())` **without awaiting it**, and since `getDataType()` is one of the Promise-returning instance methods above, `Number(Promise)` is `NaN`, and the function throws before it can return anything meaningful. This is a defect in the published artifact's own async/sync consistency, not a spike usage error — confirmed by first fixing the call site to `await` correctly and observing the failure is *inside* the library, before that await could matter. **There is currently no working documented path to read a VTK array's bytes back into JavaScript under this artifact.**
- Full data: `out/spike/results/g2-transfer-test.json`.

### G3 — minimal end-to-end render: PASS, with the same async fact confirmed at the render call itself

A single red triangle — real `vtkPoints`, `vtkCellArray` (via `ImportLegacyFormat`, see below), `vtkPolyData`, `vtkPolyDataMapper`, `vtkActor`, `vtkRenderer`, and `vtkWebAssemblyOpenGLRenderWindow` bound to a genuine `<canvas>` via `registerCanvas` — renders correctly under headless SwiftShader, under the G1-augmented CSP:

![A red vtkPolyData triangle rendered end-to-end through vtk-wasm — vtkPoints, vtkCellArray, vtkPolyDataMapper, vtkActor, vtkRenderer and vtkWebAssemblyOpenGLRenderWindow, bound to a real canvas, in headless Chromium under software rendering](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/vtk-wasm-spike-triangle.png)

- `renderWindow.render()` **is itself a Promise**, consistent with G2. Its own per-call overhead measured low (~0.36–0.48 ms across 60 sequential awaited calls on this trivial one-triangle scene, on SwiftShader) — the concern is not this call in isolation, but its combination with the ~110 µs tax on every one of the many individual `setColor`/`setVisibility`/`addActor`/`addClippingPlane`-shaped calls `webview/main.ts` makes per scene rebuild, per layer, per pane.
- **A named, predicted risk materialized and was fixed as part of proving the render path, not glossed over**: VTK 9.x's `vtkCellArray` genuinely does not accept `webview/meshBuilder.ts`'s legacy `n,i0,i1,…` layout via `setData()` — that call is *silently accepted* (no error) but produces zero usable cells. The correct call is `vtkCellArray::ImportLegacyFormat(vtkIdTypeArray)`, exactly as anticipated in planning; `vtkIdTypeArray` must be built manually via the session's low-level `HeapInterface.copyToHeap`/`toSizeType` primitives, because `toVTKAoSArray`'s fixed-width lookup table has no entry for it. `vtkIdType` is confirmed **32-bit** on the `wasm32` artifact (from `vtkIdTypeArray.SetArray`'s parameter type); this was not independently re-checked against `wasm64`.
- A second, smaller footgun found the same way: `vtkPoints.setData()` takes **exactly one** argument (the `vtkDataArray`, which already carries its own component count) — a second, vtk.js-habit `numberOfComponents` argument is silently accepted and ignored, leaving `vtkPoints` with zero points and the mapper's bounds at VTK's uninitialized-bounds sentinel `[1,-1,1,-1,1,-1]`, with no error at any layer. Both of these are the kind of signature drift a real port would need to re-verify **per VTK method**, not assume from vtk.js familiarity.
- Screenshot and full data: `out/spike/results/g3-render.png`, `g3-render-test.json`.

## Corrections to the roadmap's Tier 0 baseline assumptions

For the record, since these were treated as settled facts going in and were not:

1. **"Vendor the roughly 12–15 MB binary into `media/`"** — the npm package has no binary; 12.7 MB is a separately-hosted tarball's download size; the unpacked binary is 80.6 MB (wasm32) / 87.4 MB (wasm64).
2. **"Mirror the meshio++ loader lesson — threaded/sequential variant selection … no-`SharedArrayBuffer` fallback"** — does not apply. The published artifacts are single-threaded; no `crossOriginIsolated` requirement, no variant selection.
3. **`emit_memory`, mentioned as a memory-reporting mechanism** — is a `trame-vtklocal`/`LocalView` **server-side** feature (a different deployment mode entirely), not an API on `StandaloneSession`. The standalone-session analogue would be reading the WASM module's own heap size (e.g. `Module.HEAP8.byteLength`), not exercised in this spike since item 1 was not reached.
4. **The CSP cost was assumed to be `'wasm-unsafe-eval'`-shaped** — it is `'unsafe-eval'`-shaped, a materially larger relaxation, because of Embind's runtime JIT trampolines (`craftInvokerFunction`), not merely WASM instantiation.
5. **Unstated but implicit in treating this as "a rendering backend swap"**: the published artifact's entire instance-method surface is asynchronous. This is not a rendering-backend-specific detail; it is a fundamental difference in programming model from vtk.js's synchronous API, and it is the actual reason for the "drop" verdict, not the CSP cost (which is merely inconvenient) or the binary size (merely expensive).

## Why "drop," specifically

`webview/main.ts` is 4,951 lines built entirely on the assumption that `actor.setColor(...)`, `mapper.setInputData(...)`, `renderer.addActor(...)`, `renderWindow.render()`, and hundreds of calls like them complete synchronously and in-order within the calling function. Porting to this vtk-wasm artifact would mean:

- Every one of those call sites becomes `await`-shaped, and every function that contains one becomes `async` — a transformation that cascades through the entire call graph (the classic "function coloring" problem), not a localized rewrite.
- Each such call now costs a real, measured ~110 µs of pure call/microtask overhead on top of whatever work it does — multiplied across the dozens-to-hundreds of individual property calls a single scene rebuild, layer-visibility toggle, or per-pane camera update already makes today at effectively zero cost.
- The one documented API this spike needed for a read-back path (`toJSTypedArray`) does not work at all under the artifact this pin resolves to.
- On top of the above, adopting it costs `'unsafe-eval'` in the webview's CSP and ~11.8 MB (wasm32 alone) added to a `.vsix` whose real baseline (net of an unrelated stray file since removed from the repo) is ~13.5 MB — i.e., close to doubling it for one architecture, before wasm64 is even considered.

None of these are integration friction to be smoothed over incrementally; each is a structural property of the published `@kitware/vtk-wasm@3.0.5` artifact. Items 1 and 2 build features on top of exactly this API, so they inherit the verdict rather than needing independent disproof.

## Reproduce

```bash
# 1. Fetch and pin the binaries + loader (checksummed against
#    scripts/spike/vtk-wasm-manifest.json; refuses on mismatch).
node scripts/spike/fetch-vtk-wasm.mjs --all

# 2. Playwright, out-of-tree (not a repo dependency; same precedent as
#    scripts/screenshots/capture.mjs).
mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
NODE_PATH=/tmp/pw/node_modules npx playwright-core install chromium
cd -

# 3. Serve the spike pages (no CSP/COOP/COEP headers of its own — see
#    scripts/spike/serve-spike.mjs's module doc).
node scripts/spike/serve-spike.mjs &

# 4. Run each kill-switch gate.
node scripts/spike/buildBootPages.mjs        && NODE_PATH=/tmp/pw/node_modules node scripts/spike/runBootTest.mjs       # G1
node scripts/spike/buildTransferPage.mjs     && NODE_PATH=/tmp/pw/node_modules node scripts/spike/runTransferTest.mjs  # G2
node scripts/spike/buildRenderPage.mjs       && NODE_PATH=/tmp/pw/node_modules node scripts/spike/runRenderTest.mjs    # G3

# Results land in out/spike/results/ (gitignored — not committed).
```

## If this is ever revisited

Re-run against a newer `@kitware/vtk-wasm` release and specifically re-check, in this order (matching how quickly each could overturn the verdict): (a) whether a future release ships a build without `invokeAsync` / with `-sDYNAMIC_EXECUTION=0`, which would remove both the async-everywhere finding and the `'unsafe-eval'` requirement in one step; (b) whether `toJSTypedArray` has been fixed to `await` its own internal calls; (c) only then repeat G4 (capture), G5 (picking-identity), G6 (pane sensitivity), wasm64, and WebGPU/WebXR, which were not run here because nothing they could show changes a verdict this items 0's two structural findings already settle.
