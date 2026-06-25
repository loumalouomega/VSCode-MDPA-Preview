# Kratos MDPA Preview (VS Code extension)

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
- **Editor integration**: `mdpa` language id with `//` comments, `Begin`/`End`
  folding, and syntax highlighting. The raw text editor stays the default; open
  the preview from the editor-title button, the explorer context menu, or the
  **Open MDPA Preview** command.

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
| `src/mdpaEditorProvider.ts` | Custom editor: parses the document, hosts the webview |
| `src/parser/` | `mdpaParser`, `geometryMap` (Kratos name → VTK cell), `meshQuality`, `isoSurface`, `types` |
| `webview/` | `main.ts` (VTK scene), `meshBuilder.ts`, `outline.ts`, `qualityPanel.ts`, `fieldPanel.ts`, `fieldData.ts`, `fieldRender.ts`, `quiver.ts`, `colormaps.ts`, `style.css` |
| `syntaxes/` | TextMate grammar for highlighting |

The Kratos name → VTK cell-type table mirrors the core
`kratos/input_output/vtk_definition.cpp` and `kratos/sources/kratos_application.cpp`.
