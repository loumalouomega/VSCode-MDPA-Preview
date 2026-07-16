# Kratos MDPA Preview (VS Code extension)

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/kratos-multiphysics.vscode-mdpa?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=kratos-multiphysics.vscode-mdpa)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/kratos-multiphysics.vscode-mdpa)](https://marketplace.visualstudio.com/items?itemName=kratos-multiphysics.vscode-mdpa)
[![GitHub Release](https://img.shields.io/github/v/release/loumalouomega/VSCode-MDPA-Preview)](https://github.com/loumalouomega/VSCode-MDPA-Preview/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)
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
| **Problemtype: build & run Kratos cases** | |
| ![The Problemtype section: solver forms, condition and material assignments on SubModelParts, and Generate / Run / Open results actions](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/problemtype.png) | |

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
- **Save / Load problem (zip)** — **File ▸ Save problem…** bundles the whole
  setup into a single portable zip: the original mesh file, the applied edit
  operations as a recipe, the problemtype case state
  (`<name>.kratoscase.json`) and the generated case files
  (`ProjectParameters.json`, the materials JSON, `MainKratos.py`,
  `<name>_case.mdpa`) — whichever exist. **File ▸ Load problem…** extracts such
  an archive into a folder of your choice, opens the mesh in the preview,
  **replays the bundled edits automatically** and restores the case setup —
  share a `.kratosproblem.zip` and the recipient gets the exact same problem.
  Also available as the **Save Problem (zip)… / Load Problem (zip)…** palette
  commands.
- **Editor integration**: `mdpa` language id with `//` comments, `Begin`/`End`
  folding, and syntax highlighting. The raw text editor stays the default; open
  the preview from the editor-title button, the explorer context menu, or the
  **Open MDPA Preview** command.
- **Problemtypes — build & run Kratos cases**: the **Problemtype** sidebar
  section generates everything a Kratos run needs from the previewed mesh:
  pick a problemtype (**Structural**, **Fluid**, **Convection-Diffusion**,
  **Potential Flow**, **Shallow Water** built in), fill the solver forms,
  assign conditions/loads and materials to SubModelParts, and **Generate case
  files** writes `ProjectParameters.json`, the materials JSON and
  `MainKratos.py` next to the `.mdpa`. Element/condition **block names are
  adapted to the solver** automatically: when the mesh's typology differs from
  what the chosen physics expects (e.g. `SmallDisplacementElement3D4N` for
  structural, generic `Element3D4N` for fluid), a renamed `<name>_case.mdpa`
  copy is generated and the case points at it — the original mesh stays
  untouched. Output always
  goes through Kratos' `vtk_output_process`, so **Run case** (an integrated
  terminal with the configured Kratos environment — pip-installed Kratos works
  with zero setup, and a **custom-compiled Kratos** is configured with the
  **Select Kratos Installation Folder…** command, which auto-detects a source
  checkout's `bin/Release` build) produces a `vtk_output/` folder the
  extension previews directly,
  timeline growing live as steps are written (**Open results**). The case
  setup auto-saves to `<name>.kratoscase.json` and is restored on reopen.
  Custom problemtypes are plain `.js` / `.py` files in
  `.kratos/problemtypes/` (Python runs in bundled Pyodide); faithful Python
  ports of the three built-ins ship as copyable examples in
  `example/problemtypes/`. See the
  [documentation site](https://loumalouomega.github.io/VSCode-MDPA-Preview/guide/simulation)
  for the user guide and the authoring API.
- **Flowgraph node editor (visual case setup)**: a sixth built-in problemtype,
  **Flowgraph (node editor)**, embeds the
  [Kratos Flowgraph](https://www.npmjs.com/package/@kratos-flowgraph/flowgraph)
  visual editor directly in the preview. Selecting it **splits the view in
  half** and opens Flowgraph in a resizable pane — **horizontal** (below the
  mesh) by default, toggleable to **vertical** (beside it) from the pane header
  or the `kratos.flowgraph.splitOrientation` setting. It runs as a bundled
  local server embedded in an iframe, so the full node editor works unchanged.
  The bridge is **two-way**: opening Flowgraph seeds the graph with the current
  case's `ProjectParameters.json`, and Flowgraph's **Generate** writes the
  resulting `ProjectParameters.json` back next to the `.mdpa`, ready for **Run
  case**. Flowgraph is AGPL-3.0 — see [License](#license).

## VTK / mesh file preview

The same viewer opens all common VTK-family and surface-mesh formats, plus ~26
more through meshio++:

| Format | Extensions | Notes |
|---|---|---|
| Legacy VTK | `.vtk` | ASCII **and** binary (big-endian) |
| VTK XML | `.vtu`, `.vtp`, `.vti`, `.vts`, `.vtr` | ascii, inline base64, appended raw/base64, zlib-compressed |
| VTK multiblock | `.vtm` | referenced blocks merge into one scene; each block becomes a layer |
| Surface meshes | `.stl` (ascii+binary), `.obj`, `.ply` (ascii+binary) | STL vertices are welded; PLY vertex properties become fields |
| Extended (meshio++) | `.msh` (Gmsh), `.inp` (Abaqus), `.bdf`/`.nas`/`.fem` (Nastran), `.unv`, `.mesh` (Medit), `.vol` (Netgen), `.su2`, `.xdmf`/`.xmf`, `.off`, `.dat`/`.tec` (Tecplot), `.avs`, `.f3grid`, `.pf3`, `.mfm`, `.mphtxt` (COMSOL), `.post`/`.dato` (PERMAS), `.ugrid`, `.wkt`, `.xml` (DOLFIN), `.node`/`.ele` (TetGen) | via [`@meshioplusplus/wasm`](https://www.npmjs.com/package/@meshioplusplus/wasm); 26 formats. Ambiguous extensions are resolved by content (`.msh` tries Gmsh then ANSYS/FreeFem; `.inp` tries Abaqus then ANSYS) |

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
and the VTK XML formats; `.stl`/`.obj`/`.ply` and the extended meshio++
formats always open as static views.

### Known limitations

- MPI rank > 0 files are not merged in this release (rank-0 files are loaded).
- Submodelpart merging uses coordinate matching (`toFixed(6)`); if the root and
  subpart files were written at different float precision the merge may miss nodes
  (a diagnostic is emitted in the sidebar stats).

## MCP server

The extension ships a standalone [MCP](https://modelcontextprotocol.io/) server
(`dist/mcpServer.js`) that exposes its mesh and simulation-setup engine to any
MCP client (Claude Code, Claude Desktop, …) — no VS Code needed. Build it once
with `npm run compile`, then register it, e.g. with Claude Code:

```bash
claude mcp add kratos-mdpa -- node /abs/path/to/VSCode-MDPA-Preview/dist/mcpServer.js
```

or in a generic client config:

```json
{ "mcpServers": { "kratos-mdpa": { "command": "node", "args": ["/abs/path/to/dist/mcpServer.js"] } } }
```

| Tool | What it does |
|------|--------------|
| `mesh_info` | Parse any supported mesh (`.mdpa`, VTK family, `.stl`/`.obj`/`.ply`, and the extended meshio++ formats) and summarize nodes, blocks, SubModelParts, fields, diagnostics. `inputFormat` forces a reader no extension defaults to (`ansys`, `freefem`, `ansysinp`) |
| `mesh_quality` | Geometric quality metrics (edge ratio, angles, gradation) with Kratos thresholds and worst-element ids |
| `mesh_transform` | Apply a sequence of mesh operations (scale/translate/rotate, merge nodes, remove orphans, linear→quadratic, delete/rename SubModelPart, MMG remesh & level-set split) inline or from a saved Edit-sidebar recipe |
| `mesh_convert` | Convert between formats — ours (`.mdpa`, `.vtk`, `.vtu`, `.vtp`, `.stl`, `.obj`, `.ply`) plus 26 written by meshio++ (`.msh`, `.inp`, `.bdf`, `.unv`, `.mesh`, `.vol`, `.su2`, `.xdmf`, `.off`, plus the field-only `.dex`/`.ip`/`.mff`, …). `inputFormat`/`outputFormat` override the extension defaults |
| `mesh_extract_submodelpart` | Slice one SubModelPart (+ subtree) into a standalone file |
| `mesh_find_entity` | Locate a node/element/condition/geometry by id (coordinates, connectivity, owning SubModelParts) |
| `problemtype_list` / `problemtype_describe` | Enumerate built-in + workspace problemtypes; get the full form/condition/material spec plus a default case skeleton |
| `case_validate` / `case_write_state` | Check a case setup against mesh + problemtype; write `<stem>.kratoscase.json` (picked up by the sidebar) |
| `case_generate` | Write ProjectParameters.json, the materials JSON and MainKratos.py next to the mesh — same output as the sidebar's Generate button, including solver mesh-name adaptation |
| `problem_pack` / `problem_unpack` | Bundle the whole problem (mesh + edit recipe + case state + generated case files) into one zip, or extract such an archive — the same format as the File menu's **Save problem… / Load problem…** |

MMG operations run in-process and block the server while they run; progress is
streamed as MCP log messages.

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
| `src/mcp/`, `src/mcpServer.ts` | Standalone stdio MCP server (tool handlers over the pure modules + SDK wiring) |
| `syntaxes/` | TextMate grammar for highlighting |

The Kratos name → VTK cell-type table mirrors the core
`kratos/input_output/vtk_definition.cpp` and `kratos/sources/kratos_application.cpp`.

## Third-party notices

Remeshing is powered by [MMG](https://www.mmgtools.org/) through the unmodified
[`@loumalouomega/mmg-wasm`](https://www.npmjs.com/package/@loumalouomega/mmg-wasm)
npm package (MMG v5.8.0 compiled to WebAssembly). MMG and mmg-wasm are licensed
under **LGPL-3.0-or-later** and are consumed as a replaceable package
dependency. If you use the remeshing features in academic work, please cite the
MMG papers.

The **Flowgraph node editor** is provided by the
[`@kratos-flowgraph/flowgraph`](https://www.npmjs.com/package/@kratos-flowgraph/flowgraph)
npm package, licensed under **AGPL-3.0-or-later**. Its assets are bundled and
served locally, embedded in the preview via an iframe. Because it is
distributed as part of this extension, the combined work is licensed under the
AGPL (see [License](#license)).

## License

This extension is licensed under the **GNU Affero General Public License,
version 3 or later (AGPL-3.0-or-later)** — see [LICENSE](LICENSE). It previously
shipped under MIT; the change is required because it now bundles the AGPL-3.0
Flowgraph editor, and an AGPL component makes the combined work AGPL.

Under the AGPL's network-use clause (§13), users who interact with the software
must be able to obtain its complete corresponding source. This is satisfied by
the public repository at
<https://github.com/loumalouomega/VSCode-MDPA-Preview>.

Extended mesh-format support (reading and writing ~26 further formats) comes
from [`@meshioplusplus/wasm`](https://www.npmjs.com/package/@meshioplusplus/wasm)
— meshio++'s C++ core compiled to WebAssembly, licensed **MIT** and shipped
verbatim under `dist/meshio/`.

Copyright © 2026 Vicente Mataix Ferrándiz and contributors.
