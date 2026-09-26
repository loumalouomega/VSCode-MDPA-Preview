# VTK-wasm migration — working record

Record of roadmap item 18 (Replace vtk.js with VTK-wasm), reopened on 2026-09-25 and worked from 2026-09-26. The 2026-09-18 [spike report](./vtk-wasm-spike.md) stays unchanged as the historical baseline; its [erratum](./vtk-wasm-spike.md#erratum-2026-09-26) explains why two of its three structural findings do not survive a correct measurement. This page is the live record: pins, gate results with their evidence files, the CSP delta and its justification, measured API conventions, sizes, and what is next. vtk.js remains the shipped renderer until the gates below say otherwise.

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Corrected re-evaluation of the candidate runtime | **Passed** (G0.1–G0.11) |
| 1 | Deterministic glue rewrite and strict-CSP proof | **Passed** (G1.1–G1.6) |
| 2 | Renderer boundary with vtk.js behind it, zero behaviour change | Not started |
| 3 | Asset pipeline and packaging (binary ships in the `.vsix`) | Not started |
| 4 | Experimental VTK-wasm backend, selection and fallback | Not started |
| 5 | Parity, capture and performance gates | Not started |
| 6 | Default switch | Not started |
| 7 | vtk.js removal | Not started |

A gate failure is recorded in the gate log with its evidence and the next remediation step, item 18's status line in the roadmap points at it, and no later phase starts.

## Pins and provenance

Pinned in `scripts/vtk-wasm/manifest.json`, fetched by `scripts/vtk-wasm/fetch.mjs` from `raw.githubusercontent.com` **by commit**, never by branch: the upstream `dist` branch is force-pushed (its history was rewritten between the spike and this pin, and the spike's commit `51747d0a` is now reachable only by hash). Every unpacked file is hash-gated individually; a second, cache-free fetch reproduced identical bytes (G0.1).

| Item | Value |
|---|---|
| Upstream | `Kitware/vtk-wasm`, branch `dist`, commit `7176f04451e4bb2b1f872c67b0338fd3506c216e` (resolved 2026-09-26) |
| Selected candidate | `latest/vtk-wasm32-emscripten.tar.gz`, VTK **9.7.20260920**, 13,034,333 bytes, sha256 `258533091b59798be35c33f9813b50499fe26a9323c60065eda5ac72b1890600` |
| `vtkWebAssembly.wasm` | 86,183,750 bytes, sha256 `3302b6af…` |
| `vtkWebAssembly.mjs` (upstream) | 279,297 bytes, sha256 `d6ab62cf…` |
| `vtkWebAssembly.mjs` (patched) | 279,045 bytes, sha256 recorded in the manifest's `glue` entry |
| `types/*.json` | 832 manifests, digest `1115e1d4…` — source of the method table |
| Loader (evaluation only) | `@kitware/vtk-wasm@3.0.5`, sha256 `9d0b9986…`; npm `latest` is still 3.0.5 |

**Candidate selection.** Two candidates were pinned and measured. The stable **VTK 9.7.0** release (`releases/9.7.0/`, 23,682,030 bytes) ships a separate synchronous build with no Asyncify and no JSPI imports, which would have removed the JSPI dependency outright — but it registers **no `SetArray`/`GetPointer` invokers** on any data array: every typed-array round trip logs `Call to … is not permitted` and returns nothing (`results/typedarrays-rel-9.7.0-patched.json`), so bulk geometry cannot reach it except one value at a time. It also exports neither the heap views nor the allocator. It is rejected. The nightly **9.7.20260920** unified build has the typed-array invokers, exports the heap and allocator, and carries the `types/` manifests; it requires JSPI (`Asyncify.instrumentWasmImports` wraps imports in `WebAssembly.Suspending` unconditionally, so a host without JSPI cannot instantiate it at all) — which G0.6 measured to be present at the engine floor.

## Gate log

Evidence is written to `out/vtk-wasm-eval/results/` (gitignored) by `scripts/vtk-wasm/eval/run.mjs <gate>` (http origin, Playwright Chromium 153, SwiftShader) and by `scripts/vtk-wasm/probe-extension/run.mjs` (real desktop VS Code). Timings under SwiftShader are CPU-rasterizer numbers: call overhead is meaningful, frame rates are not.

| Gate | Result | Evidence |
|---|---|---|
| G0.1 Re-pin | **Pass.** Identical bytes on an independent fetch; 0 threading symbols (single-threaded, no `SharedArrayBuffer`/cross-origin isolation needed); `WebAssembly.compile` 77 ms in Node; 287 imports, no imported memory. | `g0-1-pin.json` |
| G0.2 Method table | **Pass.** With a `vtk-methods.json` generated from `types/`, the loader returns plain values from getters and setters and a Promise only from `Render`; the same binary served **without** the table returns a Promise from every method — the spike's condition, reproduced exactly. Gzip mode classifies identically to directory mode. | `methodtable-latest-9.7.20260920.json` |
| G0.3 API coverage | **Pass.** All 210 entries of `src/parser/render/vtkWasmApiUsage.ts` resolve against the 832-class table; exactly one suspends (`Render`, declared on `vtkWindow`). The full maySuspend set is 13 methods (`vtkWindow::Render`/`GetPixelData`, `vtkRenderWindow::Start`/`Initialize`/`Frame`/`WaitForCompletion`/`GetRGBA*PixelData`/`GetZbufferData`, four WebGPU-only). | `g0-3-usage-latest-9.7.20260920.json` |
| G0.4 Overhead | **Pass** (budgets written before the run: scalar get/set ≤ 20 µs, create+delete ≤ 250 µs, toggle ≤ 5 ms, 50-layer rebuild ≤ 150 ms excluding upload, upload ≥ 1 GB/s). Successful native calls: 4.1–5.5 µs (`SetInputData` 9.3 µs); create+destroy 5.6 µs; toggling one layer in 4 panes 0.1 ms; 50 layers × 4 panes rebuilt in 34 ms excluding upload; upload 3.8 GB/s at 10⁵ points, 8–9 GB/s at 10⁶–5·10⁶ (0.2 ms fixed cost at 10⁴). 0 failed calls during the benchmark. | `overhead-latest-9.7.20260920.json` |
| G0.5 Typed arrays | **Pass.** Exact round trips for all 10 TypedArray kinds (incl. `BigInt64`/`BigUint64`) × n ∈ {0, 1, 10⁶} × {1, 3} components; a heap view **detaches** on growth (copy immediately); `vtkIdType` is 4 bytes; `vtkCellArray::SetData(offsets, connectivity)` round-trips. Both spike pitfalls reproduce and now log an error: a legacy `[n, i0…]` array given to `SetData` → 0 cells; a stray second argument to `vtkPoints::SetData` → 0 points. | `typedarrays-latest-9.7.20260920.json` |
| G0.6 JSPI | **Pass.** `WebAssembly.Suspending`/`promising` present and the module boots in Chromium 153 (code-server route), **VS Code 1.139.0** (Electron 43.6.0, Chromium 150) and **VS Code 1.138.0** — the `engines` floor — (Electron 42.10.0, Chromium 148). Firefox/Safari hosts (code-server in those browsers) are unmeasured and are the reason a vtk.js fallback stays until Phase 7. | `jspi-latest-9.7.20260920.json`, `g1-5-vscode-1.138.0.json`, `g1-5-vscode-1.139.0.json` |
| G0.7 Capture timing | **Pass.** 100/100 correct, non-blank frames for (A) `await invokeAsync(Render)` then copy — no macrotask boundary ever observed — and (B) a **synchronous** `invoke(Render)` then copy in the same task, which never suspended on WebGL (3.9 ms/frame vs 4.5). (C) `preserveDrawingBuffer` also works but costs ~2× per frame. Negative control: copying after a macrotask *without* preserve is wrong 13/30 times, so the test can see the failure it guards against. **Decision:** synchronous `Render` with an `invokeAsync` fallback if it ever throws a suspension — vtk.js's render-then-copy contract, and the recorder, unchanged. | `capture-latest-9.7.20260920.json` |
| G0.8 Picking identity | **Pass**, 8/8: actor identity by object id across 2 viewports, cell ids in verts → lines → polys order, a pick falls through to the actor behind, a miss is a miss, and with `SetPickClippingPlanes(1)` a clipped-away region is not pickable while the kept half is. | `picking-latest-9.7.20260920.json` |
| G0.9 Viewports | **Pass.** Four renderers as quadrants plus a non-interactive renderer on layer 1, pixel-checked, before and after a `SetSize` resize. | `viewports-latest-9.7.20260920.json` |
| G0.10 Disposal | **Pass.** 50 cycles of 20 layers × 5 000 triangles × 4 viewports: heap growth 0 % and VTK data-object memory back to 0 between cycles 10 and 50; a deliberate leak is detected (data-object memory 2.8 → 14.1 MB over 5 cycles). **Rule found:** an object obtained through a getter (e.g. a renderer's active camera) stays registered in the session's object manager after its owner is destroyed (10/20 alive) — the backend creates and sets such objects itself or destroys getter ids explicitly. | `disposal-latest-9.7.20260920.json` |
| G0.11 Text | **Pass.** `vtkTextActor` draws (1 453 lit px); scalar bar, vector text, annotated cube and cube axes all draw. `AddActor2D` is **not** in the invoker registry (a silent logged `null`) — 2D actors go through `AddActor`/`AddViewProp`. | `text-latest-9.7.20260920.json`, `textdebug-latest-9.7.20260920.json` |
| G1.1 Needles | **Pass.** Each needle (`createJsInvoker` sync and async variants, `__emval_create_invoker`, the export anchor) occurs exactly once; output is deterministic (identical sha256 on re-run). | `scripts/vtk-wasm/patch-glue.mjs` |
| G1.2 Differential | **Pass.** `src/test/vtkWasmGlue.test.ts` runs the ORIGINAL upstream factory text (via `new Function`, legal in Node) against the replacement over 2 016 invoker scenarios (1 980 non-trivial: receiver × return × async × destructor mode × arity 0–6 × every throw site) and 38 emval scenarios; traces, results, errors, `.length` and names are identical. A mutation check (reversed destructor order, missing `.length`, array-vs-null destructor stack, a changed receiver) is caught by the suite. | `npm test` |
| G1.3 No dynamic code | **Pass.** `scanDynamicCode` finds 2 sites before and 0 after; `node --check` accepts the output. | `patch-glue.mjs` |
| G1.4 Browser equivalence | **Pass.** Identical 87-entry call transcript and identical RGBA sha256 for 3 rendered scenes between the upstream glue (with `'unsafe-eval'`) and the patched glue under a strict CSP with **no** `'unsafe-eval'`, zero violations. Negative control: the upstream glue under the strict CSP fails with an `eval` violation and `vtkStandaloneSession is not a constructor` — the spike's G1 failure, reproduced. | `equivalence-latest-9.7.20260920-*.json` |
| G1.5 Real webview CSP | **Pass** in VS Code 1.139.0 and 1.138.0: the shipped CSP (V0) fails on `connect-src`; **V1 = shipped + `'wasm-unsafe-eval'` + `connect-src ${cspSource}`** boots and renders the patched glue with zero violations; adding `${cspSource}` to `script-src` (V2) is unnecessary (the nonce propagates to the dynamic `import()` of the glue); the upstream glue under V1 (V3) fails; the upstream glue with `'unsafe-eval'` (V4) works. The `.wasm` is served as `application/wasm`, so streaming compilation applies. | `g1-5-vscode-*.json` |
| G1.6 Invoker overhead | **Pass.** Closure invokers within 0.97–1.05× of the generated ones on every measured call (budget ≤ 1.10). | `overhead-latest-9.7.20260920-{permissive,patched-strict}.json` |

## CSP delta

The VTK-wasm preview's policy is the shipped policy plus exactly two tokens; `'unsafe-eval'` never appears.

| Token | Why |
|---|---|
| `'wasm-unsafe-eval'` in `script-src` | Required by `WebAssembly.instantiateStreaming`/`compile` for any wasm module. It permits compiling WebAssembly only — not JavaScript `eval`/`new Function`, which stay blocked; that is what the glue rewrite is for. |
| `connect-src ${cspSource}` | The glue fetches `vtkWebAssembly.wasm` (and the backend fetches nothing else). Scoped to the extension's own resource origin; no `blob:`, no network. `webview/videoRecord.ts` still never needs `fetch(blobUrl)`. |

## Measured API conventions

These are properties of the session API the backend is built on, all measured (`probe`, `overhead`, `disposal`, `textdebug` gates):

- **Native session, not the loader proxy.** The backend calls `Module.vtkStandaloneSession`'s `create`/`invoke`/`invokeAsync`/`destroy` directly with C++ method names. The loader's proxy serialises an object's whole state when it wraps it (66 µs per create+destroy through the proxy vs 5.6 µs native) and needs a method table at runtime to avoid wrapping everything async; the native API needs neither. The method table is still generated, but at **build** time, to audit the usage list.
- **Integer flags.** A JS boolean argument is rejected (`No suitable overload … [false]`, logged, call ignored) — every flag is `0`/`1`. This is what invalidated the spike's overhead benchmark.
- **Errors are logged, not thrown.** An unknown or ill-typed call returns `null` and prints an `ERR|` line. The usage audit (G0.3) is therefore a build gate, not a nicety.
- **Object-returning getters return the whole serialised state** (`GetProperty` → every property field plus `Id`; 34 µs). The backend creates the objects it needs (its own `vtkProperty`, camera) and keeps ids, calling such getters only off hot paths.
- **Getter-registered objects outlive their owners** in the object manager (G0.10) and must be destroyed explicitly.
- **2D actors** are added with `AddActor`/`AddViewProp`; `AddActor2D` is not registered.
- **Canvas binding.** `Module.specialHTMLTargets[key] = canvas` then `SetCanvasSelector(key)`; `_setDefaultExpandVTKCanvasToContainer(0)` and `_setDefaultInstallHTMLResizeObserver(0)` before creating the render window, so VTK never restyles or resizes the canvas behind the preview's back.

## Sizes

| Item | Bytes |
|---|---|
| `vtkWebAssembly.wasm` unpacked / deflate-9 (≈ `.vsix` cost) | 86,183,750 / 12,673,741 |
| Patched glue unpacked / deflate-9 | 279,045 / 65,897 |
| `vtk-methods.json` (build-time audit only; not shipped) | 385,639 |
| Current `media/webview.js` (vtk.js, production) | 1,373,384 |

Installed-extension and compressed-`.vsix` totals are measured in Phase 3.

## Next

Phase 2: put vtk.js behind an extension-owned renderer boundary (`webview/render/`), with pixel-identical parity captures after every extraction step, before any VTK-wasm code enters the product.
