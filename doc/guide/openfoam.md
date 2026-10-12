# OpenFOAM Cases

An OpenFOAM case is a **directory**, not a file: the mesh lives in `<case>/constant/polyMesh/`. The extension reads and writes one.

## Opening a case

Open the case's **`.foam` marker** — the empty `<case>/something.foam` file that ParaView also uses. VS Code editors bind to files, not folders, so the marker is the handle:

```
cavity/
  cavity.foam          ← open this
  constant/polyMesh/
    points  faces  owner  neighbour  boundary
```

If your case has no marker, create an empty file with any name and a `.foam` extension next to `constant/`. Nothing reads its contents.

A case exported from this extension already has one.

## What you get

- The **volume cells** as Elements.
- The **boundary faces** as Conditions.
- One **SubModelPart per boundary patch**, named as `constant/polyMesh/boundary` names it — `inlet`, `outlet`, `movingWall`. This is what lets you assign boundary conditions in the [Problemtype](./simulation) section; without the names the boundary would be one anonymous surface.

`points.gz`, `faces.gz` and friends are decompressed automatically, so a case written with `writeCompression on` opens normally.

While the preview is open it **watches `constant/polyMesh/`** for mesh changes and the **time directories** for new steps and field edits, so re-running `blockMesh` or advancing a solver refreshes the view in place.

## Time-directory fields and the timeline

Numeric time directories (`0`, `0.5`, `1e-3`, …) are listed as the timeline: the preview's timeline bar scrubs them, **Plot over time** samples them, and `mesh_field_series` reads them headless. Each step shows the selected directory's fields over the selected mesh:

- `volScalarField` / `volVectorField` / `volTensorField` / `volSymmTensorField` arrive as **Elemental** fields; `pointScalarField` / `pointVectorField` as **Nodal** fields.
- `internalField uniform ...` and `nonuniform List<...>` are read (plain or `.gz`); an explicit uniform `boundaryField` patch value arrives as a **Conditional** field of the same variable.
- The field file's **`dimensions [..]`** vector (kg m s K mol A cd) is kept on the field. Field pickers, the scalar bar, capture legends and the CSV headers of the data table, time series and probe line then carry the unit (`p [m²/s²]`, `p_Pa [Pa]`). A file with no `dimensions` line leaves the field's units **unknown** — never guessed from its name — and its headers are unchanged. Comparing two fields whose dimensions are both known and different is refused; convert one first with **Kinematic pressure → Pa** (see [Mesh editing](./mesh-editing.md)), which takes an explicit density or density field. Export writes each field's recorded dimensions back, and `[0 0 0 0 0 0 0]` only for a field whose units are unknown.
- Binary fields, `#include`/coded/substituted content, surface fields and nonuniform patch values are skipped with a warning — the geometry still opens.
- A directory whose `<time>/polyMesh` exists overlays its files over `constant/polyMesh` for its own step (a moving mesh commonly overrides only `points`); otherwise every step shares the constant mesh.

Headless, `mesh_info` reports the selected step's fields plus every available time value, and `timeStep` selects one (0 is the first, negative counts back from the last).

## Zones, regions and decomposed cases

- **Zones.** `cellZones`, `faceZones` and `pointZones` become SubModelParts, like the boundary patches.
- **Multi-region cases.** A case with no top-level `constant/polyMesh` but one `constant/<region>/polyMesh` per region opens with **every region merged**. Each region is a top-level SubModelPart named after it, with its patches as children. A field present in several regions (say `T` in both `fluid` and `solid`) arrives as one field spanning them. Headless, `region` selects a single region instead.
- **Decomposed cases.** A case written by `decomposePar` (`processorN/constant/polyMesh` plus the `*ProcAddressing` files) is reconstructed into one mesh, and patch names are taken from `processor0`'s boundary. Fields under `processorN/<time>/` are **not** reconstructed; the Information panel says so. Run `reconstructPar` first if you need them.

If `constant/polyMesh/boundary` is missing, the mesh loads with **no boundary faces at all**, because that file is what defines them. `points`, `faces` and `owner` are required; if one is missing, the open fails and names it.

## Saving and exporting

**Save writes back into a single-region case, but only the files it can own.** The file you opened is an empty marker and the mesh is in sibling files, so Save compares your model with the case as it is on disk and lists exactly which files it will write before it does. Every other file in the case (`system/`, the rest of `constant/`, other time directories, `faceZones`, …) is left byte-for-byte as it was, and nothing is ever deleted. There are two cases.

- **Only geometry or field values changed** (translate, scale, rotate, smooth, a computed field). Save rewrites just `constant/polyMesh/points` — a point you did not move keeps its original text — and, for an edited field, only the `internalField` entry of that field's file in the time directory on screen, so its `dimensions` and real `boundaryField` survive. A field that has no file yet is written new, with `zeroGradient` on every patch. Nothing keyed by cell, face or point number can go stale, so zones, sets and the other time directories all stay valid.
- **The mesh topology changed** (refine, crop, remesh, renumber, a patch rename). Save rewrites the six polyMesh files, which renumbers things, so it **refuses by file name** when anything else in the case is keyed by the old numbering: `faceZones`, `pointZones`, `sets/`, `cellLevel`, `pointLevel`, `refinementHistory`, `surfaceIndex`, a moving-mesh `<time>/polyMesh`, and any time-directory field holding a `nonuniform` list. A case with polyhedral cells is refused too, because those are decomposed into tetrahedra on read. Remove or regenerate the named files yourself, or use Export.

Patch types that need extra keys, such as `cyclic` (`neighbourPatch`, `transform`, `inGroups`, …), now keep those keys when the boundary file is rewritten. A multi-region or decomposed case is still refused, naming `constant/<region>` or `processorN`, because the writer produces only a single `constant/polyMesh`.

Use **Export ▸ Solvers ▸ OpenFOAM** or **Save As…** to write a *new* case directory instead. Exporting into the same directory under a different `.foam` name is refused too — it is the same `constant/polyMesh`, and only Save may rewrite it.

An exported case also gets a `0/<VAR>` file for each Elemental field that covers every volume cell (`volScalarField`, `volVectorField` or `volTensorField` by component count, with `zeroGradient` on every patch). A field that covers only part of the mesh is skipped and named in a warning. Each file keeps its field's recorded dimensions, and `[0 0 0 0 0 0 0]` is written only for a field whose units are unknown.

Exporting to any other format (`.mdpa`, `.vtu`, …) is unrestricted. A problem archive bundles the marker plus `constant/polyMesh/`, so File ▸ Save problem works on a case directly.

## Headless

`mesh_info`, `mesh_convert`, `mesh_transform` and `mesh_field_series` all take a `.foam` marker path like any other mesh. `mesh_transform` without `outputPath` and `mesh_convert` onto its own input are the in-place save and follow the same rules and refusals as Save; any other write into the case (a different `.foam` name beside it, a sub-part or derived export, a batch output) is refused. For a multi-region case, `mesh_info` and `mesh_convert` take `region` to read one region instead of all of them. `mesh_info` reports the patch SubModelParts, the selected step's fields and every available time value, and re-reads correctly after `blockMesh` reruns or a solver rewrites a field — its freshness is keyed on the polyMesh and time-directory files, not on the marker, which never changes.
