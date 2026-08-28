# GiD Postprocess Files

GiD is the reference pre/post-processor for Kratos Multiphysics, and its
postprocess format opens directly in the mesh preview — geometry, results and
time steps — since meshio++ 10.19.0. Export writes it too.

## The four extensions

| File | What it is |
|---|---|
| `.post.msh` | the geometry, ascii |
| `.post.res` | the results for that geometry, ascii — the sibling of the above |
| `.post.bin` | geometry + results in one deflated binary file |
| `.post.h5` | geometry + results in one HDF5 file |

The ascii flavour is a **pair**, and you can open **either half**. Opening
`case.post.res` on its own still shows a mesh: the results file carries no
coordinates, so its `case.post.msh` sibling is loaded alongside it
automatically. The same happens in reverse, which is why a `.post.msh` opened
by itself already has its fields.

## Why the extension is the whole `.post.msh`

These are the only **compound** extensions the preview handles, and they are a
genuine trap rather than a curiosity: three different formats hide behind
overlapping suffixes.

| Path | Format |
|---|---|
| `case.post.msh` | GiD postprocess |
| `case.msh` | Gmsh |
| `case.post` | PERMAS |

The preview resolves the **longest** matching suffix first, so all three land on
the right reader. If you have been renaming GiD files to `.msh` to get them to
open, you no longer need to — and should not, since that spelling genuinely means
Gmsh.

## Time steps

A GiD results file can hold many steps, and they drive the same timeline bar at
the bottom of the viewport that a Kratos VTK output series does — play, scrub and
step through them.

The mechanism differs from the VTK case in a way worth knowing if you are
producing the files: a VTK series is **many files** named
`<prefix>_<rank>_<step>.vtu`, while a GiD series is **one file** whose steps are
recorded in the `.post.res` headers. The preview reads just those headers to size
the timeline, so a long results file does not have to be parsed in full before
the first frame appears.

## Exporting

**File ▸ Export ▸ Solvers ▸ GiD postprocess** writes the ascii flavour. Because
that flavour is a pair, picking `case.post.msh` writes **two** files:
`case.post.msh` and `case.post.res` beside it. This is the same behaviour as
exporting `.xdmf` (which writes a companion `.h5`) or `.foam` (which writes a
whole `constant/polyMesh/` directory).

Only the ascii flavour is offered on export. The binary and HDF5 flavours are the
same format written differently rather than different formats, so listing all
three would put one format in the menu three times — the reason only `.exo`
appears for Exodus while `.e` and `.ex2` are read-only aliases.

## What survives

Nodes, cells and both nodal and elemental fields round-trip. GiD's postprocess
format has **no node-set or element-set concept at all** — its only grouping is
the material column — so SubModelParts do not survive an export to it. If you
need groups to cross, MED and Abaqus carry them; see the format table in the
README for what each one preserves.
