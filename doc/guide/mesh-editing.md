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

Smooth, Reorder, Partition and Merge mesh run asynchronously — the same inline
progress bar and play/stop cancel button as the MMG operations. The rest apply
instantly. Every one of these joins the same undoable operation history and
JSON recipe as the operations above, and is reachable from the `mesh_transform`
tool on the [MCP server](./development), same as every other mesh operation, for
scripting.

::: tip Reading the screenshots below
Where an operation changes geometry or topology, the shot places the mesh
**before** it (blue, left) next to the **result** (orange, right) in one view,
with the operation's own form open in the sidebar showing the exact parameters
that produced it. Where it instead produces a **field**, the shot colours the
result by that new variable through the [Field panel](./field-visualization).
:::

### Element order & topology

#### Refine

![Refine: a 2×2×2 block of hexahedra on the left, the same block after one level of uniform subdivision into 4×4×4 on the right, with the Refine form showing levels = 1](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-refine.png)

Uniform subdivision: triangles/quadrilaterals/tetrahedra/hexahedra/wedges split
into 4 or 8 children, lines into 2, up to 4 levels. Shared edges and faces are
deduplicated to a single new node — so there are **no hanging nodes** — nodal
fields interpolate exactly at the new nodes, and elemental/conditional fields
and SubModelPart membership extend to the children. The 8 elements above become
64; a second level would make it 512, which is why the level count is capped.

#### Quadratic → Linear

![Quadratic → Linear: a quadratic hex block with its mid-edge nodes labelled on the left, the same block reduced to corner nodes only on the right](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-linearize.png)

The inverse of Convert Linear → Quadratic: drops the mid-side nodes and restores
the underlying linear cell type (Tetrahedra3D10 → Tetrahedra3D4, Hexahedra3D20 →
Hexahedra3D8, …), then removes whatever is left unreferenced. With **Node IDs**
turned on the difference is literal — the same 8 cells, 81 nodes before and 27
after.

#### Simplexify

![Simplexify: a block of hexahedra on the left, the same volume decomposed into tetrahedra on the right, shown in wireframe](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-simplexify.png)

Converts non-simplex cells to simplices: hexahedra → 6 tetrahedra, wedges → 3,
pyramids → 2, quadrilaterals → 2 triangles. The first child keeps the parent's
id and its siblings get fresh ones, with elemental/conditional fields and
SubModelPart membership replicated to each. A mesh that is already all-simplex
is a no-op.

### Smoothing & renumbering

#### Smooth

![Smooth: a jagged, randomly displaced quad sheet on the left, the same sheet relaxed into a smooth surface on the right, with the Smooth form showing method = taubin and 20 iterations](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-smooth.png)

Taubin (the default — it alternates a shrink and an anti-shrink pass, so a
closed surface keeps its volume) or Laplacian mesh smoothing. Boundary nodes and
sharp-feature edges are pinned by default, and a move that would invert a cell
is rejected by default (`guard inversion`). **Only coordinates change** — node
count, connectivity, SubModelParts and every field come through untouched, which
is what makes this safe to apply to a mesh you have already set a case up on.

#### Reorder

![Reorder: a hexahedral block with node-id labels shown after RCM renumbering, with the Reorder form showing method = bandwidth (RCM)](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-reorder.png)

Renumbers nodes for **RCM** bandwidth reduction, or along a **Morton** /
**Hilbert** space-filling curve for cache locality. This is the one operation
with nothing to see in the geometry — it is a pure permutation, so the shot
turns **Node IDs** on, since the numbering is precisely what changed. The
coordinates, the cells, the SubModelParts and the fields are all the same mesh,
just renumbered; the payoff is in how a solver's sparse matrix assembles.

#### Partition

![Partition: a hexahedral block coloured into four contiguous domains by the PARTITION_INDEX field, with the Field panel showing PARTITION_INDEX and the Partition form showing 4 parts](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-partition.png)

Space-filling-curve domain decomposition into *N* parts balanced by cell count,
attached as a real Kratos `PARTITION_INDEX` Elemental field (so it exports, and
Kratos can read it) and optionally also created as one SubModelPart per part.
Colouring by that field through the Field panel is how you check the result, as
above. The bundled WASM build has **no KaHIP**, so only the space-filling-curve
method is offered — good for previewing a decomposition and for a quick run, but
it minimizes no edge cut and is not a substitute for METIS.

### Selection & combination

#### Crop

![Crop: an 8×8×4 hexahedral block reduced to the half of its cells that fall inside the bounding box, with the Crop form showing the box min and max](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-crop.png)

Keeps only the cells inside a bounding box or on one side of a plane, either
requiring **all** of a cell's nodes to qualify or **any** one of them; anything
left unreferenced afterwards is removed. SubModelParts narrow to the survivors
rather than disappearing. Above, a box cutting at x = 4.5 keeps half the block.

#### Merge mesh

![Merge mesh: a 4×4×2 block and a separate 3×3×2 block merged into one model, the merged-in geometry listed as the MergedMesh SubModelPart](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-mergeMesh.png)

Appends another mesh file's nodes and cells, offsetting their ids past the
current mesh's maximum and wrapping the merged-in geometry in its own
SubModelPart (`MergedMesh` above) so you can still tell the two apart — frame
it, export it or delete it from the outline like any other part. Optionally
welds coincident nodes across the seam, using the same tolerance grid as
**Merge coincident nodes**.

### Fields

#### Field calculator

![Field calculator: a hexahedral block coloured by a new RADIAL_DISTANCE nodal field computed from sqrt(x^2 + y^2 + z^2), with the formula visible in the Field calculator form](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-fieldCalc.png)

Derives a new nodal/elemental/conditional field from a formula over the node or
cell-centroid coordinates (`x`, `y`, `z`) and any existing field at that
location — a vector field's components are reachable as `NAME_X`/`NAME_Y`/
`NAME_Z`. It uses the same safe recursive-descent evaluator as the MMG
`size = ƒ(h)` remesh mode, **never `eval`**, which matters because a formula can
arrive from a saved recipe or a problem archive. A bad formula is rejected
inline before anything is applied; a value that cannot be computed (a referenced
field is silent at that entity) drops that row, while a genuine infinity from
e.g. `1/0` is kept.

#### Average field

![Average field: the same block coloured by an elemental RADIAL_DISTANCE field obtained by averaging the nodal one onto the cells, with the Average field form showing nodal → elemental](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-averageField.png)

Moves a field between the nodal and elemental/conditional locations by
averaging: **nodal → elemental** takes the mean over a cell's own nodes,
**elemental → nodal** the mean over a node's incident cells (unweighted, not
measure-weighted). Above it turns the nodal `RADIAL_DISTANCE` from the field
calculator into a per-element one — note the flat, per-cell colouring against
the smooth nodal gradient in the previous shot.

#### Field gradient

Differentiates a **nodal** field, attaching the result as a new nodal field
named `<FIELD>_<OPERATOR>` unless you name it yourself. The **operator** picks
between the gradient, the divergence and the curl; the latter two need a 2- or
3-component (vector) field. A scalar's gradient has three components and a
3-vector's has nine, laid out as `[component][derivative]`.

The **method** is a genuine choice rather than a tuning knob. *Green-Gauss*
integrates over each cell's own faces and is exact for a linear field on any
cell, which makes it the right default. *Least-squares* fits over the
node-sharing neighbours instead and is smoother on an irregular mesh, falling
back to Green-Gauss where a neighbourhood is degenerate.

Two things are reported rather than hidden, because a field that is quietly
part-`NaN` looks perfectly healthy in the field picker: how many cells could
not be differentiated at all (a cell below the mesh's own topological
dimension, or a degenerate one — these come back `NaN`, never an
approximation), and how many least-squares neighbourhoods fell back.

An **elemental** field is piecewise constant, so it has no derivative; run
**Average field** in the `elemental → nodal` direction first and differentiate
the result.

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
