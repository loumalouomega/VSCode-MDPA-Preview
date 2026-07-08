# Mesh Editing & History

The preview is not read-only: the **Edit** and **Mesh Modification** sidebar
sections apply in-place operations to the loaded mesh, all recorded into an
undoable, replayable **operation history**. The edited mesh is what
**File ▸ Save / Export** writes to disk.

## Linear → Quadratic

**Convert Linear → Quadratic** (Mesh Modification) inserts mid-edge nodes to
raise every linear cell to its quadratic ("serendipity") counterpart:

| Linear | Quadratic |
|---|---|
| Triangle2D3 | Triangle2D6 |
| Quadrilateral2D4 | Quadrilateral2D8 |
| Tetrahedra3D4 | Tetrahedra3D10 |
| Hexahedra3D8 | Hexahedra3D20 |
| Prism3D6 (wedge) | Prism3D15 |
| Pyramid3D5 | Pyramid3D13 |
| Line2 | Line3 |

![Linear→Quadratic: the new mid-edge nodes shown as a semitransparent overlay](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/meshmod-quadratic.png)

Adjacent cells that share an edge get a single **welded** mid-edge node, nodal
fields are interpolated at the new nodes, and SubModelParts are extended with the
mid nodes of their fully-enclosed edges. Cells that are already quadratic or have
no quadratic counterpart are left untouched. The new mid nodes are drawn as a
semitransparent **Quadratic mid-nodes** overlay (a toggleable outline row), so you
can see exactly what was added.

For MMG-based remeshing and level-set splitting, see
[MMG Remesh & Level-set](./mmg-remeshing).

## Edit operations

![The Edit section: undo / redo / clear, the applied-operations list, and the interactive transform forms](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/edit-history.png)

The **Edit** section hosts interactive, form-driven operations — enter the values
inline and press **Apply** (or Enter in a field):

- **Remove orphan nodes** — drop nodes referenced by no cell and listed in no
  SubModelPart.
- **Merge coincident nodes** — weld nodes within a **tolerance** into one.
- **Scale** — per-axis scale factors (x, y, z).
- **Translate** — offset by (dx, dy, dz).
- **Rotate** — by an angle in degrees about the X, Y, or Z axis, through a
  configurable center point (defaults to the origin).
- **Delete a SubModelPart** — triggered from the **✕ button** on a SubModelPart
  row in the [outline tree](./viewer-outline#the-outline-tree-layers); its
  entities and any orphaned nodes are removed.

Each transform form is a collapsible dropdown — click its title to expand its
inputs.

## Operation history

Every applied edit — including Linear → Quadratic and the MMG operations — is
recorded in the history:

- **Undo / Redo / Clear** controls.
- A **clickable list** of the applied operations. Clicking an entry **partially
  reverts** the mesh to that step; later steps stay redoable until you apply a new
  operation.

Because the operations are pure and deterministic, the history is a replayable
**recipe**:

- **Save operations…** writes the applied operations to a JSON file.
- **Load operations…** replays a recipe onto the current mesh.

::: tip
The history is tied to the loaded mesh. Re-reading the file from disk — or, for a
VTK time series, changing the frame — starts a **fresh** history. Use
**File ▸ Save** / **Export** to persist the edited mesh before reloading.
:::
