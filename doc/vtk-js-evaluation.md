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
