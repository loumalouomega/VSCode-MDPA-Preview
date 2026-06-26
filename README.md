# Kratos MDPA Preview (VS Code extension)

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/kratos-multiphysics.vscode-mdpa?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=kratos-multiphysics.vscode-mdpa)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/kratos-multiphysics.vscode-mdpa)](https://marketplace.visualstudio.com/items?itemName=kratos-multiphysics.vscode-mdpa)
[![GitHub Release](https://img.shields.io/github/v/release/loumalouomega/VSCode-MDPA-Preview)](https://github.com/loumalouomega/VSCode-MDPA-Preview/releases)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/loumalouomega/VSCode-MDPA-Preview/package.yml?label=build)](https://github.com/loumalouomega/VSCode-MDPA-Preview/actions)

![](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/mdpa_preview.png)

Preview, organize, and manage Kratos Multiphysics `.mdpa` model-part files
directly in VS Code: a 3D mesh viewer with a navigable **ModelPart /
SubModelPart outline** whose entries are **toggleable layers**.

It is fully self-contained — a pure-TypeScript MDPA parser feeds a
[VTK.js](https://kitware.github.io/vtk-js/) viewer running in a webview. **No
Python or compiled Kratos is required.**

## Features

- **3D preview** of nodes, elements, conditions, and geometries. Volume
  elements (tet/hex/wedge/pyramid) are shown as their boundary surface;
  quadratic elements are approximated by their corner nodes.
- **Outline tree** of the entity blocks and the full SubModelPart hierarchy,
  with per-row visibility checkboxes (activate/deactivate a layer) and
  click-to-frame.
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
- **Editor integration**: `mdpa` language id with `//` comments, `Begin`/`End`
  folding, and syntax highlighting. The raw text editor stays the default; open
  the preview from the editor-title button, the explorer context menu, or the
  **Open MDPA Preview** command.

## Kratos VTK output preview

Kratos also writes one legacy ASCII VTK file per model-part per time step
(e.g. `Main_0_2.vtk`, `Main_FixedEdgeNodes_0_4.vtk`). Open any `.vtk` file
in the explorer — the extension detects the Kratos naming pattern and loads the
full time series automatically.

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
preserved when switching frames. A single `.vtk` file with no timestep siblings
opens as a static preview with no timeline bar.

### Known limitations

- ASCII VTK only (binary VTK emits a diagnostic and shows an empty scene).
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
| `src/vtkEditorProvider.ts` | Custom editor for `.vtk`: discovers sibling files, manages timeline, merges subparts |
| `src/parser/` | `mdpaParser`, `vtkLegacyParser` (ASCII VTK → MdpaModel), `vtkFileGroup` (filename grammar → timeline tree), `geometryMap`, `meshQuality`, `isoSurface`, `types` |
| `webview/` | `main.ts` (VTK scene), `meshBuilder.ts`, `outline.ts`, `timeline.ts` (VTK playback bar), `qualityPanel.ts`, `fieldPanel.ts`, `fieldData.ts`, `fieldRender.ts`, `quiver.ts`, `colormaps.ts`, `orientationCube.ts` (cube + axis arrows), `navControls.ts` (orbit/pan/zoom/fit/center panel), `gridAxes.ts`, `style.css` |
| `syntaxes/` | TextMate grammar for highlighting |

The Kratos name → VTK cell-type table mirrors the core
`kratos/input_output/vtk_definition.cpp` and `kratos/sources/kratos_application.cpp`.
