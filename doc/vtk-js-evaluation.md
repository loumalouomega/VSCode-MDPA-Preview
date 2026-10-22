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

# Increment F: lighting, appearance, colour, labels

Delivered, each with a Chromium check under `scripts/screenshots/`:

- **Colormap library** (`check-colormaps.mjs`): 27 curated ParaView presets (diverging, sequential, rainbow), resampled to 17 stops by `scripts/gen-colormap-presets.mjs` into `src/parser/colormapPresets.ts`, appended to the original 12 and offered through a searchable, category-grouped picker with a colour-blind-safe filter (`src/parser/colormapSearch.ts`). The colour-blind flag is hand-set from ColorBrewer's published ratings, not read from vtk.js. Legends, the scalar bar and the screenshot burn-in read the same `ColorStop[]`, so a preset reaches all of them.
- **Light modes** (`check-light-modes.mjs`): headlight (default), a scene light fixed in model space and a point light, with azimuth/elevation sliders in the Lighting panel (`src/parser/render/lightMode.ts`, `RView.setLight`, `caps.lightModes`). Returning to the headlight restores the original image exactly. VTK-wasm keeps its headlight (`lightModes: false`).
- **GPU-assisted node labels** (`check-gpu-labels.mjs`): the 1,000-node cap and the single-pane restriction are gone on vtk.js. Every node is projected per pane in typed arrays (`labelLayout.ts`, no per-point allocation), hidden nodes are culled against the depth buffer, a grid declutters the rest (at most 3,000 labels) and a pooled set of DOM labels is positioned; the work reruns only when a camera or rendered frame changed. On the 13,368-node `double_arch.mdpa`, 11,306 interior nodes are culled and 176 labels are drawn in one pane, 244 across four. The depth buffer comes from `PixelSpaceCallbackMapper` on a one-point probe actor: it is used only for the depth texels it hands back after the opaque pass (its own per-point callback allocates an array per point, so it is not used for projection). The cost is one full-framebuffer `readPixels` per render while Node IDs are on, which is why the probe is removed when they are turned off. Depth is 16-bit encoded, so culling is approximate (tolerance 2e-3 NDC). VTK-wasm keeps the capped path (`gpuLabels: false`).

Evaluated and not adopted:

- **Skybox / Texture / PBR** (decided from the vtk.js source, not a measured spike): PBR interpolation needs an environment texture, i.e. a shipped HDR/cube image (bundle size and an `img-src` policy change), and the capture path assumes a flat or transparent background that the screenshot, recorder and theme picker all rely on. A reflective environment also hurts an engineering view, where the point is to read geometry, not to look photographic. The flat scene-theme background stays.

# Increment C: interactive widgets

Delivered (`scripts/screenshots/check-widgets.mjs`):

- **Clip plane handle** — vtk.js `ImplicitPlaneWidget` behind `BackendCaps.widgets` / `RView.createPlaneWidget` (`webview/render/vtkjs/widgets.ts`). The handle is a view of `PaneClipState`: `src/parser/render/widgetMath.ts` maps a dragged plane back to the clip state (`clipFromPlane`: an X/Y/Z preset when it lands within 2° of an axis, Free otherwise, `t` clamped so a handle dragged outside the model parks on its face) and the clip state to the plane (`planeFromClip`, which `updateClipPlane` now uses too, so there is one source of truth). Slider, numeric normal and cap follow a drag through the same writers the slider uses. Measured: dragging the plane surface in the isometric view moved the slider from 30 % to 7 %, and moving the slider moves the handle. VTK-wasm keeps the slider only (`widgets: false`, with a reason).
- **Known limit, from vtk.js:** the widget drags the plane along its normal by projecting the pointer ray onto that line, and `projectDisplayToLine` returns nothing when the view direction is (almost) parallel to the line. Looking straight down the clip normal — the default view for a Z clip of a flat model — the handle cannot move along it; the slider still works. The check therefore switches to the isometric view first.
- **Measure angle** — Measure gains an Angle mode (three node picks, angle at the middle one, plus the a–b–c path length), computed by `angleAt` / `polylineLength` in `widgetMath.ts` (Node-tested) and drawn with the existing measure overlay layers.
- **Probe polyline** — after the first two picks open the Probe line panel, further node picks extend the polyline (`probePoints`/`probePointIds`, redrawn by `drawProbeLayers`); the host already samples a polyline by arclength, so no message changed.

Evaluated and not adopted:

- **LineWidget / AngleWidget / PolyLineWidget / LabelWidget** (decided from the source): they place their handles through a manipulator (a camera-facing plane, or `PickerManipulator`, which returns a surface point), not onto mesh nodes. Measure and the probe report node ids and use node coordinates, and the Inspect pick already resolves them; handles at arbitrary surface points would lose that. The native angle and polyline above keep the node snapping.
- **InteractiveOrientationWidget** as an alternative to the orientation cube: the cube already snaps to the six standard views, labels its faces and follows the focused pane, so replacing it would only lose behaviour.
