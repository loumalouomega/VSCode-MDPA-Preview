# Example files

Small hand-made meshes covering every format the preview can open.
Right-click any of them → **Open VTK Preview** (or **Open MDPA Preview** for
`.mdpa`).

| Folder | Contents |
|---|---|
| `MDPA/` | Kratos `.mdpa` model parts |
| `VTK/` | Kratos legacy VTK output: an ASCII time series with submodelparts (`Main_*`), plus a **binary** legacy file (`house_binary.vtk`) |
| `VTK-XML/` | The XML formats: `house.vtu` (ascii), `house_compressed_appended.vtu` (zlib-compressed appended data), `outline.vtp`, `volume.vti`, `sheet.vts`, `grid.vtr`, and a Kratos-style time series `Series_0_<step>.vtu` with an `Apex` subpart (open any `Series_*` file to get the timeline bar) |
| `VTK-XML/multiblock/` | `scene.vtm` referencing two `.vtu` blocks — each block appears as a layer |
| `Geometry/` | Surface meshes: `pyramid.stl` (binary), `pyramid_ascii.stl`, `hut.obj`, `roof.ply` (binary, with a per-vertex `quality` field) |

The `.vtu`/`.vtk` "house" meshes carry a nodal `TEMPERATURE` field — press
**Field** in the toolbar to color by it.
