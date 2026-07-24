# Getting Started

**Kratos MDPA Preview** is a VS Code extension that renders Kratos Multiphysics
`.mdpa` model-part files — and VTK / mesh output (`.vtk`, `.vtu`, `.vtp`,
`.vti`, `.vts`, `.vtr`, `.vtm`, `.stl`, `.obj`, `.ply`), plus ~26 further
formats via meshio++ (`.msh`, `.inp`, `.unv`, `.bdf`, `.mesh`, `.vol`, `.su2`,
`.xdmf`, …) — as an interactive 3D mesh with a navigable ModelPart /
SubModelPart outline, mesh-quality metrics, field plotting, and in-place mesh
editing.

It is fully self-contained: a pure-TypeScript parser feeds a
[VTK.js](https://kitware.github.io/vtk-js/) viewer running in a webview. **No
Python or compiled Kratos is required.**

![The MDPA preview: 3D mesh, ModelPart / SubModelPart outline, stats, and toolbar](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/preview-overview.png)

## Requirements

- VS Code `1.84.0` or newer (or any compatible editor: VSCodium, code-server,
  Cursor, …).

## Install

Install **Kratos MDPA Preview** from the VS Code Marketplace:

- In VS Code, open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`),
  search for **Kratos MDPA Preview**, and click **Install**.
- Or install it directly from the
  [Marketplace page](https://marketplace.visualstudio.com/items?itemName=kratos-multiphysics.vscode-mdpa).

## Supported formats

| Family | Extensions | Notes |
|---|---|---|
| Kratos model part | `.mdpa` | nodes, elements, conditions, geometries, SubModelParts, `NodalData` / `ElementalData` / `ConditionalData` |
| Legacy VTK | `.vtk` | ASCII **and** binary (big-endian) unstructured grids |
| VTK XML | `.vtu`, `.vtp`, `.vti`, `.vts`, `.vtr` | ascii, inline base64, appended raw/base64, zlib-compressed |
| VTK multiblock | `.vtm` | referenced blocks merge into one scene; each block becomes a layer |
| Surface meshes | `.stl`, `.obj`, `.ply` | STL ascii + binary, OBJ groups, PLY ascii + binary with per-vertex fields |
| Extended (meshio++) | `.msh`, `.inp`, `.bdf` / `.nas` / `.fem`, `.unv`, `.mesh`, `.vol`, `.su2`, `.xdmf` / `.xmf`, `.off`, `.dat` / `.tec`, `.avs`, `.f3grid`, `.pf3`, `.mfm`, `.mphtxt`, `.post` / `.dato`, `.ugrid`, `.wkt`, `.xml`, `.node` / `.ele` | 36 formats via [`@meshioplusplus/wasm`](https://www.npmjs.com/package/@meshioplusplus/wasm) (MIT) |
| HDF5 containers (meshio++) | `.cgns`, `.h5m`, `.hmf`, `.med` | `.med` is read-only |

Kratos time-series output (one file per model-part per step) is detected and
grouped automatically — see [Time-series Playback](./timeline).

## Open a preview

The raw text editor stays the **default** for `.mdpa` and mesh files, so opening
a file shows its text. Open the 3D preview in any of these ways:

- **Editor-title button** — with a `.mdpa` (or supported mesh) file open, click
  the preview button in the editor toolbar.
- **Explorer context menu** — right-click a file and choose **Open MDPA
  Preview** / **Open VTK Preview**.
- **Command Palette** — run **Kratos MDPA: Open MDPA Preview** or **Kratos VTK:
  Open VTK Preview** (`Ctrl+Shift+P` / `Cmd+Shift+P`).

See [Opening a Preview](./opening-a-preview) for a full tour of the window.

## Next steps

- [Opening a Preview](./opening-a-preview) — the window, toolbar, sidebar, and
  stats at a glance.
- [The 3D Viewer & Outline](./viewer-outline) — how the mesh is drawn and how
  layers work.
- [Mesh Quality](./mesh-quality), [Field Visualization](./field-visualization),
  [Mesh Editing & History](./mesh-editing),
  [MMG Remesh & Level-set](./mmg-remeshing),
  [Navigation & Orientation](./navigation) — the feature set.
- [VTK / Mesh Preview](./vtk-preview) and
  [Time-series Playback](./timeline) — the other formats.
- [Development](./development) — building the extension from source.
