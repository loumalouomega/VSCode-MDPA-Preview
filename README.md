# Kratos MDPA Preview (VS Code extension)

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/kratos-multiphysics.vscode-mdpa?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=kratos-multiphysics.vscode-mdpa)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/kratos-multiphysics.vscode-mdpa)](https://marketplace.visualstudio.com/items?itemName=kratos-multiphysics.vscode-mdpa)
[![GitHub Release](https://img.shields.io/github/v/release/loumalouomega/VSCode-MDPA-Preview)](https://github.com/loumalouomega/VSCode-MDPA-Preview/releases)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/loumalouomega/VSCode-MDPA-Preview/package.yml?label=build)](https://github.com/loumalouomega/VSCode-MDPA-Preview/actions)
[![Documentation](https://img.shields.io/badge/docs-online-brightgreen)](https://loumalouomega.github.io/VSCode-MDPA-Preview/)

📖 **[Read the full documentation »](https://loumalouomega.github.io/VSCode-MDPA-Preview/)**

![The MDPA preview: 3D mesh, ModelPart / SubModelPart outline, stats, and toolbar](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/preview-overview.png)

Preview, organize, edit, and remesh Kratos Multiphysics `.mdpa` model-part files
directly in VS Code: a 3D mesh viewer with a navigable **ModelPart /
SubModelPart outline** whose entries are **toggleable layers**.

It is fully self-contained — a pure-TypeScript parser feeds a
[VTK.js](https://kitware.github.io/vtk-js/) viewer running in a webview. **No
Python or compiled Kratos is required.**

| Mesh quality | Field contour |
|---|---|
| ![Mesh quality panel](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/quality-panel.png) | ![Field contour](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/field-contour.png) |
| **Level-set split (MMG)** | **Linear → Quadratic** |
| ![Level-set split](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/levelset-split.png) | ![Quadratic mid-nodes](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/meshmod-quadratic.png) |

> 📖 See the [full documentation](https://loumalouomega.github.io/VSCode-MDPA-Preview/)
> for a screenshot-rich walkthrough of every feature.

## Features

- **3D preview** of nodes, elements, conditions, and geometries. Volume
  elements (tet/hex/wedge/pyramid) are shown as their boundary surface;
  quadratic elements are approximated by their corner nodes.
- **Outline tree** of the entity blocks and the full SubModelPart hierarchy,
  with per-row visibility checkboxes (activate/deactivate a layer) and
  click-to-frame. Drag the divider between the sidebar and the 3D view to resize
  the sidebar.
- **SubModelParts as layers** — each SubModelPart is an independently toggleable
  overlay so you can isolate inlets/outlets/boundaries.
- **Stats panel**: node/element/condition/geometry counts, bounding box,
  detected 2D/3D, and any element type names that could not be mapped.
- **Mesh quality** (`Quality` toolbar button / **Compute Mesh Quality**
  command): purely geometric metrics inspired by Kratos'
  `ComputeMeshQualityProcess` — aspect/edge ratio, min/max angle (dihedral for
  volume cells, interior corner angles for surface cells), and per-node size
  gradation. Results are shown in a panel with per-metric histograms, a
  Good/Acceptable/Bad/Unacceptable breakdown, and an overall verdict. Bad
  elements can be highlighted in red and framed in the 3D view.
- **Field visualization** (`Field` toolbar button / **Field Visualization**
  command): plot the `NodalData`, `ElementalData`, and `ConditionalData` fields
  stored in the file. Pick a variable and one of three modes:
  - **Contour** — color the mesh by a scalar (smooth point-data for nodal
    fields, flat per-cell for elemental/conditional). Vector fields are colored
    by magnitude.
  - **Quiver** — arrow glyphs oriented and scaled by a vector field (at nodes,
    or at cell centroids for elemental/conditional data), colored by magnitude,
    with an adjustable arrow-scale slider.
  - **Isosurface** — extract the surface where a scalar equals a slider-driven
    iso value (marching tetrahedra over volume cells; 2D / surface meshes fall
    back to iso-lines).

  A colormap dropdown (Rainbow/jet by default, plus Viridis, Cool-warm, and
  Grayscale) drives both the 3D coloring and a live legend.
- **Screenshot** (`📷` toolbar button): captures the current viewport as a PNG and opens a
  Save dialog pre-filled with the source file's name (e.g. `mesh.png` next to `mesh.mdpa`).
  Uses VTK.js's `captureNextImage()` for correct WebGL swap-chain timing. SVG export is not
  possible — the viewport is a rasterised WebGL canvas.
- **Find entity by ID** (`Find` toolbar button / **Find Entity by ID** command):
  type a Node, Element, Condition, or Geometry ID to locate it instantly. The
  entity is highlighted in yellow and the camera zooms to it; all other layers
  switch to wireframe so the result stands out clearly. Closing the bar restores
  the previous display state.
- **Orientation cube + axis arrows** — an always-visible labeled cube in the
  bottom-left corner of the viewport (RIGHT / LEFT / TOP / BOTTOM / FRONT /
  REAR) that follows the camera as you orbit. Prominent X (red), Y (green),
  and Z (blue) axis arrows with letter labels radiate from the cube. Clicking
  a face snaps the camera to that canonical axis direction.
- **Navigation controls** — a compact on-screen panel that appears once a
  model loads, positioned next to the orientation cube:
  - **Rotate** compass — four arrow buttons orbit the camera by ±15°
    (azimuth / elevation); press-and-hold for continuous rotation.
  - **Pan** compass — four arrow buttons translate the camera plane (step
    proportional to the current zoom level).
  - **Zoom** — `+` / `−` buttons dolly the camera (×1.25 / ×0.8); press-and-hold
    for continuous zoom.
  - **Fit** — frames all visible geometry (same as the **Reset Camera** command).
  - **Center** — re-centers the focal point on the visible model bounds without
    changing the orbit angle or zoom.
- **Background grid** (`Grid` toolbar button) — toggles a `CubeAxesActor`
  bounding box with labeled X/Y/Z axes and tick marks around the mesh. Colors
  adapt to the active scene theme.
- **Mesh modification** — the **Mesh Modification** sidebar section hosts in-place
  operations on the loaded mesh. **Convert Linear → Quadratic** inserts mid-edge
  nodes to raise every linear cell to its quadratic ("serendipity") counterpart —
  Triangle2D3→Triangle2D6, Quadrilateral2D4→Quadrilateral2D8, Tetrahedra3D4→
  Tetrahedra3D10, Hexahedra3D8→Hexahedra3D20, Prism3D6→Prism3D15,
  Pyramid3D5→Pyramid3D13, Line2→Line3. Adjacent cells that share an edge get a
  single welded mid-edge node, nodal fields are interpolated at the new nodes, and
  SubModelParts are extended. The newly inserted mid-edge nodes are shown as a
  semitransparent **Quadratic mid-nodes** point overlay (a toggleable layer) so you
  can see exactly what was added. The preview updates in place; save or export the
  modified mesh from the **File** menu.
- **Remeshing (MMG)** — the Mesh Modification section embeds the
  [MMG](https://www.mmgtools.org/) remeshers via
  [`@loumalouomega/mmg-wasm`](https://www.npmjs.com/package/@loumalouomega/mmg-wasm)
  (WebAssembly — no native binaries). **Remesh (MMG)** adapts the whole mesh with
  three modes: **size × factor** (per-node metric = local edge size × your factor,
  the one-knob refine/coarsen), **uniform** target size (`hsiz`), and
  **optimize only** (size-preserving quality pass). The **Advanced** block exposes
  the MMG tuning surface — `hmin`/`hmax` size bounds, `hausd` Hausdorff distance,
  `hgrad` gradation, sharp-angle detection threshold, `keep surface` / `no insert` /
  `no swap` / `no move` toggles, and a module override (auto-detected otherwise:
  tetrahedral volumes → **mmg3d**, non-planar triangulated surfaces → **mmgs**,
  planar triangulations → **mmg2d**). **Level-set split (MMG)** discretizes an
  isovalue of any nodal field as an explicit, conforming boundary — pick the field
  and isovalue and the mesh is split into `MMG_Domain_Inside` / `MMG_Domain_Outside`
  with an `MMG_Interface` boundary layer, each also generated as a **SubModelPart**
  of the same name (exportable/deletable from the outline, saved as real
  `Begin SubModelPart` blocks). Level-set has its own **Advanced** block with the
  same `hmin`/`hmax`/`hausd`/`hgrad`/module controls as Remesh, for manually
  tuning the split (e.g. a tighter `hausd` for a sharper interface) when the
  automatic defaults aren't right. Element blocks **and SubModelParts
  survive remeshing** (each cell is tagged with its block + SubModelPart signature
  as an MMG reference and regrouped afterwards); nodal/elemental data cannot follow
  a remesh and is dropped with a warning. Hexahedral, pyramid and quadratic meshes
  are not remeshable (MMG is tet/triangle-based). Remeshes join the same operation
  history — undo is instant (the result is snapshotted), and remesh steps in a
  saved JSON recipe re-run MMG deterministically when replayed. MMG runs in a
  **worker thread**, so the editor stays responsive; while it runs, an **inline
  loading bar under the form streams MMG's live phase output** (analysis,
  meshing, split/collapse/swap counters) and the form's **play button becomes a
  stop button** that cancels the run immediately, leaving the mesh unchanged.
- **Editing & operation history** — the **Edit** sidebar section records every
  applied edit and mesh modification into an undoable history: **undo / redo /
  clear** plus a clickable list of operations (click any step to **partially revert**
  to it). Edit operations are driven by **interactive controls in the sidebar**:
  **remove orphan nodes**, **merge coincident nodes** (tolerance), and separate
  **scale**, **translate**, and **rotate** transforms (values entered inline).
  **Deleting a SubModelPart** is done from its **✕ button in the outline tree**.
  Every edit and mesh modification joins the same history, and the applied
  operations can be **saved to / loaded from a JSON recipe** and replayed on the
  mesh (`Save operations…` / `Load operations…`).
- **Editor integration**: `mdpa` language id with `//` comments, `Begin`/`End`
  folding, and syntax highlighting. The raw text editor stays the default; open
  the preview from the editor-title button, the explorer context menu, or the
  **Open MDPA Preview** command.

## VTK / mesh file preview

The same viewer opens all common VTK-family and surface-mesh formats:

| Format | Extensions | Notes |
|---|---|---|
| Legacy VTK | `.vtk` | ASCII **and** binary (big-endian) |
| VTK XML | `.vtu`, `.vtp`, `.vti`, `.vts`, `.vtr` | ascii, inline base64, appended raw/base64, zlib-compressed |
| VTK multiblock | `.vtm` | referenced blocks merge into one scene; each block becomes a layer |
| Surface meshes | `.stl` (ascii+binary), `.obj`, `.ply` (ascii+binary) | STL vertices are welded; PLY vertex properties become fields |

Kratos writes one VTK file per model-part per time step
(e.g. `Main_0_2.vtk`, `Main_FixedEdgeNodes_0_4.vtk`). Open any `.vtk` (or VTK
XML) file in the explorer — the extension detects the Kratos naming pattern
`<prefix>_<rank>_<step>.<ext>` and loads the full time series automatically.
Point/cell data arrays from any format appear in the **Field** panel; mesh
quality, find-by-ID, and screenshots work everywhere.

### Submodelpart tree

The sidebar shows the same layer tree as the MDPA preview. The root model-part
file provides the full mesh; each submodelpart file (e.g. `FixedEdgeNodes`,
`MovingNodes`) appears as a hidden-by-default overlay layer that you can toggle
independently. Point-cloud submodelparts (node-only files) are rendered as
vertex cells.

### Timeline animation

When multiple time steps are found in the directory, a timeline bar appears at
the bottom of the viewport:

```
◀  ▶  ▶▶  ══════●══════════  Step 4  (2/3)  2 fps
```

- **◀ / ▶▶** step backward / forward one frame
- **▶ / ⏸** play / pause (at the configured fps rate)
- **Scrubber** — drag to jump to any step instantly
- **fps** input — controls playback speed (1–30 fps)

Camera position, layer visibility, active field variable, and colormap are all
preserved when switching frames. A single file with no timestep siblings opens
as a static preview with no timeline bar. Time-series grouping covers `.vtk`
and the VTK XML formats; `.stl`/`.obj`/`.ply` always open as static views.

### Known limitations

- MPI rank > 0 files are not merged in this release (rank-0 files are loaded).
- Submodelpart merging uses coordinate matching (`toFixed(6)`); if the root and
  subpart files were written at different float precision the merge may miss nodes
  (a diagnostic is emitted in the sidebar stats).

## Develop

```bash
npm install
npm run compile      # bundle extension (dist/) and webview (media/) via esbuild
npm run watch        # rebuild on change
npm test             # parser unit tests (node:test) against repo fixtures
npm run typecheck    # tsc --noEmit
```

Press **F5** in VS Code to launch an Extension Development Host, then open any
`.mdpa` file (e.g. those under `applications/*/tests/`).

## Layout

| Path | Purpose |
|------|---------|
| `src/extension.ts` | Activation, command + custom-editor registration |
| `src/mdpaEditorProvider.ts` | Custom editor for `.mdpa`: parses the document, hosts the webview |
| `src/vtkEditorProvider.ts` | Custom editor for VTK/mesh files: discovers sibling files, manages timeline, merges subparts |
| `src/parser/` | `mdpaParser`, `meshFileParser` (format dispatcher), `vtkLegacyParser` (ASCII+binary legacy VTK), `vtkXmlCore`/`vtkXmlParser` (VTK XML), `vtkMultiblock` (.vtm), `stlParser`, `objParser`, `plyParser`, `vtkFileGroup` (filename grammar → timeline tree), `geometryMap`, `meshQuality`, `isoSurface`, `types` |
| `webview/` | `main.ts` (VTK scene), `meshBuilder.ts`, `outline.ts`, `timeline.ts` (VTK playback bar), `qualityPanel.ts`, `fieldPanel.ts`, `fieldData.ts`, `fieldRender.ts`, `quiver.ts`, `colormaps.ts`, `orientationCube.ts` (cube + axis arrows), `navControls.ts` (orbit/pan/zoom/fit/center panel), `gridAxes.ts`, `style.css` |
| `syntaxes/` | TextMate grammar for highlighting |

The Kratos name → VTK cell-type table mirrors the core
`kratos/input_output/vtk_definition.cpp` and `kratos/sources/kratos_application.cpp`.

## Third-party notices

Remeshing is powered by [MMG](https://www.mmgtools.org/) through the unmodified
[`@loumalouomega/mmg-wasm`](https://www.npmjs.com/package/@loumalouomega/mmg-wasm)
npm package (MMG v5.8.0 compiled to WebAssembly). MMG and mmg-wasm are licensed
under **LGPL-3.0-or-later**; the extension itself remains MIT and consumes the
library as a replaceable package dependency. If you use the remeshing features in
academic work, please cite the MMG papers.
