# MMG Remesh & Level-set

The **Mesh Modification** section runs the [MMG](https://www.mmgtools.org/)
remeshers in-process via the
[`@loumalouomega/mmg-wasm`](https://www.npmjs.com/package/@loumalouomega/mmg-wasm)
WebAssembly build (MMG v5.8.0) — **no native binaries**. Both operations join the
[operation history](./mesh-editing#operation-history) like any other edit.

::: warning
MMG is tetrahedron / triangle based. **Hexahedral, pyramid, and quadratic meshes
are rejected** with a message. Use it on tet volumes or triangulated surfaces.
:::

## Module auto-selection

The right MMG module is chosen automatically from the mesh (and can be overridden
under **Advanced**):

| Mesh | Module |
|---|---|
| Tetrahedral volume (+ pass-through prisms, boundary triangles / quads / edges) | **mmg3d** |
| Non-planar triangulated surface | **mmgs** |
| Planar triangulation (+ quads) | **mmg2d** |

## Remesh

![The Remesh (MMG) form with its mode selector and Advanced tuning sub-form](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/mmg-remesh.png)

Three modes:

- **size × factor** — the one-knob refine / coarsen: each node gets a metric
  equal to its current local edge size times your factor (`0.5` → twice as fine,
  `2` → twice as coarse).
- **uniform** — remesh to a constant target edge size (`hsiz`).
- **optimize** — size-preserving quality optimization (`IPARAM_optim`).

The **Advanced** sub-form exposes MMG's tuning surface:

- `hmin` / `hmax` — size bounds.
- `hausd` — Hausdorff distance controlling geometry approximation. Defaults to
  **0.5 % of the bounding-box diagonal** (MMG's own default is the absolute value
  `0.01`, which explodes on large domains).
- `hgrad` — size gradation (how fast element size may change).
- **angle detection** threshold in degrees (≤ 0 disables ridge detection).
- **keep surface** (`nosurf`) / **no insert** / **no swap** / **no move**
  toggles.

## Level-set split

**Level-set split (MMG)** discretizes an isovalue of any **nodal field** as an
explicit, conforming boundary. Pick the field (vector fields use their magnitude)
and the isovalue; the mesh is split into `MMG_Domain_Inside` /
`MMG_Domain_Outside` blocks separated by an `MMG_Interface` layer.

![Level-set split: the mesh divided into inside / outside domains and an interface, each a SubModelPart](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/levelset-split.png)

Each created region is **also generated as a SubModelPart** of the same name, so
the domains and the interface appear in the outline's SubModelParts section —
ready to be [isolated](./viewer-outline#the-outline-tree-layers), exported, or
deleted, and written as real `Begin SubModelPart` blocks on save. On volume
meshes, **surface only** (`IPARAM_isosurf`) splits just the boundary surfaces.
Its own **Advanced** sub-form exposes the same `hmin` / `hmax` / `hausd` /
`hgrad` size controls and module override.

### Keeping your blocks and SubModelParts

By default a split throws your mesh's own structure away: MMG rewrites every
domain cell to its reserved inside/outside references, so the result is two
`MMG_Domain_*` blocks and the original block names and SubModelPart membership
are gone.

**Keep materials** (in the *Materials & base references* sub-form) turns that
off. Each split cell goes back into its **original block** and its **original
SubModelParts**, and the side is carried by the generated `MMG_Domain_Inside` /
`MMG_Domain_Outside` SubModelParts instead — so a part like `Lower` survives the
split, and both sides stay separately selectable in the outline. It is off by
default because it changes the shape of the output, and a saved
[recipe](./mesh-editing#operation-history) replayed after enabling it produces a
differently-shaped mesh than when it was recorded.

**No-split blocks / parts** name materials the level set must leave uncut: they
keep their own block untouched and appear in neither side part. MMG needs the
whole material list, so this chooses which materials are *left alone*, not which
are preserved — and marking every material no-split is refused, since there
would be nothing left to cut.

::: tip What does not survive
Kratos `Properties` are still dropped, as they are by any remesh — "material" here
means the block and SubModelPart structure, not the property table.
:::

**Keep materials does not apply to a surface only split** and is skipped with a
message there: that mode splits the boundary rather than the volume, so it leaves
the domain references untouched and your blocks and SubModelParts already survive
without it.

### Cleaning up parasitic components

**rmc** deletes split components whose volume fraction of the mesh falls below
it — the small detached blobs an
[Distance to surface](./mesh-editing#distance-to-surface) → level-set chain
tends to leave behind. It must be between 0 and 1; MMG's own default when
enabled is `1e-5`. Choose it with care: MMG range-checks nothing, and a value
above a real domain's volume fraction deletes that whole domain. It is not
implemented for **surface only** splits and is skipped there with a message.

**Base reference blocks / parts** name **boundary** entities that a split domain
must touch in order to survive; any domain attached to none of them is removed.
This is a topological cleanup where `rmc` is a size-based one, and it is inert on
its own — giving base references without `rmc` enables it at `1e-5`. A selector
that matches nothing, or that names only volume cells, warns and is skipped
rather than failing the run.

## What survives a remesh

- **Element / condition / geometry blocks** keep their names — every cell is
  tagged with an MMG reference encoding its block + SubModelPart membership, and
  the output is regrouped from those references.
- **SubModelParts** are rebuilt the same way (their node lists become the
  connectivity closure of their surviving cells).
- **Nodal / elemental data cannot follow a remesh** — the fields are dropped and
  the result message says so. Node and entity ids are freshly renumbered.

## Live progress & cancellation

MMG runs in a **worker thread**, so the editor never freezes during a long
remesh. Press the form's **▶ play button** to start: an **inline loading bar**
just below streams MMG's live output — the analysis and meshing phases,
gradation, and split / collapse / swap counters — while the play button turns
into a **■ stop button** that cancels the run immediately, leaving the mesh
unchanged.

Because the operations are deterministic, remesh steps saved in a
[JSON recipe](./mesh-editing#operation-history) re-run MMG exactly when the recipe
is replayed, and undo is instant (the result is snapshotted).
