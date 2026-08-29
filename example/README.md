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
| `MDPA/portal_frame.mdpa` | A 1D frame — beams, trusses and a line condition — whose `Properties` declare `CROSS_AREA`. Open it to see the **beam rendering**: line elements draw as tubes sized by their section, while the boundary condition stays a plain line. Advanced ▸ **Beams…** |
| `exodus/` | `DCBmodel_PD_solid.e` — a real peridynamics Exodus file (504 one-node `SPHERE` particles, no `RADIUS` attribute, ten time steps): open it, then try the **Spheres** panel in the Advanced menu to see the constant-radius fallback render. Not synthetic — see its own README for provenance and licence |
| `problemtypes/` | **Python problemtype examples** — faithful ports of the three built-ins (Structural / Fluid / Convection-Diffusion) showing the Python authoring API; see its own README for how to enable them |

The `.vtu`/`.vtk` "house" meshes carry a nodal `TEMPERATURE` field — press
**Field** in the toolbar to color by it.
