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
