# VTK-wasm migration — working record

Record of roadmap item 18 (Replace vtk.js with VTK-wasm), reopened on 2026-09-25 and worked from 2026-09-26. The 2026-09-18 [spike report](./vtk-wasm-spike.md) stays unchanged as the historical baseline; its [erratum](./vtk-wasm-spike.md#erratum-2026-09-26) explains why two of its three structural findings do not survive a correct measurement. This page is the live record: pins, gate results with their evidence files, the CSP delta and its justification, measured API conventions, sizes, and what is next. vtk.js remains the shipped renderer until the gates below say otherwise.

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Corrected re-evaluation of the candidate runtime | **Passed** (G0.1–G0.11) |
| 1 | Deterministic glue rewrite and strict-CSP proof | **Passed** (G1.1–G1.6) |
| 2 | Renderer boundary with vtk.js behind it, zero behaviour change | **Passed** (G2) |
| 3 | Asset pipeline and packaging (binary ships in the `.vsix`) | **Passed** (G3) |
| 4 | Experimental VTK-wasm backend, selection and fallback | **Passed** (G4) — ships in 4.8.0 behind `kratos.preview.renderer` |
| 5 | Parity, capture and performance gates | **In progress** — performance and memory budgets met on SwiftShader; awaiting the real-GPU checklist and a tolerance decision for edge-dense scenes |
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
- **Flags must match their C++ type exactly.** A `vtkTypeBool`/`int` flag (manifest type `Int32`) rejects a JS boolean (`No suitable overload … [false]`, logged, call ignored) — this is what invalidated the spike's overhead benchmark — while a genuine C++ `bool` parameter (manifest type `boolean`) rejects an integer in the same way (measured in Phase 4 on `vtkCubeAxesActor::SetDrawXGridlines`). The backend encodes by the declared list `VTK_WASM_BOOL_PARAM_METHODS`, and the asset build's usage audit (`boolParamProblems`) fails if that list and the pinned build's manifests disagree in either direction.
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

## Phase 2 — renderer boundary

### 2.0 Parity tooling and pre-existing defects

The renderer refactor is gated on **pixel-identical** captures. `scripts/render-parity/` holds the tooling: `scenes.mjs` is a 31-scene catalog (base display, clipping, split view, analysis overlays, picking at devicePixelRatio 1 and 2, contour/iso/threshold/scalar bar/clip cap, quiver/deformed, spheres, beams, node labels) driven through the real webview bundle in the screenshot harness by the same messages and controls a user would use; `capture.mjs` writes a PNG of `#render-root` plus a JSON sidecar (stats, Inspect panel text, posted message types, console and action errors) per scene; `compare.mjs` diffs two captures inside Chromium (no image dependency) and writes a magenta diff image per changed scene; `run-checks.mjs` runs the four existing smoke checks, each against the harness it needs (`check-selection` silently tests whatever harness the previous check left behind, which is how a one-triangle PLY harness once made it fail for no code reason). The harness gained `HARNESS_OUT` (one harness per scene mesh) and a `badquality` scene, because no example mesh has a single element in the quality panel's bad band. **Determinism:** two captures of the same bundle are identical in 30 of 31 scenes; `c02-deformed` varies by 15 pixels at a maximum channel difference of 2 — its recorded noise floor.

Two pre-existing defects surfaced and were fixed before any refactor, so that the baseline is the corrected behaviour:

- **HiDPI picking.** `pickAt` and the orientation cube passed CSS pixels to `vtkCellPicker`, while `GenericRenderWindow` sizes the canvas at CSS size × devicePixelRatio. Measured: the same click resolved element 34550 at devicePixelRatio 1 and element 32731 — near the bottom-left corner, i.e. at half the coordinates — at 2. Every Inspect click, measure, probe, Ctrl+click and box/lasso selection on a HiDPI screen landed in the wrong place. Both now scale by `canvas.width / rect.width`; the dpr-2 scene picks the same entity as dpr 1.
- **`check-filename-timeline.mjs`** replaced a `postMessage() {}` stub that the harness no longer emits, so its host bridge was never connected; the replacement is now asserted.

### 2.1–2.9 The boundary

`webview/render/backend.ts` is now the only way the webview reaches a renderer: panes hold `RView`s, layers hold one `RProp` per pane over one shared `RGeometry`, and everything handed across — geometry, glyph sets, colouring, property updates — is plain data from pure, Node-tested modules in `src/parser/render/` (`types.ts`, `displayGeometry.ts`, `cellArrays.ts`, `scalarColoring.ts`, `glyphSets.ts`; tests in `src/test/renderData.test.ts`, which checks the cell index against vtk.js's own `getCellPoints` and the colour-transfer points against a vtk.js transfer function). The vtk.js implementation (`webview/render/vtkjs/`) is a transcription of `main.ts`'s former plumbing — the same calls in the same order — and `src/test/rendererBoundary.test.ts` fails on any vtk.js import outside it. Two semantic decisions ride the boundary: **completion is synchronous** (G0.7 measured that VTK-wasm's WebGL `Render` never suspends, so the recorder's render-then-copy contract carries over unchanged), and **picking returns only the prop and cell id** — a picked cell's points come from the layer's own geometry through a JavaScript cell index, so which entity a click means never depends on the backend.

**G2 — passed.** All 34 parity scenes reproduce the pre-refactor baseline pixel for pixel (`c02-deformed` within its measured noise floor, the three scenes added during the refactor captured against a bundle built from the pre-refactor commit), every sidecar is identical (including every Inspect result), `run-checks.mjs` passes all four smoke checks, and typecheck and tests pass. `webview/meshBuilder.ts`, `quiver.ts`, `sphereGlyph.ts` and `beamGlyph.ts` are gone (their logic is in `src/parser/render/`), `colormaps.ts` no longer imports vtk.js, and a stale committed `webview/colormaps.js` was removed.

## Phase 3 — asset pipeline and packaging

`npm run vtkwasm:prepare` (`scripts/vtk-wasm/prepare-assets.mjs`) is one step with every gate on the way: fetch the selected build by commit (cache first) and verify it file by file, patch the glue and verify the recorded output hash, audit the backend's 210 declared API entries against the build's own method table (any missing or unexpectedly-suspending method fails the build), stage the licence notices, and write `out/vtk-wasm/prepared/` with a provenance manifest (`vtk-wasm-assets.json`) of every file. `esbuild.js`'s `copyVtkWasmPlugin` copies that tree into `media/vtk-wasm/` and re-verifies it there; a production build prepares it itself when missing and fails if the copy does not verify, a dev build only warns, and `KRATOS_VTK_WASM=skip` opts out explicitly. `package.yml` runs the prepare step before `vsce package` and `scripts/vtk-wasm/verify-vsix.mjs` after it — which reopens the packaged `.vsix` with the extension's own ZIP reader, checks every runtime file against the shipped manifest and re-scans the glue AS SHIPPED for dynamic code. `ci.yml` gains a `vtk-wasm-runtime` job so a broken pin fails on the push that broke it, and `vtk-wasm-watch.yml` files a re-pin issue (with the measured procedure as its checklist) when the upstream `dist` branch publishes a newer build.

**Licences.** VTK-wasm's tarball carries no licence files, so `scripts/vtk-wasm/collect-licenses.mjs` builds them from source at pinned commits and the output is committed under `scripts/vtk-wasm/licenses/` with a SHA-256 per reproduced file: VTK's `Copyright.txt` (BSD-3-Clause) at `eec5cc24` — the VTK master commit that stamped version 9.7.20260920 — every VTK third-party module's licence files located exactly as VTK declares them (`LICENSE_FILES` + `SPDX_LICENSE_IDENTIFIER` in `ThirdParty/<lib>/CMakeLists.txt`; 45 modules), and Emscripten's licence plus the runtime libraries it links into every binary (musl, libc++, libc++abi, compiler-rt, libunwind). The build compiles only a subset of those modules and ships no list of which, so every notice is reproduced — over-inclusion cannot omit one that is present. Its invoker registry (829 wrapped classes) contains no XDMF, HDF5, NetCDF, Exodus, CGNS, IOSS, PROJ, SQLite, TIFF, PNG or JPEG readers — which matters because the XDMF modules are the only BSD-4-Clause (advertising-clause) components VTK can bundle, and they are absent; every component that is present is under a permissive licence (BSD, MIT, Zlib, FreeType's FTL, BSL-1.0, Apache-2.0, public domain).

**Sizes (G3).** From a clean cache, `npm run vtkwasm:prepare` downloads 13,034,333 bytes and stages 86,650,184 bytes (wasm 86,183,750 + patched glue 279,045 + notices). The compressed `.vsix` grows from **16,617,617** to **29,892,724** bytes (+13,275,107, i.e. +12.7 MiB; the Phase 5 budget is +15 MB), 168 → 173 entries. The webview bundle is unaffected (the backend will load the glue at runtime, not bundle it).

**Pending a maintainer decision:** a mirror of the tarball as a release asset of this repository, so a force-push upstream cannot make a pinned build unfetchable (`manifest.mirrors`). It is outward-facing, so it is not created without asking.

## Phase 4 — experimental backend, selection and fallback

**Selection.** `kratos.preview.renderer` (`vtkjs` default, `vtkwasm`; window scope, applies to previews opened after a change, which a one-line notice says). The host decides only what it can know — VTK-wasm is requested and its runtime is present (`src/parser/render/rendererSelect.ts`) — and the webview decides the rest: it posts `ready` at once so the host's parse overlaps the wasm compile, queues host messages until a backend exists, checks JSPI and WebGL2, and boots VTK-wasm under a 60 s limit; any failure creates the vtk.js backend and the first scene carries one `fallbackMessage` line naming the reason. `buildCsp` keeps the vtk.js policy byte-identical and adds exactly the G1.5 delta for VTK-wasm (`previewHtml.test.ts` pins both, and that `'unsafe-eval'` never appears).

**The backend** (`webview/render/vtkwasm/backend.ts`) implements the Phase 2 boundary over the native session. Where vtk.js supplied something the C++ build does not, it is rebuilt in JavaScript and made pure where possible (`src/parser/render/cameraMath.ts`, `glyphSources.ts`, both Node-tested):

- **Mouse camera control** is a transcription of the vtk.js 37.3.0 trackball rotate/pan/zoom manipulators and wheel normalization, including the rotation centre at the world origin, so both backends move the camera identically for the same motion; `resetCamera(bounds)` and the bounds-based clipping-range reset are ported from vtk.js too (the C++ no-argument reset cannot express "clip to this element", which Find relies on — scene a33 went from visibly different to 1.1 %).
- **The orientation marker** is a non-interactive layer-1 renderer with `vtkAnnotatedCubeActor` + `vtkAxesActor`, synced to the focused pane's camera before each render; a face click is resolved by a JavaScript ray–cube test (`cubeFaceHit`), not a picker round trip.
- **The beam cylinder along +X** is generated in JavaScript (the C++ `vtkCylinderSource` has no direction and the build has no transform filter).
- **Coincident topology** is reproduced per mapper: the C++ mode and static offsets are process-wide with no invoker entry, so they are switched on and zeroed once through `session.set` (measured: any mapper's state keys set the statics), and a mapper that asks for an offset carries vtk.js's statics (polygon 2/0, line 1/−1, point −2) folded into its relative parameters — a mapper that asks for nothing gets exactly vtk.js's "off".
- **Picking is two-stage** — exact (`1e-6`) first, vtk.js's `0.025` as the fallback. Against an exact JavaScript ray cast over every surface triangle of the double arch (40 clicks), the C++ picker at `1e-6` found the true front cell on 23/23 hits and missed exactly the 17 empty clicks; at `0.025` only 12/23 were the true cell, the tolerance letting a neighbouring triangle win. The fallback keeps lines and points pickable and keeps vtk.js's forgiveness just off a silhouette: the hit/miss pattern now matches vtk.js exactly, and 30/40 entities agree, the rest being near-edge clicks where vtk.js's own tolerance is not ground truth.
- **Translucency stays on the C++ order-independent pass.** Depth peeling is refused on WebGL2 (*"Built in Dual Depth Peeling is not supported on ES3"*, measured) and plain blending is draw-order dependent. Known cost, measured in scene b07: a translucent wireframe exactly coplanar with an opaque overlay is dropped — with OIT off it appears at the requested 40 % alpha, whereas the vtk.js baseline draws it opaque (the SwiftShader OIT caveat recorded in CLAUDE.md), so neither baseline is the reference there.
- **Session errors are surfaced**: the invoker logs instead of throwing, so its `ERR|` lines go to the console (capped), and the parity and smoke tooling count them.

**G4 — passed.** Evidence in `out/vtk-wasm-eval/results/`:

| Check | Result |
|---|---|
| Harness boot (`scripts/vtk-wasm/g4-smoke.mjs`) | VTK-wasm draws under the REAL preview CSP (`HARNESS_CSP=1`) in 2.9 s with zero CSP violations, console errors and backend warnings; every request is same-origin. |
| Screenshot | View ▸ Screenshot posts a non-blank PNG (142 804 lit px). |
| Recording | A 5-frame PNG turntable posts 5 ordered, non-blank frames. |
| Inspect | 20 fixed clicks hit/miss exactly where vtk.js does (entity agreement reported, see picking above). |
| Fallbacks | Without `WebAssembly.Suspending`, and with a corrupt `.wasm`, the preview renders on vtk.js and names the reason. The host-side "runtime missing" fallback is unit-tested. |
| Real host (`scripts/vtk-wasm/g4-vscode.mjs`) | The **packaged `.vsix`** installed into an isolated profile of desktop **VS Code 1.139.0 and 1.138.0** (the `engines` floor) with `kratos.preview.renderer: vtkwasm`: the preview's CSP carries `'wasm-unsafe-eval'` and no `'unsafe-eval'`, the runtime loads from the webview's resource origin, the VTK-wasm backend (not the fallback) draws the mesh, and the console shows no CSP violation or error. |
| Parity catalog on VTK-wasm (`capture.mjs --renderer vtkwasm`) | All 34 scenes run with zero errors, warnings and CSP violations. |
| vtk.js unchanged | The 34-scene vtk.js catalog is still pixel-identical to the pre-refactor baseline after the bootstrap change; `run-checks.mjs` passes. |

**Carried into Phase 5** (not Phase 4 criteria, recorded so the G5 tolerances are set with them in view): against the vtk.js baseline, 14 of 34 scenes are within the proposed ≤ 2 % of pixels over 24/255, and every scene without annotations or dense edge overlays is (fields, glyphs, iso, threshold, spheres, beams, node labels: 0.4–1.5 %). The rest differ in three measured ways: **sub-pixel line rasterization of dense mesh edges** (the double arch's 63 k tetrahedra: 5–8 %, versus 0.56 % for the same scene with edges off), **annotation styling** (C++ annotated cube, cube axes and scalar bar — to be masked and checked functionally, as the plan already specifies), and the **translucency** case above. The unpicked-centre case of scene a40 is the picking boundary described above.

## Phase 5 — automated measurements (in progress)

**Performance** (`scripts/render-parity/perf.mjs`; Chromium + SwiftShader, 1400×900, a fresh browser per run, median of 3 runs; `out/vtk-wasm-eval/results/perf-timing.json`). The same operations on both backends over three fixtures: the double arch (63k tetrahedra) and synthetic hexahedral grids of 100k and 500k cells. vtk.js → VTK-wasm:

| Measure | Proposed budget | Double arch | 100k hex | 500k hex |
|---|---|---|---|---|
| Start-up | ≤ vtk.js + 2.0 s | 988 → 1465 ms | 1694 → 1882 ms | 4256 → 5020 ms |
| Model replacement | ≤ 1.5× | 316 → 292 ms | 717 → 693 ms | 3564 → 3550 ms |
| Frame time median / p95 (one camera change per animation frame, frame to frame) | p95 ≤ 1.5× on SwiftShader | 33.4 / 50.1 → 16.7 / 33.4 ms | 66.6 / 83.4 → 50.0 / 66.8 ms | 149.9 / 166.7 → 66.6 / 133.4 ms |
| CPU cost of one synchronous render call | — (reported) | 0.3 → 5.7 ms | 0.4 → 7.1 ms | 0.3 → 6.1 ms |
| Layer toggle | ≤ 50 ms | 0.6 → 4.3 ms | 0.7 → 4.7 ms | 0.7 → 5.5 ms |
| Inspect pick | ≤ 1.5× | 30.7 → 10.7 ms | 66.3 → 15.4 ms | 196 → 29.5 ms |

Every proposed budget is met on SwiftShader. The frame is faster on VTK-wasm at every size although each synchronous render call costs more CPU: vtk.js only enqueues WebGL commands in that call, while the C++ renderer's traversal is heavier per call and lighter per frame. None of this says anything about a real GPU — that is the checklist below.

**Memory** (renderer processes' RSS, Linux; one run). After load, vtk.js → VTK-wasm: 235 → 373 MB (arch), 351 → 444 MB (100k), 763 → 991 MB (500k) — +93 to +228 MB, inside the proposed +300 MB per panel. The GPU process is unchanged (~250 MB, SwiftShader). **Disposal plateau** (500k hex, 50 whole-model replacements, RSS every 10): VTK-wasm 990 → 1093, 924, 1057, 933, 868 MB — no growth, the swing being the wasm heap's high-water mark while old and new geometry coexist mid-swap; vtk.js 762 → 1091, 1125, 1073, 1211, 1458 MB, i.e. the existing backend is the one that grows. Handle-level disposal was already gated in G0.10 (VTK data-object memory back to baseline between cycles 10 and 50).

**Not yet measured:** the per-scene visual tolerance decision (see "Carried into Phase 5" above), the 400-sample picking-identity study against an exact ray cast, capture ordering under rapid scrubbing, and interrupted start-up (a model posted during boot is covered by the message queue; a failure mid-boot by the corrupt-wasm fallback check).

## G5 real-GPU checklist (needs a maintainer's machine)

Headless SwiftShader cannot show GPU behaviour, so these checks are run by hand in **desktop VS Code on a machine with a real GPU**, with `"kratos.preview.renderer": "vtkwasm"` in the user settings (reopen previews after changing it). Each item is compared against the same action with `"vtkjs"`; record pass/fail and anything odd.

1. **Start-up.** Open `example/MDPA/double_arch.mdpa`: the mesh appears with no "VTK-wasm renderer unavailable" line in the status bar, and in noticeably under two seconds more than with vtk.js.
2. **Interaction.** Orbit (left drag), pan (middle drag, and Pan mode), zoom (wheel, right drag) feel as smooth as vtk.js; the orientation cube follows; clicking a cube face snaps the view.
3. **Translucency.** View ▸ opacity at ~40 %: the mesh blends (not opaque, not black). Then Field ▸ Contour with opacity at 40 %: note whether the mesh edges show over the contour (the known difference is that they do not).
4. **Line widths and edges.** Edges on a dense mesh, Wire mode, and `example/MDPA/portal_frame.mdpa` (beams + ties): lines are visible and about as thick as with vtk.js.
5. **Text.** Advanced ▸ Grid on, Field ▸ Show scalar bar in scene, the orientation cube's labels: all readable, not blurred, on a HiDPI screen too.
6. **HiDPI picking.** On a display scaled 150–200 %: Inspect-click several elements and Measure between two nodes; the highlighted entity is the one under the pointer.
7. **Capture.** View ▸ Screenshot… and View ▸ Record… (a 5-frame PNG turntable and a WebM): files are non-blank and show the scene.
8. **Split view.** View ▸ Layout ▸ Quad: four independent cameras; clip in one pane only.
9. **Resource use.** Open three previews at once; the window stays responsive. Optionally note memory use per preview in the Process Explorer.

## Next

Phase 5: budgets and visual tolerances committed before measuring (with the Phase 4 findings above in view), the feature inventory, 400-sample picking identity against an exact ray cast rather than vtk.js, capture ordering, disposal cycles, large-mesh performance fixtures — and the real-GPU / desktop-Electron checklist, which needs a maintainer's machine.
