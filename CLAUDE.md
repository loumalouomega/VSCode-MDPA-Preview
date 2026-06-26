# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile        # dev build (includes source maps)
npm run package        # production build (minified, no source maps)
npm run typecheck      # type-check only — never use tsc to emit shipped code
npm test               # compile tests then run with Node's built-in test runner
npm run install-ext    # build + copy into ~/.vscode-server/extensions/ (bash install.sh)
```

**esbuild owns all emit** — `tsc` is only for type-checking and test compilation. Do not run `tsc` to build the extension.

To run a single test file:
```bash
npm run build:tests && node --test out/test/mdpaParser.test.js
```

## Architecture

The extension has two completely separate runtimes that communicate only via `postMessage`:

### Extension host (Node.js, `src/`)
- `extension.ts` — registers the custom editor (`kratos.mdpaPreview`) and six commands.
- `mdpaEditorProvider.ts` — resolves custom editors: parses the document text, serves the webview HTML, and re-parses on change (debounced 250 ms). Tracks the active panel so window-level commands (`resetCamera`, `toggleNodeIds`, `computeQuality`, `fieldVisualization`, `findEntity`) can reach it.
- `src/parser/mdpaParser.ts` — tolerant line-oriented state-machine. Uses a `stack: Frame[]` to handle nested `Begin`/`End` blocks. Merges repeated `Begin Elements <Name>` blocks into one `EntityBlock` so split files form a single layer. Parses `Begin NodalData`/`ElementalData`/`ConditionalData <VAR>` blocks into `FieldData` (scalar `id [is_fixed] value`, vector `id [N] (v1,…)`; flag-only nodal lines become value 1) while still recording the meta line-count. Emits non-fatal `MdpaDiagnostic` entries rather than throwing.
- `src/parser/geometryMap.ts` — maps Kratos type names (e.g. `Element2D3N`, `Triangle2D3`) to VTK cell type ids. Primary lookup: `(dimension, nodeCount)`; fallback: `(family-word, nodeCount)`. The table mirrors `kratos/input_output/vtk_definition.cpp`.
- `src/parser/types.ts` — the shared data model (`MdpaModel`, `EntityBlock`, `SubModelPart`, `FieldData`, etc.). Intentionally free of `vscode` and DOM imports so it can be used in both runtimes and in plain Node tests.
- `src/parser/meshQuality.ts` — pure (no `vscode`/DOM/vtk) geometric mesh-quality metrics inspired by Kratos' `ComputeMeshQualityProcess`: aspect/edge ratio, min/max angle (dihedral for volume cells, interior corner angles for surface cells), and per-node size gradation. Classifies every element into good/acceptable/bad/unacceptable bands (thresholds mirror the Kratos defaults) and returns per-metric histograms + the ids of bad elements. BC/flag-dependent checks (dead-tetra, gap/hole detection) are intentionally omitted — undefinable for a purely geometric mesh. Re-declares the small face tables locally rather than importing `meshBuilder` (which pulls in vtk.js) so it stays Node-testable. Unit tests: `src/test/meshQuality.test.ts`.
- `src/parser/isoSurface.ts` — pure (no `vscode`/DOM/vtk) scalar isosurface extraction (vtk.js has no unstructured-grid contour). Decomposes each volume cell into tetrahedra (tet→1, pyramid→2, wedge→3, hex→6) and runs sign-based marching tetrahedra; 2D / surface-only meshes fall back to marching triangles, yielding iso-lines (`is2D: true`). Crossing points weld across cells via an unordered node-id edge key. Returns plain typed arrays (`points`, `triangles`, `lines`). Unit tests: `src/test/isoSurface.test.ts`.

### Webview (browser IIFE, `webview/`)
- `webview/main.ts` — entry point. Owns the VTK.js scene. On receiving a `model` message it calls `buildScene()`, which creates one `vtkActor` layer per `EntityBlock` (visible) and one per `SubModelPart` (hidden by default). Node-id labels are capped at 1 000 nodes. The `Quality` toolbar button / `computeQuality` message runs `computeMeshQuality` and toggles the quality panel; "Highlight bad" builds a red overlay layer (`quality:highlight`) from a metric's bad-element ids by reusing `addLayer`/`buildPolyData`. The `Field` toolbar button / `field` message toggles the field panel (see below). The `Find` toolbar button / `locateEntity` message opens a search bar: the matched entity is highlighted in yellow (`find:highlight` layer) and all other layers are forced to wireframe for contrast; closing the bar restores the prior wireframe state. Module-scope maps `elementById`, `conditionById`, `geometryById` are populated in `buildScene()` and shared by the quality panel, the find feature, and quiver cell-centroids.
- `webview/meshBuilder.ts` — converts `MdpaModel` nodes + `Cell[]` into `vtkPolyData`. Handles point clouds (no cell type) as vertex cells. Optionally takes a `FieldAttach`: nodal scalars are pushed into the point-data array *inside* `localOf` as each local point is born (so they stay aligned with the local remap), and cell scalars are collected per emitted cell in VTK's verts→lines→polys order — volume boundary faces inherit their owning cell's value via a face-owner map.
- `webview/outline.ts` — renders the sidebar tree of checkboxes (toggle layer visibility) and labels (frame/zoom to layer).
- `webview/qualityPanel.ts` — renders the `QualityReport` as a floating panel: verdict header + one card per metric with a min/mean/max line, a stacked band bar, and a canvas histogram. Pure DOM + Canvas 2D (no charting lib; the CSP forbids CDN scripts).
- Field visualization (toggled by the `Field` button) lives in five modules. `webview/fieldData.ts` turns a `FieldData` into id→value lookups + scalar/magnitude range (`buildFieldInfo`, `scalarAt`, `vectorAt`). `webview/colormaps.ts` is the colormap registry (Rainbow/jet default, Viridis, Cool-warm, Grayscale) as RGB stops feeding both the vtk `ColorTransferFunction` and the DOM legend gradient. `webview/fieldRender.ts` wires scalar coloring onto a mapper and builds isosurface polydata. `webview/quiver.ts` builds an arrow-glyph actor (`vtkGlyph3DMapper` + `vtkArrowSource`) oriented/scaled by the vector array and colored by magnitude. `webview/fieldPanel.ts` is the floating panel (variable + mode selectors, colormap dropdown + legend, iso-value / arrow-scale sliders). `main.ts` owns the `field:contour` / `field:quiver` / `field:iso` overlay layers and dims base layers to wireframe while a field is shown; the iso slider rebuilds via a `requestAnimationFrame` debounce.
- `webview/orientationCube.ts` — sets up a `vtkAnnotatedCubeActor` (Kratos face labels: RIGHT/LEFT/TOP/BOTTOM/FRONT/REAR) inside a `vtkOrientationMarkerWidget` in the bottom-left corner. Always visible. A capture-phase `pointerdown` listener on the WebGL canvas intercepts clicks within the widget viewport, runs `vtkCellPicker` against the widget's own renderer, reads `getMapperNormal()` from the hit face, and snaps the main camera to that axis direction.
- `webview/gridAxes.ts` — wraps `vtkCubeAxesActor` (with the OpenGL backend explicitly imported for registration). Exposes `setVisible`, `updateBounds`, and `updateTheme`. Updated by `buildScene()` whenever a new model loads; toggled by the `Grid` toolbar button. Axis/tick label colours adapt to dark vs. light/scientific themes via `setAxisTextStyle` / `setTickTextStyle`.

### Build outputs
| Path | Contents |
|---|---|
| `dist/extension.js` | Extension host bundle (CJS, Node 18 target) |
| `media/webview.js` | Webview bundle (IIFE, ES2021, browser) |
| `media/style.css` | Copied from `webview/style.css` by esbuild plugin |

`media/` is the only allowed `localResourceRoots` for the webview.

### Message protocol (extension host ↔ webview)

| Direction | `type` | Payload |
|---|---|---|
| host → webview | `model` | `{ model: MdpaModel, fileName: string }` |
| host → webview | `error` | `{ message: string }` |
| host → webview | `resetCamera` | — |
| host → webview | `toggleNodeIds` | — |
| host → webview | `computeQuality` | — (toggles the mesh-quality panel) |
| host → webview | `field` | — (toggles the field-visualization panel) |
| host → webview | `locateEntity` | `{ entityType: "Node"\|"Element"\|"Condition"\|"Geometry", entityId: number }` |
| webview → host | `ready` | — (triggers initial parse) |
| webview → host | `setTheme` | `{ theme: string }` (persisted in globalState) |

### Packaging & CI
- `.github/workflows/package.yml` builds a `.vsix` on every `v*` tag push and creates a GitHub Release with it attached. Uses `./node_modules/.bin/vsce` (not `npx vsce`) to ensure the `@vscode/vsce` version from `devDependencies` is used.
- `vscode:prepublish` runs the production esbuild before `vsce package`.
