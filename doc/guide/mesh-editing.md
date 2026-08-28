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

A third method, **ODT** (optimal-Delaunay-triangulation), is aimed at a
different goal. Taubin and Laplacian smooth a *surface*; ODT moves each free
interior vertex to the volume-weighted average of its incident tetrahedra's
circumcenters, which raises **element quality** — it is the one to reach for
before a solve rather than for appearance. It is **tetrahedra-only**, and says so
by name rather than quietly doing nothing if the mesh contains anything else.

#### Reorder

![Reorder: a hexahedral block with node-id labels shown after RCM renumbering, with the Reorder form showing method = bandwidth (RCM)](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-reorder.png)

Reorders nodes for **RCM** bandwidth reduction, or along a **Morton** /
**Hilbert** space-filling curve for cache locality. This is the one operation
with nothing to see in the geometry — it is a pure permutation, so the shot
turns **Node IDs** on, since the ordering is precisely what changed. The
coordinates, the cells, the SubModelParts and the fields are all the same mesh,
just reordered; the payoff is in how a solver's sparse matrix assembles.

What changes is **storage order** — which node is written first, second, third —
and *not* the ids: every node keeps its own id and its own coordinates. That is
exactly why the SubModelParts and fields come through untouched, since they refer
to entities by id and never by position. If you want the ids themselves to change,
that is **Renumber**, below, and running Reorder then Renumber gives you a full
RCM renumbering.

#### Renumber

![Renumber: a cropped hexahedral block with node-id labels showing a gapless 1–84 run, and the Renumber form showing ids = nodes + entities, from 1](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-renumber.png)

Compacts ids into a gapless run starting at 1, in the order the mesh already
stores them. It is the natural cleanup after a **Crop**, a **Merge mesh** or a
**Remove orphan nodes**, each of which leaves holes behind: node 5, node 11,
node 40 becomes node 1, node 2, node 3, with connectivity, SubModelPart
membership and every field record following their ids automatically.

Elements, Conditions and Geometries are each numbered **independently**, which
is what Kratos means — a mesh with `Element 1` and `Condition 1` side by side is
correct, not a collision. You can scope the operation to just the nodes or just
the entities, and start the run somewhere other than 1.

Three things are deliberately left alone, because renumbering them would be a
guess rather than a relabelling:

- **Coordinates.** Renumber changes labels, Reorder changes positions.
- **Property ids** on cells — those index the `Properties` blocks, a separate id
  space this extension copies through verbatim rather than parsing.
- **Constraint ids** in SubModelParts — `Constraints` blocks are not parsed into
  entities, so there is nothing to renumber them against. The operation says how
  many it left when there are any, rather than passing over them silently.

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

![Merge mesh: a 4×4×2 block with a 3×3×2 and a 2×2×4 block merged in from two files in a single operation, each listed as its own SubModelPart — beam and column — and the Merge mesh form showing "2 files: beam.mdpa, column.mdpa"](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-mergeMesh.png)

Appends one or **several** mesh files' nodes and cells, offsetting their ids past
the current mesh's maxima and wrapping each merged-in file in its own
SubModelPart so you can still tell the pieces apart — frame one, export it or
delete it from the outline like any other part. Optionally welds coincident
nodes across the seams, using the same tolerance grid as **Merge coincident
nodes**.

Pick several files in the Browse dialog and they merge in **one operation**:
one pass of id offsetting, one weld across every seam, and one entry in the
history to undo. Each part is named after its file (`beam`, `column`, …), with a
`_2` suffix if that name is already taken; fill in **name** and it becomes the
parent instead, with the files as its children.

Ids are offset per kind, so elements continue the element run and conditions the
condition run rather than both jumping past a shared maximum. That leaves the
smallest gaps possible, and **Renumber** closes what remains.

Two things do not survive a merge, and the operation says so rather than leaving
you to find out later. The merged file's `Properties` blocks are not carried
over — this extension keeps only their line counts, and the written file copies
the *original* mesh's Properties verbatim — so cells that arrive referring to
property 7 will resolve against your mesh's property 7. And a field that exists
on both sides under the same name but with a different number of components is
skipped rather than merged, since one variable cannot be a scalar and a vector
at once.

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

#### Field Hessian

![Field Hessian: a hexahedral block coloured by one component of the nine-component TEMP_HESSIAN field computed from a quadratic nodal field, with the Field Hessian form showing method = green-gauss](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-fieldHessian.png)

The second derivative of a **scalar** nodal field, attached as a new nodal field
of nine components — the flattened row-major 3×3 matrix, with `H[i][j]` at index
`i*3+j`. It is `Field gradient`'s companion one order further, and the two share
the same **method** choice, forwarded to both internal passes.

The guarantee worth knowing is what it says about your mesh rather than about
the operation: a field that is **at most linear has an exactly zero Hessian
everywhere**, on any mesh. That is the one shape-independent property, so a
linear field coming back non-zero is a red flag. For a genuinely curved field
the result is exact on a structured mesh away from its own boundary and a good,
standard, but genuinely approximate curvature estimate on an irregular one — it
is a composition of two gradient passes, not a separate numerical kernel.

The Hessian is defined for one component at a time, so a **vector** field is
refused rather than silently reduced: split it with the field calculator and run
this once per component. An **elemental** field is refused for the same reason
`Field gradient` refuses one, with the same fix.

#### Error estimate

![Error estimate: a hexahedral block coloured by the per-cell ERROR_INDICATOR of a sinusoidal nodal field, with the Error estimate form showing marking = fraction and value 0.3](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-estimateError.png)

Answers "where is this mesh not good enough for this solution?" using the
Zienkiewicz–Zhu recovery-based indicator: per cell,
`sqrt(measure × Σ(recovered − raw gradient)²)`, attached as an Elemental field
(`ERROR_INDICATOR` by default).

Read a near-zero result as good news, not a failure. The estimator compares a
smoothed gradient against the piecewise one, and for a field the mesh represents
**exactly** — anything linear — those agree, so the error genuinely is zero. A
curved field on a coarse mesh is where the numbers appear.

**Marking** turns the indicator into an actionable 0/1 flag in a second
`ERROR_MARKED` field: *absolute* thresholds the indicator directly, *fraction*
marks that share of cells worst-first, and *dörfler* marks the smallest set of
cells holding that share of the total error. Because it is an ordinary field,
the Field panel's **threshold** mode will isolate the marked cells for you, and
it rides a `.mdpa` export like any other elemental data.

Cells that cannot be evaluated read `NaN` in the indicator but **`0`, never
`NaN`**, in the marking array — so a marking field is always safe to threshold
on. The count is reported alongside the global error.

#### Distance to surface

![The Distance to surface form: a surface mesh chosen via Browse, the sign mode set to pseudonormal, and the output field named SDF_DISTANCE](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-sdfDistance.png)

Measures the signed distance from every node of this mesh to a **surface mesh
you pick from disk**, as a new nodal field (`SDF_DISTANCE` by default).
**Negative is inside.**

The pairing is the point: **Level-set split (MMG)** already cuts a mesh along the
isosurface of a nodal field, but there was no way to get such a field from an
imported geometry. Run *Distance to surface*, then *Level-set split* on its
output, and you have cut your mesh along that surface — no new machinery, two
ordinary undoable operations.

The **sign** mode decides how inside/outside is determined. *Pseudonormal* is the
fast angle-weighted test and the right default; *winding* uses the generalized
winding number, slower but tolerant of small holes; *unsigned* skips the question
entirely, which is what you want for an open surface, where "inside" has no
meaning. **Band** trades accuracy for speed by computing exact values only within
a given distance of the surface and clamping beyond it.

#### Transfer fields

![Transfer fields: a coarse hexahedral block coloured by a DENSITY field conservatively transferred from a finer mesh, with the Transfer fields form showing on clash = overwrite](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-transferField.png)

Maps another mesh's fields onto this one — mapping a coarse solution onto a
refined mesh, or bringing a solver result back onto the geometry you are editing.
It uses **conservative** interpolation: over the region the two meshes share, the
measure-weighted sum is equal on both sides. For anything that is a density —
mass, energy, a source term — pointwise sampling quietly changes the total, and
the total is usually what mattered.

Two consequences are worth stating up front:

- **Nodal data is smoothed, not resampled.** The conservation guarantee is
  cell-based, so nodal fields travel by a point → cell → clip → point round trip.
  A constant field survives exactly; a varying one comes back averaged, *even
  between two identical meshes*. This op is for moving data between different
  discretizations, not for copying a field you already have.
- **A field that no longer fits is dropped, and named.** Both meshes are
  simplexified internally (a hexahedron fans into six tetrahedra), so a
  transferred cell array can come back with a different entity count than this
  mesh has. Rather than scatter values onto the wrong elements, such an array is
  discarded with a diagnostic naming it.

Leave **fields** empty to transfer everything the source carries. **On clash**
decides what happens to a name that already exists here: *overwrite* (the
default, so re-running updates), *suffix*, or *error*.

## Reorganizing the SubModelPart tree

![The organize menu open on a SubModelPart row: New child, Move under, Merge into, and Edit membership pre-filled with kind = nodes and ids 1,2,5-8](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/organize-submodelpart.png)

Every SubModelPart row in the outline carries an **organize** button beside the
rename and delete ones. It opens a small menu with four things:

- **New child** — type a name and press Enter to create an empty SubModelPart
  under this one. (Names follow the same rules as rename: non-empty, no `/`,
  and no clash with an existing sibling.)
- **Move under** — reparent this part anywhere else in the tree, or back to the
  top level. Every descendant path is rebased with it.
- **Merge into** — fold this part into another: the target gains the union of
  the entity ids, this part's children re-attach under the target, and this
  part disappears.
- **Edit membership** — add or remove node, element, condition or geometry ids
  directly: pick the kind, type a comma-separated id list with optional ranges
  (`1,2,5-10`), and press Add or Remove. Removing changes membership only — the
  node or element itself stays in the mesh, just no longer claimed by this part.

Destinations that cannot work — the part itself, or anything inside its own
subtree — are simply not offered.

::: tip The parent/child rule is maintained, not just checked
Kratos requires a child SubModelPart's entities to be a subset of its parent's.
Rather than refusing operations that would break that, these operations keep it
true the same way Kratos itself does: **adding** an entity to a part also adds
it to every ancestor, and **removing** one also removes it from every
descendant — which is precisely what `ModelPart::AddNode` and
`ModelPart::RemoveNode` do upstream. Moving and merging propagate upward for
the same reason. Whenever that touches parts you did not name, the operation's
message says how many ids moved, so nothing happens silently.
:::

Adding and removing entity ids directly is available as the `mesh_transform`
ops `addSubModelPartEntities` / `removeSubModelPartEntities` (and in a saved
recipe). Note that removing an entity from a part only changes **membership** —
the node or element itself stays in the mesh.

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

### Combining several operations into one apply

![Operation queue: "Queue operations for one apply" checked, with Remove orphan nodes and Scale (sx: 1.5, sy: 1.5, sz: 1.5) staged, and the Apply queued steps button enabled](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/op-queue.png)

Every sidebar form normally applies the moment you click its Apply button —
one click, one history entry, one toast. Check **"Queue operations for one
apply"** (in the Edit section, above Save/Load operations) and that changes:
every Apply button across the whole sidebar — Edit's transform forms *and*
every Mesh Modification form — **stages** its operation into a list instead of
running it immediately. Build up as many steps as you like, from as many
different forms as you like, in whatever order you click them; each staged
row shows a short summary of what it will do and a **×** to drop it again.

Click **Apply queued steps** and they run in that order, in one sequence, under
one progress bar. **Each step still lands as its own ordinary, independently
undoable row in the history** — queuing only saves you the clicks and the
toasts, it does not change how the steps are recorded. Undo peels them off one
at a time, same as any other operation.

A queue that hits a stopping point — you cancel it, or a step fails outright —
keeps whatever already succeeded. Nothing is rolled back; the toast tells you
how far it got, and the mesh reflects exactly the steps that ran.

### Reloading, and what happens to your edits

**File ▸ Reload from disk** (`Ctrl+Alt+R`, or the **Kratos Mesh: Reload from
Disk** command) re-reads the file. So does an external change to it — the
preview watches the file — and, for a `.mdpa`, saving it in a text editor.

**Your edits survive all of that.** The history is re-applied to the new
contents rather than thrown away, so a colleague regenerating the mesh, or a
solver appending a time step, no longer silently costs you an afternoon's work.
Two things are worth knowing about how that goes:

- **An operation that no longer applies is kept, not dropped.** If the file
  changed such that an op has nothing to do — you deleted a SubModelPart that
  is already gone — the op stays in the list marked `no effect`, with its own
  explanation as the tooltip, and the operations after it still run. Nothing is
  destroyed, so you can revert to before it or clear it yourself.
- **Stepping a VTK time series skips the expensive operations.** Geometric ops
  (scale, crop, refine, delete part, …) follow you from frame to frame, but the
  remeshing and meshio++-backed ones (MMG remesh, level-set split, smooth,
  reorder, partition, merge, field gradient) are marked `skipped` rather than
  re-run — a 30-second remesh firing on every arrow-key press would make the
  timeline unusable. **Re-apply skipped operations**, which appears in the Edit
  section whenever there is something to re-run, runs them on the current frame.

::: tip
The history still belongs to the loaded mesh, so opening a *different* file
starts fresh. **Save operations…** remains the way to carry a recipe between
meshes.
:::
