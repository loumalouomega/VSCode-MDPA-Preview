# Opening a Preview

The raw text editor is the **default** for `.mdpa` and mesh files — the preview
opens as a separate custom editor next to (or instead of) the text, so the file
text is always one click away.

## Four ways to open

- **The Kratos sidebar** — click the Kratos icon in the activity bar (VS Code's
  far-left strip). This is the only route that needs **no file open at all**;
  see [The Kratos sidebar](#the-kratos-sidebar) below.
- **Editor-title button** — open the file in the text editor, then click the
  preview icon in the top-right editor toolbar.
- **Explorer context menu** — right-click the file in the Explorer and choose
  **Open MDPA Preview** (for `.mdpa`) or **Open VTK Preview** (for any mesh
  format).
- **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`) — run **Kratos MDPA:
  Open MDPA Preview** or **Kratos VTK: Open VTK Preview**. Palette commands also
  cover **Reset Camera**, **Toggle Node IDs**, **Compute Mesh Quality**, **Field
  Visualization**, and **Find Entity by ID** for the active preview.

## The Kratos sidebar

The **Kratos** icon in the activity bar opens a panel that works from a cold
window — nothing has to be open first:

- **Open Mesh File…** — a file picker over every supported format; the pick
  opens in the matching preview.
- **Open Empty Preview** — brings up the preview window itself with an empty
  viewport, for when you want the tool up before choosing a mesh. It is a
  launcher: opening a file from it hands over to the ordinary preview and the
  empty window closes.
- **Load Problem…** — extract a `.kratosproblem.zip` and open its mesh, edits
  and case setup (see **Load problem…** below).
- **Recent Meshes** — the last ten meshes you opened, newest first. Click a row
  to reopen it; the inline **✕** forgets one and the title-bar button clears the
  list. Meshes that have since been moved or deleted drop off by themselves.

**Kratos Runs** — the list of tracked solver runs — appears here too while any
run exists, alongside its usual home in the Explorer, so a solve can be watched
without leaving the panel. See [Running a Case](./running-a-case).

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
| **Clip** (nav card group) | An interactive clipping plane: X / Y / Z / Free segments, flip, position slider and an Off/On toggle. |
| **Display** (nav card group) | Shaded / Wire segments — wireframe rendering of all layers — plus an **Edges** toggle for the mesh edge lines. |
| **Node IDs** | Overlay node-id labels (capped at 1 000 nodes). |
| **Quality** | Open the [mesh-quality](./mesh-quality) panel. |
| **Field** | Open the [field-visualization](./field-visualization) panel. |
| **Grid** | Toggle a labeled bounding-box [grid](./navigation#background-grid). |
| **Find** | [Find an entity by ID](./navigation#find-entity-by-id). |
| **📷** | Save the current viewport as a PNG. |
| **Appearance** (nav card group) | Scene theme (Auto / Dark / Light / Scientific), global model opacity, and the Persp/Ortho camera flip. |

### The File menu

![The File dropdown: Open, Save, Save As, and the Export-As format list](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/file-menu.png)

The **File** dropdown (top-left of the viewport) mirrors the `kratos.mesh.*`
palette commands:

- **Open…** — open another mesh file in the matching preview.
- **Save** — re-serialize the (possibly edited) mesh back to its **source
  format** and overwrite the file (with a one-time overwrite warning).
- **Save As…** — write to a new file in the source format.
- **Export ▸** — write the mesh to a different format, grouped by family:
  **Kratos** (`.mdpa`), **VTK** (`.vtk`, `.vtu`, `.vtp`, `.xdmf`), **Surface**
  (`.stl`, `.obj`, `.ply`, `.off`, `.wkt`) and **Solvers** (`.msh`, `.mesh`,
  `.inp`, `.bdf`, `.unv`, `.vol`, `.su2`, `.dat`, and more via meshio++).
- **Save problem…** — bundle the whole setup into one portable zip: the
  original mesh file, the applied edit operations as a recipe, the problemtype
  case state (`<name>.kratoscase.json`) and the generated case files
  (`ProjectParameters.json`, the materials JSON, `MainKratos.py`,
  `<name>_case.mdpa`) — whichever exist.
- **Load problem…** — extract such an archive into a folder of your choice;
  the mesh opens in the preview, the bundled edits are replayed automatically
  and the case setup is restored.

Everything you do in the **Edit** / **Mesh Modification** sections is what Save
and Export write — the edited mesh, not the original file text.

### The 3D viewport (right)

The rendered scene, with the always-on [orientation cube and navigation
controls](./navigation) in the corners. For time-series files a
[timeline bar](./timeline) appears along the bottom.
