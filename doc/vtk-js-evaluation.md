# vtk.js capability evaluations (roadmap item 22, increment G)

Measured verdicts for the vtk.js 37.4.3 modules that were evaluated rather than built, in the manner of the [VTK-wasm spike](./vtk-wasm-spike.md). Environment: headless Chromium with SwiftShader (`/opt/pw-browsers`), the same setup as the screenshot harness; nothing here was run on a real GPU or inside a VS Code webview, so each verdict says what it rests on.

## WebGPU (`Rendering/WebGPU`)

- **Availability.** `navigator.gpu` exists only in a secure context (an `about:blank` or `file://` page has none; an `http://localhost` page does). With no flag, `requestAdapter()` returned `null`; with `--enable-unsafe-webgpu --enable-features=Vulkan` it returned a SwiftShader adapter. A VS Code webview is a secure context, so availability there depends on the shipped Electron enabling WebGPU on the user's GPU and platform — not measured here.
- **Parity.** The package has WebGPU counterparts for the mappers this extension draws (`PolyDataMapper`, `Glyph3DMapper`, `SphereMapper`, `StickMapper`, hardware selection, volume), **but none of the WebGPU poly-data mappers references a clipping plane** (`grep -c "clippingPlane|ClippingPlane"` over `PolyDataMapper.js` and `SphereMapper.js` returns 0). The Clip dock, the per-pane clip planes and the Clip export all rest on `addClippingPlane`, so a WebGPU backend would lose a core feature, and each pane's mapper-level plane has no WebGPU equivalent.
- **Verdict: not adopted.** Revisit only if upstream adds mapper clipping planes; the renderer boundary already isolates the choice (`BackendCaps`), so a third backend would be additive.

## WebXR (`Rendering/WebXR/RenderWindowHelper`)

- `navigator.xr` exists in headless Chromium but `isSessionSupported("immersive-vr")` is `false`. A VS Code webview is a sandboxed iframe whose permissions policy does not grant `xr-spatial-tracking`, so the immersive session cannot start there either way.
- **Verdict: dropped.** No viewer use case justifies fighting that policy.

## SurfaceLIC (`Rendering/Core/SurfaceLICMapper`, `Rendering/Core/SurfaceLICInterface`)

- The prerequisites hold in this environment: WebGL2 reports `EXT_color_buffer_float` and `OES_texture_float_linear`.
- It was **not integrated or compared pixel for pixel** against `streamlines.ts`. The module is a surface-only texture technique: it paints a dense per-pixel flow texture, whereas the existing streamlines are exportable line geometry that also works in a volume and writes `STREAM_*` fields, so LIC would be a display complement and never a replacement.
- **Verdict: deferred, not rejected.** Adopt only if a request for a dense surface vector-field view appears; nothing is blocked by leaving it.

## ImageCPRMapper

- A curved reformat needs a centerline and an image volume. The extension has no workflow that produces either for a beam or pipe (beams are line cells with a section, not volumes).
- **Verdict: dropped** until such a use case exists.

## PolyDataSerializer

- **Does not exist in the 37.4.3 package** (no `IO/Geometry/PolyDataSerializer`, no serializer module under `IO/`). Nothing to evaluate.
- **Verdict: dropped.** Scene export stays with the existing writers and the problem archive.

# Increment E: display-only geometry filters

Delivered: the Lighting panel's **Smooth shading** (vtk.js `PolyDataNormals`, `PropStyle.smoothShading`, `BackendCaps.displayFilters`) and **scalar relief** (a nodal scalar can be picked in the Deformed mode's "Deform by" selector and lifts the mesh along +Z; this is the `WarpScalar` idea, done in `computeWarpedGeometry` because the warp is two lines and the result must flow into every overlay like the vector warp does). Checked by `scripts/screenshots/check-display-filters.mjs`.

- **PolyDataNormals** has no feature angle and no splitting: it averages the unit normals of every cell at a point. It is right for curved surfaces and visibly wrong on the hard edges of a boxy mesh, so the checkbox is off by default and says so in its tooltip. A feature-angle version would need point duplication in `displayGeometry.ts` and is not built.
- **WindowedSincPolyDataFilter** was not adopted: it moves points, so it would change what the viewer shows relative to the mesh being edited, which this item's rule forbids ("a display representation never replaces exported or edited geometry"). Smoothing the mesh itself is the `smooth` operation.
- **TubeFilter vs `streamlineTubes.ts`** (1,000 polylines of 100 points, 8 sides, Node): vtk.js 242 ms, ours 83 ms, both 800,000 points; ours also carries speed as point scalars and emits quads, so it is not replaced.
- **ClipClosedSurface** clips a *closed* surface and runs on the CPU like `computePlaneCut`, so it is not a GPU cap; the displayed layers are open boundary skins per block, so it has no closed surface to work on. The CPU section cap stays.
- **Calculator / ThresholdPoints**: not benchmarked and not adopted. The native `fieldCalc` and `thresholdCells` are shared with recipes and MCP, so a second evaluator would only add a way for the two to disagree.
