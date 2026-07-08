# Opening a Preview

The raw text editor is the **default** for `.mdpa` and mesh files — the preview
opens as a separate custom editor next to (or instead of) the text, so the file
text is always one click away.

## Three ways to open

- **Editor-title button** — open the file in the text editor, then click the
  preview icon in the top-right editor toolbar.
- **Explorer context menu** — right-click the file in the Explorer and choose
  **Open MDPA Preview** (for `.mdpa`) or **Open VTK Preview** (for any mesh
  format).
- **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`) — run **Kratos MDPA:
  Open MDPA Preview** or **Kratos VTK: Open VTK Preview**. Palette commands also
  cover **Reset Camera**, **Toggle Node IDs**, **Compute Mesh Quality**, **Field
  Visualization**, and **Find Entity by ID** for the active preview.

## A tour of the window

![The preview window: sidebar (stats, layers, edit, mesh modification) on the left; toolbar and 3D viewport on the right](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/preview-overview.png)

The window has three regions:

### The sidebar (left)

A scrollable panel of collapsible sections, from top to bottom:

- **Information** — the stats panel: node / element / condition / geometry
  counts, `SubModelParts` count, detected **2D / 3D** dimensionality, the mesh
  **bounding box**, and any element type names that could not be mapped to a
  drawable cell.
- **Layers** — the [outline tree](./viewer-outline): a **Mesh** group (one row
  per entity block) and a **SubModelParts** group (the full hierarchy), each row
  an independently toggleable layer.
- **Edit** and **Mesh Modification** — in-place mesh operations and an undoable
  history (see [Mesh Editing & History](./mesh-editing) and
  [MMG Remesh & Level-set](./mmg-remeshing)).

Drag the divider between the sidebar and the 3D view to **resize** the sidebar
(clamped between 160 and 640 px); the viewport re-fits automatically.

### The toolbar (top)

The toolbar sits across the top of the viewport (visible in the screenshot
above):

| Button | What it does |
|---|---|
| **Reset** | Frame all visible geometry (reset the camera). |
| **Pan** | Toggle click-drag panning of the camera. |
| **Cut Plane** | Toggle an interactive clipping plane (X / Y / Z, flip, position slider). |
| **Wireframe** | Toggle wireframe rendering of all layers. |
| **Node IDs** | Overlay node-id labels (capped at 1 000 nodes). |
| **Quality** | Open the [mesh-quality](./mesh-quality) panel. |
| **Field** | Open the [field-visualization](./field-visualization) panel. |
| **Grid** | Toggle a labeled bounding-box [grid](./navigation#background-grid). |
| **Find** | [Find an entity by ID](./navigation#find-entity-by-id). |
| **📷** | Save the current viewport as a PNG. |
| **Theme** | Scene theme: Auto / Dark / Light / Scientific. |

### The File menu

![The File dropdown: Open, Save, Save As, and the Export-As format list](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/file-menu.png)

The **File** dropdown (top-left of the viewport) mirrors the `kratos.mesh.*`
palette commands:

- **Open…** — open another mesh file in the matching preview.
- **Save** — re-serialize the (possibly edited) mesh back to its **source
  format** and overwrite the file (with a one-time overwrite warning).
- **Save As…** — write to a new file in the source format.
- **Export ▸** — write the mesh to a different format (`.mdpa`, `.vtk`, `.vtu`,
  `.vtp`, `.stl`, `.obj`, `.ply`).

Everything you do in the **Edit** / **Mesh Modification** sections is what Save
and Export write — the edited mesh, not the original file text.

### The 3D viewport (right)

The rendered scene, with the always-on [orientation cube and navigation
controls](./navigation) in the corners. For time-series files a
[timeline bar](./timeline) appears along the bottom.
