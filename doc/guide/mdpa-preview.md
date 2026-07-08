# MDPA Preview

Opening an `.mdpa` file in the preview gives you a 3D mesh viewer with a
navigable **ModelPart / SubModelPart outline** whose entries are toggleable
layers.

![Kratos MDPA Preview](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/mdpa_preview.png)

## Core view

- **3D preview** of nodes, elements, conditions, and geometries. Volume
  elements (tet/hex/wedge/pyramid) are shown as their boundary surface;
  quadratic elements are approximated by their corner nodes.
- **Outline tree** of the entity blocks and the full SubModelPart hierarchy,
  with per-row visibility checkboxes (activate/deactivate a layer) and
  click-to-frame. Drag the divider between the sidebar and the 3D view to resize
  the sidebar.
- **SubModelParts as layers** — each SubModelPart is an independently toggleable
  overlay so you can isolate inlets/outlets/boundaries.
- **Stats panel** — node/element/condition/geometry counts, bounding box,
  detected 2D/3D, and any element type names that could not be mapped.

## Mesh quality

The **Quality** toolbar button (or the **Compute Mesh Quality** command) runs
purely geometric metrics inspired by Kratos' `ComputeMeshQualityProcess`:

- aspect / edge ratio,
- min / max angle (dihedral for volume cells, interior corner angles for surface
  cells), and
- per-node size gradation.

Results appear in a panel with per-metric histograms, a
Good / Acceptable / Bad / Unacceptable breakdown, and an overall verdict. Bad
elements can be highlighted in red and framed in the 3D view.

## Field visualization

The **Field** toolbar button (or the **Field Visualization** command) plots the
`NodalData`, `ElementalData`, and `ConditionalData` fields stored in the file.
Pick a variable and one of three modes:

- **Contour** — color the mesh by a scalar (smooth point-data for nodal fields,
  flat per-cell for elemental/conditional). Vector fields are colored by
  magnitude.
- **Quiver** — arrow glyphs oriented and scaled by a vector field (at nodes, or
  at cell centroids for elemental/conditional data), colored by magnitude, with
  an adjustable arrow-scale slider.
- **Isosurface** — extract the surface where a scalar equals a slider-driven iso
  value (marching tetrahedra over volume cells; 2D / surface meshes fall back to
  iso-lines).

A colormap dropdown (Rainbow/jet by default, plus Viridis, Cool-warm, and
Grayscale) drives both the 3D coloring and a live legend.

## Mesh modification

The **Mesh Modification** sidebar section hosts in-place operations on the loaded
mesh.

**Convert Linear → Quadratic** inserts mid-edge nodes to raise every linear cell
to its quadratic ("serendipity") counterpart:

| Linear | Quadratic |
|---|---|
| Triangle2D3 | Triangle2D6 |
| Quadrilateral2D4 | Quadrilateral2D8 |
| Tetrahedra3D4 | Tetrahedra3D10 |
| Hexahedra3D8 | Hexahedra3D20 |
| Prism3D6 (wedge) | Prism3D15 |
| Pyramid3D5 | Pyramid3D13 |
| Line2 | Line3 |

Adjacent cells that share an edge get a single welded mid-edge node, nodal fields
are interpolated at the new nodes, and SubModelParts are extended with the mid
nodes of their fully-enclosed edges. Cells that are already quadratic or have no
quadratic counterpart are left untouched.

The newly inserted mid-edge nodes are shown as a semitransparent **Quadratic
mid-nodes** point overlay — a toggleable layer in the outline — so you can see
exactly which nodes were added.

## Editing & operation history

The **Edit** sidebar section records every applied edit and mesh modification into
an undoable **operation history**:

- **Undo / redo / clear** controls, plus a clickable list of the applied
  operations. Clicking any entry **partially reverts** the mesh to that step
  (later steps stay redoable until you apply a new operation).
- Edit operations are driven by **interactive controls in the sidebar** (values are
  entered inline and stored in the history):
  - **Remove orphan nodes** — drop nodes referenced by no cell and no SubModelPart.
  - **Merge coincident nodes** — weld nodes within a tolerance into one.
  - **Scale** — per-axis scale factors (x, y, z).
  - **Translate** — offset by (dx, dy, dz).
  - **Rotate** — by an angle in degrees about the X, Y, or Z axis.
- **Delete a SubModelPart** — click the **✕ button** next to a SubModelPart in the
  outline tree; its entities and any orphaned nodes are removed (undoable like any
  other operation).
- **Linear → Quadratic** (from the Mesh Modification section) is part of the same
  history.

Because the operations are pure and deterministic, the history is stored as a
replayable **recipe**: use **Save operations…** to write the applied operations to
a JSON file, and **Load operations…** to replay a recipe onto the current mesh. The
edited mesh is what **File ▸ Save / Export** writes.

::: tip
The history is tied to the loaded mesh: re-reading the file from disk (or, for a
VTK time series, changing the frame) starts a fresh history.
:::

The transform is applied to the preview in place. Editing the source file (or, for
a VTK series, scrubbing the timeline) reloads the original mesh, so use
**File ▸ Save** / **Export** to write the modified mesh to disk.

## Screenshot

The **📷** toolbar button captures the current viewport as a PNG and opens a
Save dialog pre-filled with the source file's name (e.g. `mesh.png` next to
`mesh.mdpa`). It uses VTK.js's `captureNextImage()` for correct WebGL swap-chain
timing.

::: tip
SVG export is not possible — the viewport is a rasterised WebGL canvas.
:::

## Find entity by ID

The **Find** toolbar button (or the **Find Entity by ID** command) lets you type
a Node, Element, Condition, or Geometry ID to locate it instantly. The entity is
highlighted in yellow and the camera zooms to it; all other layers switch to
wireframe so the result stands out clearly. Closing the bar restores the
previous display state.

## Orientation & navigation

- **Orientation cube + axis arrows** — an always-visible labeled cube in the
  bottom-left corner (RIGHT / LEFT / TOP / BOTTOM / FRONT / REAR) that follows
  the camera as you orbit. Prominent X (red), Y (green), and Z (blue) axis
  arrows with letter labels radiate from the cube. Clicking a face snaps the
  camera to that canonical axis direction.
- **Navigation controls** — a compact on-screen panel that appears once a model
  loads, next to the orientation cube:
  - **Rotate** compass — four arrow buttons orbit the camera by ±15°
    (azimuth / elevation); press-and-hold for continuous rotation.
  - **Pan** compass — four arrow buttons translate the camera plane (step
    proportional to the current zoom level).
  - **Zoom** — `+` / `−` buttons dolly the camera (×1.25 / ×0.8); press-and-hold
    for continuous zoom.
  - **Fit** — frames all visible geometry (same as the **Reset Camera**
    command).
  - **Center** — re-centers the focal point on the visible model bounds without
    changing the orbit angle or zoom.
- **Background grid** — the **Grid** toolbar button toggles a `CubeAxesActor`
  bounding box with labeled X/Y/Z axes and tick marks around the mesh. Colors
  adapt to the active scene theme.

## Editor integration

The extension registers the `mdpa` language id with `//` comments,
`Begin`/`End` folding, and syntax highlighting. The raw text editor stays the
default; open the preview from the editor-title button, the explorer context
menu, or the **Open MDPA Preview** command.
