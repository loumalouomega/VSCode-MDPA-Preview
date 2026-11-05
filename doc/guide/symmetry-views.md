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

## Not in the view

Welding of seam nodes is not done yet, and mirrored SubModelParts exist only for the Mirror view (each part gains a `_mirror` copy).
For a written, expanded mesh use `mesh_derive` with the `mirror` or `revolve` kind.
