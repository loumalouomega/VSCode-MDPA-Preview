# VTK / Mesh Preview

The same viewer opens every common VTK-family and surface-mesh format. All of the
feature set — [outline & layers](./viewer-outline), [mesh quality](./mesh-quality),
[field visualization](./field-visualization),
[editing & history](./mesh-editing), [MMG remeshing](./mmg-remeshing),
[navigation](./navigation) — works here too; point / cell data arrays from any
format appear in the **Field** panel.

## Supported formats

| Format | Extensions | Notes |
|---|---|---|
| Legacy VTK | `.vtk` | ASCII **and** binary (big-endian) unstructured grids |
| VTK XML | `.vtu`, `.vtp`, `.vti`, `.vts`, `.vtr` | ascii, inline base64, appended raw / base64, zlib-compressed |
| VTK multiblock | `.vtm` | referenced blocks merge into one scene; each block becomes a layer |
| Surface meshes | `.stl` (ascii + binary), `.obj`, `.ply` (ascii + binary) | STL vertices are welded; OBJ `g` / `o` groups become named layers; PLY vertex properties become fields |
| Extended (meshio++) | `.msh` (Gmsh), `.inp` (Abaqus), `.bdf` / `.nas` / `.fem` (Nastran), `.unv`, `.mesh` (Medit), `.vol` (Netgen), `.su2`, `.xdmf` / `.xmf`, `.off`, `.dat` / `.tec` (Tecplot), `.avs`, `.f3grid`, `.pf3`, `.mfm`, `.mphtxt` (COMSOL), `.post` / `.dato` (PERMAS), `.ugrid`, `.wkt`, `.xml` (DOLFIN), `.node` / `.ele` (TetGen) | Read through [`@meshioplusplus/wasm`](https://www.npmjs.com/package/@meshioplusplus/wasm). Ambiguous extensions are resolved by content: `.msh` tries Gmsh then ANSYS / FreeFem, `.inp` tries Abaqus then ANSYS. TetGen reads its `.node` / `.ele` pair together |
| HDF5 / netCDF containers (meshio++) | `.cgns`, `.h5m` (MOAB), `.hmf`, `.med` (Salome), `.e` / `.exo` / `.ex2` (Exodus II) | Need a meshio++ >= 8.0.0 build (Exodus >= 9.3.0 for particle meshes). `.med` is read-only: its WebAssembly writer rejects a mesh carrying data arrays. Exodus can be written but lossily — SubModelParts and time steps do not survive it. Exodus carries its own [in-file time series](./timeline), and its `SPHERE` elements render as [spheres](./sphere-elements). An `.xdmf` using HDF storage is opened together with its companion `.h5` |

Open any of them from the explorer context menu (**Open VTK Preview**), the
editor-title button, or the **Kratos VTK: Open VTK Preview** command.

## Multiblock (`.vtm`)

![A .vtm multiblock scene: each referenced block loaded as its own colored layer](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/multiblock.png)

A `.vtm` index references child datasets by slash-path; the extension merges them
into one scene (node / entity ids offset per block), prefixes each block's name,
and emits one SubModelPart per dataset — so every block is an independently
toggleable layer. Paths that try to escape the `.vtm` directory are rejected.

## Surface meshes

![An OBJ surface mesh whose g-groups (Roof, Floor) load as separate named layers](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/surface-mesh.png)

- **STL** — ascii and binary, with a byte-size cross-check (binary headers may
  start with `solid`); vertices are welded on a 6-decimal coordinate key.
- **OBJ** — `v` / `f` (slash forms, negative indices, fans) / `l` / `p`, with
  `g` / `o` groups becoming named blocks.
- **PLY** — ascii and binary (LE / BE); extra numeric vertex properties become
  Nodal fields (plot them via **Field**), and `edge` elements become line cells.

Surface formats always open as a single static view (no timeline).

## Kratos time series

Kratos writes one VTK file per model-part per time step (e.g. `Main_0_2.vtk`,
`Main_FixedEdgeNodes_0_4.vtk`). Open any file in such a series and the extension
detects the pattern and loads the whole series with a scrubber — see
[Time-series Playback](./timeline).

## SubModelpart tree

The sidebar shows the same [layer tree](./viewer-outline) as the MDPA preview. The
root model-part file provides the full mesh; each submodelpart file (e.g.
`FixedEdgeNodes`, `MovingNodes`) appears as a hidden-by-default overlay layer you
can toggle independently. Node-only submodelparts are rendered as vertex points.

## Known limitations

- MPI rank > 0 files are not merged in this release (rank-0 files are loaded).
- Submodelpart merging uses coordinate matching (`toFixed(6)`); if the root and
  subpart files were written at different float precision the merge may miss
  nodes (a diagnostic is emitted in the sidebar stats).

## Named groups become SubModelParts

Formats that carry named groups deliver them straight into the outline tree as
SubModelParts — gmsh physical groups, Abaqus `*NSET` / `*ELSET` / `*SURFACE`,
and every other group meshio++ recognizes. They behave exactly like a
`.mdpa` SubModelPart: toggle, frame, rename, delete, or export one on its own.

A group of *cell facets* (an Abaqus `*SURFACE`, an Exodus side
set) is materialized into real boundary facets emitted as **Conditions**, so
the surface is a layer you can see rather than a list of indices — and
exporting to `.mdpa` produces genuine Kratos Conditions.
