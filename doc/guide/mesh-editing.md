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

## Additional mesh operations

![The Mesh Modification sidebar organized into six subcategories — Element order & topology (expanded, with Refine open), Remeshing (MMG), Smoothing & renumbering, Selection & combination, Fields, and Sphere elements](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/mesh-operations.png)

The Mesh Modification section also surfaces the extension's bundled
[meshio++](https://www.npmjs.com/package/@meshioplusplus/wasm) as an *oracle* —
it computes something (moved coordinates, a node permutation, a per-cell label)
that gets applied onto your own mesh, so SubModelParts, ids and material
assignments are never lost the way a raw meshio++ round-trip would lose them —
plus several operations implemented natively. These, together with Convert
Linear → Quadratic, Remesh (MMG), Level-set split (MMG) and Set element radius,
are grouped into six collapsible subcategories — **Element order & topology**,
**Remeshing (MMG)**, **Smoothing & renumbering**, **Selection & combination**,
**Fields**, and **Sphere elements** — so the section reads as a short list of
categories rather than a long flat list of forms:

- **Smooth** — Taubin (default, shrink-free) or Laplacian mesh smoothing.
  Boundary nodes and sharp-feature edges are pinned by default, and a move that
  would invert a cell is rejected by default (`guard inversion`). Only
  coordinates change; node count, connectivity and fields are untouched.
- **Reorder** — renumber nodes for **RCM** bandwidth reduction, or **Morton** /
  **Hilbert** space-filling curves for cache locality. A pure permutation: the
  same coordinates and cells, just renumbered, so nothing else about the mesh
  changes.
- **Partition** — space-filling-curve domain decomposition into *N* balanced
  parts (by cell count), attached as a real Kratos `PARTITION_INDEX` Elemental
  field, optionally also creating one SubModelPart per part. The bundled WASM
  build has no KaHIP, so only the space-filling-curve method is offered — good
  for previewing a decomposition and for a quick run, not a substitute for an
  edge-cut-optimized partitioner.
- **Refine** — uniform subdivision: triangles/quadrilaterals/tetrahedra/
  hexahedra/wedges split into 4 or 8 children, lines into 2, up to 4 levels.
  Shared edges/faces are deduplicated to a single new node (no hanging nodes),
  nodal fields interpolate exactly at the new nodes, and elemental/conditional
  fields and SubModelPart membership extend to the children.
- **Quadratic → Linear** — the inverse of Convert Linear → Quadratic: drops
  mid-edge nodes and restores the underlying linear cell type.
- **Simplexify** — converts non-simplex cells to simplices: hexahedra → 6
  tetrahedra, wedges → 3, pyramids → 2, quadrilaterals → 2 triangles.
- **Crop** — keeps only the cells inside a bounding box or on one side of a
  plane, either requiring **all** of a cell's nodes to qualify or **any** one
  of them; anything left unreferenced is then removed.
- **Field calculator** — derives a new nodal/elemental/conditional field from a
  formula over the node/cell coordinates and any existing field at that
  location — the same safe expression evaluator (never `eval`) as the MMG
  `size = ƒ(h)` remesh mode. Paired with **nodal ↔ elemental averaging** (mean
  over a cell's own nodes, or mean over a node's incident cells) to move a
  field between locations.
- **Merge mesh** — appends another mesh file's nodes and cells, offsetting ids
  past the current mesh's maximum and wrapping the merged-in geometry in its
  own SubModelPart, with an optional weld of coincident nodes across the seam
  (the same tolerance grid as Merge coincident nodes).

Smooth, Reorder, Partition and Merge mesh run asynchronously — the same inline
progress bar and play/stop cancel button as the MMG operations. The rest apply
instantly. Every one of these joins the same undoable operation history and
JSON recipe as the operations above, and is reachable from the `mesh_transform`
tool on the [MCP server](./development), same as every other mesh operation, for
scripting.

### Export skin

**Advanced ▸ Export skin…** is not an in-place edit but an *export*: it
extracts the boundary of the mesh's volume cells (plus any pre-existing
surface cells) as a standalone surface mesh and writes it to a file of your
choice, through the same format picker as File ▸ Export. It is a native
boundary-face walk — a face seen by exactly one cell is boundary — rather than
meshio++'s own surface/skin extractors, so SubModelParts survive the
extraction (narrowed to node membership; element/condition membership cannot
follow, since the skin's faces get fresh entity ids). Also reachable from the
`mesh_extract_skin` MCP tool.

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
- **Set element radius** — set or scale the `RADIUS` of one-node
  (sphere/particle) elements, optionally limited to one SubModelPart. See
  [Sphere / Particle Elements](./sphere-elements#making-the-radius-part-of-the-mesh).

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
