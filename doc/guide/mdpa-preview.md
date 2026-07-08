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

### Remeshing (MMG)

**Remesh (MMG)** runs the [MMG](https://www.mmgtools.org/) remeshers in-process
via the [`@loumalouomega/mmg-wasm`](https://www.npmjs.com/package/@loumalouomega/mmg-wasm)
WebAssembly build — no native binaries. The right MMG module is picked
automatically (and can be overridden under **Advanced**):

| Mesh | Module |
|---|---|
| Tetrahedral volume (+ pass-through prisms, boundary triangles/quads/edges) | **mmg3d** |
| Non-planar triangulated surface | **mmgs** |
| Planar triangulation (+ quads) | **mmg2d** |

Three modes:

- **size × factor** — the one-knob refine/coarsen: each node gets a metric equal
  to its current local edge size times your factor (0.5 → twice as fine, 2 →
  twice as coarse).
- **uniform** — remesh to a constant target edge size (`hsiz`).
- **optimize** — size-preserving quality optimization (`IPARAM_optim`).

The **Advanced** block exposes the MMG tuning surface: `hmin` / `hmax` size
bounds, `hausd` (Hausdorff distance controlling geometry approximation —
defaults to **0.5% of the bounding-box diagonal**; MMG's own default is the
absolute value 0.01, which explodes on large domains), `hgrad` (size
gradation), the sharp-angle detection threshold in degrees (≤ 0 disables ridge
detection), and the `keep surface` (`nosurf`) / `no insert` / `no swap` /
`no move` toggles.

**Level-set split (MMG)** discretizes an isovalue of any **nodal field** as an
explicit, conforming boundary: pick the field (vector fields use their magnitude)
and the isovalue, and the mesh is split into `MMG_Domain_Inside` /
`MMG_Domain_Outside` blocks separated by an `MMG_Interface` layer. Each created
region is **also generated as a SubModelPart** of the same name, so the domains
and the interface appear in the outline's SubModelParts section, can be exported
or deleted individually, and are written as real `Begin SubModelPart` blocks on
save. On volume meshes, `surface only` (`IPARAM_isosurf`) splits just the
boundary surfaces. Its own **Advanced** block exposes the same `hmin` / `hmax` /
`hausd` / `hgrad` size controls and module override as Remesh, for cases where
the automatic defaults need a manual nudge — e.g. tightening `hausd` below the
0.5%-of-diagonal default for a sharper interface.

What survives a remesh:

- **Element/condition/geometry blocks** keep their names — every cell is tagged
  with an MMG reference encoding its block + SubModelPart membership and the
  output is regrouped from those references.
- **SubModelParts** are rebuilt the same way (their node lists become the
  connectivity closure of their surviving cells).
- **Nodal/elemental data cannot follow a remesh** — the fields are dropped and
  the result message says so. Node and entity ids are freshly renumbered.

Hexahedral, pyramid and quadratic meshes are rejected with a message (MMG is
tet/triangle-based). Remeshes join the operation history like any other edit:
undo is instant (the result is snapshotted), and remesh steps saved in a JSON
recipe re-run MMG deterministically when the recipe is replayed.

MMG runs in a **worker thread**, so the editor never freezes during a long
remesh. Press the form's **▶ play button** to start: an **inline loading bar
just below streams MMG's live output** — the analysis and meshing phases,
gradation, and split/collapse/swap counters — while the play button turns into
a **■ stop button** that cancels the run immediately, leaving the mesh
unchanged.

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
  - **Rotate** — by an angle in degrees about the X, Y, or Z axis, through a
    configurable center point (defaults to the origin).
- **Delete a SubModelPart** — click the **✕ button** next to a SubModelPart in the
  outline tree; its entities and any orphaned nodes are removed (undoable like any
  other operation).
- **Linear → Quadratic**, **Remesh (MMG)** and **Level-set split (MMG)** (from
  the Mesh Modification section) are part of the same history.

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
