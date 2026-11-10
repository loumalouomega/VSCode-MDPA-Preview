# Symmetry Views

Many Kratos models are solved on a half, a quarter, a sector or a 2D axisymmetric section.
The symmetry views expand such a result into the whole part for display.
They are view-only: nothing is written, the operation history is untouched, and Save and Export still use the mesh you opened.

All three live in the **View ▾** menu and as command-line commands (`mirror`, `revolve`, `sector`), and they are saved in the view sidecar so a reopened mesh comes back with the same expansion.
They are mutually exclusive, and Clip, Slice, Inspect, the Field panel and the timeline act on the expanded view.
Picking a copy shows the id of the source entity it came from.

## Mirror

Reflects the mesh about a plane.
Nodes on the plane are shared, so a symmetric half-plate becomes one connected plate.
Vectors flip their normal component and 3×3 tensors reflect as `R T Rᵀ`; other field widths are copied unchanged and reported.
Linear and quadratic cells are re-wound so the copy keeps positive volume, with mid-edge and face-centre nodes following their edge or face.
Every SubModelPart also gains a `<name>_mirror` copy that holds the mirrored nodes and entities.
The **Mirror view** item mirrors about the x-min plane; the **Mirror plane** rows below it pick the minimum, maximum or centre of the bounding box on any axis, and the command line takes `mirror axis= side=` or `at=`; `mirror off` turns it off.

## Revolve

Sweeps a planar xy axisymmetric mesh (r ≥ 0) about the x or y axis, with a start angle, a sweep and a number of layers.
Triangles become wedges and quads become hexahedra; cells touching the axis degenerate to wedges, tetrahedra or pyramids.
Vectors and tensors are rotated for each layer.

## Sector repeat

Repeats the mesh `copies` times about an axis, every `angle` degrees.
Axis nodes are shared; seam nodes are not welded.

## Explode by SubModelPart

View ▾ ▸ Explode by SubModelPart moves every top-level SubModelPart away from the model centre along the line to its own centre.
A cell belongs to the first top-level part that lists it; cells in no part stay where they are.
Nodes shared between parts are duplicated in the drawing only, so the mesh, its node count and any saved file are unchanged.
At factor 1 the parts' bounding boxes just stop overlapping; the command `explode factor=1.5 axis=z` changes the factor or restricts the movement to one axis, and `explode off` restores the view.
Two parts with the same centre cannot be separated and are reported.
Measure is refused while the view is exploded, because distances between parts are no longer real.
The view is exclusive with Mirror, Revolve and Sector repeat and is stored in the view sidecar like them.

## Not in the view

Welding of seam nodes is not done yet, and mirrored SubModelParts exist only for the Mirror view (each part gains a `_mirror` copy).
For a written, expanded mesh use `mesh_derive` with the `mirror` or `revolve` kind.
