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

While the preview is open it **watches `constant/polyMesh/`** for mesh changes
and the **time directories** for new steps and field edits, so re-running
`blockMesh` or advancing a solver refreshes the view in place.

## Time-directory fields and the timeline

Numeric time directories (`0`, `0.5`, `1e-3`, …) are listed as the timeline:
the preview's timeline bar scrubs them, **Plot over time** samples them, and
`mesh_field_series` reads them headless. Each step shows the selected
directory's fields over the selected mesh:

- `volScalarField` / `volVectorField` / `volTensorField` /
  `volSymmTensorField` arrive as **Elemental** fields; `pointScalarField` /
  `pointVectorField` as **Nodal** fields.
- `internalField uniform ...` and `nonuniform List<...>` are read (plain or
  `.gz`); an explicit uniform `boundaryField` patch value arrives as a
  **Conditional** field of the same variable.
- Binary fields, `#include`/coded/substituted content, surface fields and
  nonuniform patch values are skipped with a warning — the geometry still
  opens.
- A directory whose `<time>/polyMesh` exists overlays its files over
  `constant/polyMesh` for its own step (a moving mesh commonly overrides only
  `points`); otherwise every step shares the constant mesh.

Headless, `mesh_info` reports the selected step's fields plus every available
time value, and `timeStep` selects one (0 is the first, negative counts back
from the last).

## What is not read

The reader takes the mesh and nothing else. Each of these is reported as a
warning in the Information panel rather than silently omitted:

| Not read | What it means |
|---|---|
| `cellZones`, `faceZones`, `pointZones` | Zones do not cross the reader; only boundary patches become SubModelParts. |
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

`mesh_info`, `mesh_convert`, `mesh_transform` and `mesh_field_series` all take a `.foam` marker path
like any other mesh. `mesh_info` reports the patch SubModelParts, the selected
step's fields and every available time value, and re-reads correctly after
`blockMesh` reruns or a solver rewrites a field — its freshness is keyed on the
polyMesh and time-directory files, not on the marker, which never changes.
