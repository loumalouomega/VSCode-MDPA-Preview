# OpenFOAM Cases

An OpenFOAM case is a **directory**, not a file: the mesh lives in
`<case>/constant/polyMesh/`. The extension reads and writes one.

## Opening a case

Open the case's **`.foam` marker** — the empty `<case>/something.foam` file that
ParaView also uses. VS Code editors bind to files, not folders, so the marker is
the handle:

```
cavity/
  cavity.foam          ← open this
  constant/polyMesh/
    points  faces  owner  neighbour  boundary
```

If your case has no marker, create an empty file with any name and a `.foam`
extension next to `constant/`. Nothing reads its contents.

A case exported from this extension already has one.

## What you get

- The **volume cells** as Elements.
- The **boundary faces** as Conditions.
- One **SubModelPart per boundary patch**, named as `constant/polyMesh/boundary`
  names it — `inlet`, `outlet`, `movingWall`. This is what lets you assign
  boundary conditions in the [Problemtype](./simulation) section; without the
  names the boundary would be one anonymous surface.

`points.gz`, `faces.gz` and friends are decompressed automatically, so a case
written with `writeCompression on` opens normally.

While the preview is open it **watches `constant/polyMesh/`**, so re-running
`blockMesh` or `snappyHexMesh` refreshes the view in place.

## What is not read

The reader takes the mesh and nothing else. Each of these is reported as a
warning in the Information panel rather than silently omitted:

| Not read | What it means |
|---|---|
| Time-directory fields (`0/U`, `0/p`, …) | A case opens as **geometry only** — there are no result fields to colour by. |
| `cellZones`, `faceZones`, `pointZones` | Zones do not cross the reader; only boundary patches become SubModelParts. |
| `<time>/polyMesh` | A moving mesh shows its `constant/` state only. |
| `constant/<region>/polyMesh` | A multi-region case shows the top-level mesh only. |
| `processor*/` | A decomposed case shows only `constant/polyMesh`; reconstruct it first. |

If `constant/polyMesh/boundary` is missing, the mesh loads with **no boundary
faces at all** — that file is what defines them. `points`, `faces` and `owner`
are required; without one the open fails naming the missing file.

## Saving and exporting

**Save is refused for a case, deliberately.** The file you opened is an empty
marker while the mesh is in sibling files, so saving "the file" would rewrite
`constant/polyMesh/` underneath the preview. Two things would be lost:

- **Patch names.** The writer emits one synthesized `defaultFaces` patch, so
  `inlet`/`outlet` would collapse into it.
- **Zones**, which were never read and so cannot be written back.

Use **Export ▸ Solvers ▸ OpenFOAM** or **Save As…** to write a *new* case
directory instead. Exporting into the same directory under a different `.foam`
name is refused too — it is the same `constant/polyMesh`.

Exporting to any other format (`.mdpa`, `.vtu`, …) is unrestricted, and is the
route to using a case in a Kratos problem: a problem archive cannot bundle a
case directory, so convert it first.

## Headless

`mesh_info`, `mesh_convert` and `mesh_transform` all take a `.foam` marker path
like any other mesh. `mesh_info` reports the patch SubModelParts, and re-reads
correctly after `blockMesh` reruns — its freshness is keyed on the polyMesh
files, not on the marker, which never changes.
