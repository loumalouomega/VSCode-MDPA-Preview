# Changelog

All notable changes to the **Kratos MDPA Preview** VS Code extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.8.0] - 2026-07-28

- **10 new mesh operations** in the **Mesh Modification** sidebar, `mesh_transform` and the `mergeMesh` file picker's `mesh_extract_skin`/`kratos.mesh.exportSkin` sibling — a survey of what the bundled meshio++ WASM offers, kept native wherever the extension already does the job (`transform`, `clean`, `convertCells "elevate"`, `attachQuality`, `stats`, `isosurface`, `split by regions` and `dataInfo` were all ruled out that way):
  - **Smooth** (Taubin/Laplacian, with boundary/feature pinning and an inversion guard), **Reorder** (RCM bandwidth reduction, or Morton/Hilbert space-filling curves), and **Partition** (space-filling-curve domain decomposition into an Elemental `PARTITION_INDEX`, optionally with per-part SubModelParts) all use meshio++ strictly as an **oracle**: it computes a result whose shape survives losslessly (moved coordinates, a node permutation, a label array), which is then applied onto the extension's own mesh — its SubModelParts, ids, entity kinds and material assignments are never round-tripped through meshio++'s own (and, verified while researching this, quite lossy) mesh representation
  - **Refine** (uniform tri/quad/tet/hex/wedge/line subdivision, up to 4 levels, with exact field interpolation and no hanging nodes), **Quadratic → Linear** (the missing inverse of Convert Linear → Quadratic), **Simplexify** (hex/wedge/pyramid/quad → tets/triangles), **Crop** (bounding box or plane, keep-all/keep-any), **Field calculator** + **nodal ↔ elemental averaging** (a safe formula evaluator over coordinates and existing fields — never `eval`), and **Merge mesh** (append another mesh file's nodes/cells with id offsetting and an optional coincident-node weld) are implemented natively, reusing primitives the extension already had (edge/face tables, block/field slicing, the MMG-sizing expression evaluator) rather than repairing a lossy round-trip
  - Smooth/Reorder/Partition/Merge mesh run asynchronously with the same inline progress bar and play/stop cancel button as MMG remeshing; the rest apply instantly. Every operation joins the same undoable history, JSON recipe, and `mesh_transform` MCP tool as the original op set
  - **Advanced ▸ Export skin…** (+ the `mesh_extract_skin` MCP tool) extracts the boundary of a mesh's volume cells as a standalone surface mesh — a native boundary-face walk, so SubModelParts survive it (narrowed to node membership), unlike meshio++'s own surface/skin extractors which drop every region
- **Mesh Modification, reorganized into subcategories**: with the additions above the section had grown to fourteen flat items. It is now six collapsible groups — **Element order & topology**, **Remeshing (MMG)**, **Smoothing & renumbering**, **Selection & combination**, **Fields**, **Sphere elements** — each collapsed by default, so the section reads as a short list of categories rather than a long scroll of forms
- **Toolbar cleanup**: **Mesh Size** moved from its own toolbar button into the **Advanced** menu (alongside Spheres…, Face normals and Export skin…), and the **Advanced** button itself moved to sit right after **Find**, next to **Screenshot** — the toolbar no longer grows a dedicated button for every analysis panel
- **Fixed: a popup-only Advanced-menu action's "active" highlight never worked** — `Mesh Size`'s (and, latently, `Spheres`') active-state toggle queried `#toolbar button[data-action="…"]`, but a menu item lives in the `#advanced-popup` sibling, not inside `#toolbar`, so the query always matched nothing. Both now query `[data-action="…"]` unscoped
- **Fixed: `mergeMesh`'s file picker couldn't actually merge a `.mdpa` file** — its own dialog lists `.mdpa` first, but the op read the second file through the mesh-format dispatcher that deliberately excludes `.mdpa` (parsed natively everywhere else in the extension), so picking the single most likely file silently no-opped with "Unsupported mesh file extension"

## [2.7.0] - 2026-07-27

- **SPHERE / particle element support** ([#63](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/63)): an Exodus file written by a peridynamics or DEM code failed to open outright with `Exodus: unknown element type SPHERE` — on a type meshio++ had mapped correctly all along. The cause was the *encoding*: [NetCDF.jl](https://github.com/JuliaGeo/NetCDF.jl), which PeriLab and other Julia solvers write Exodus with, counts the C string's terminating NUL in the `elem_type` attribute's length, so the value arrived as the 7 characters `"SPHERE\0"` and matched no key — and the NUL was invisible in the error message too. Fixed in meshio++ 9.3.0
  - **Particles now render as spheres.** A one-node element has no extent, so it used to draw as a fixed-size screen point that told you nothing about the discretization. The new **Spheres** toolbar button draws real sphere glyphs scaled in model space: they grow as you zoom, and neighbouring particles visibly touch or do not. A mesh carrying a `RADIUS` field switches to them automatically
  - **A radius where the file has none.** Most particle files declare no radius at all — the file from the issue has 504 `SPHERE` elements and not one Exodus attribute. The panel suggests one (half the median nearest-neighbour spacing, so a regular lattice renders as spheres that just touch) and draws every particle at it. Ordinary point clouds are left alone
  - **The radius is editable and it persists.** **Set element radius** is a normal undoable mesh operation — set an absolute value (creating the field), or *scale* existing radii without flattening their variation, optionally limited to one SubModelPart. It saves, exports, rides along in a saved recipe and a problem archive, and is reachable from the `mesh_transform` MCP tool; `mesh_info` now reports a `spheres` section so an agent can tell a radius-less particle file from a radius-carrying one
- **New: an "Advanced" toolbar menu**, for operations that are useful but not everyday, so the toolbar does not grow a button per niche feature. It opens with the sphere rendering above and:
  - **Face normals** — draws an arrow on every surface face and every boundary face of a volume mesh. This is how you find an **inverted element**: a cell's winding decides both its normal direction and the sign of its Jacobian, so a flipped cell points against its neighbours — unmistakable on screen, invisible in the statistics, and a hard error for the solver. Elements wound against a neighbour are counted and highlighted in red, with the caveat that this is a *relative* test: a uniformly inside-out mesh is self-consistent, so the arrows remain the check for global orientation
- **Exodus is now writable** (`.e`/`.exo`/`.ex2`), where it was read-only. A `RADIUS` round-trips as a genuine Exodus per-element attribute. The export is otherwise **lossy and deliberately so**: element blocks and nodal fields survive, but SubModelParts do not (the writer discards regions and synthesizes `Block N` names), a time series is flattened to a single step, and the output is NetCDF-4/HDF5 rather than classic netCDF-3. Export to `.mdpa` or `.vtu` when the grouping matters
- **Fixed: NaN from an Exodus attribute could become a real value.** meshio++ fills NaN for the blocks that do not declare an attribute, and the writers map NaN to `0` — so an unfiltered radius would have claimed every non-sphere element had radius 0. Such values are now dropped at the read boundary, and re-injected as NaN on the way back out, which is what lets a file where only some blocks carry an attribute round-trip unchanged
- **Fixed: Field ▸ Quiver drew nothing.** Building the arrow glyphs turned out to need a vtk.js rendering back end that the geometry profile does not register, so the arrows were created, added to the scene and silently never drawn — since the feature was introduced. Found while adding the sphere rendering, which is built the same way
- Upgraded to meshio++ 9.3.0 (from 8.7.0). The bundled WebAssembly grows by ~6.2 MB: since 8.8.0 the package ships a threaded build alongside the sequential one and selects it itself under Node, so both must be present — shipping only the old pair made **every** extended format fail to load with an opaque `LinkError`

## [2.6.0] - 2026-07-24

- **EXODUS II support** ([#56](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/56)): `.e`/`.exo`/`.ex2` open in the mesh preview, read-only. Requires meshio++ >= 8.6.0 — earlier builds (including 8.0.0–8.5.0, which only added the WASM HDF5/netCDF plumbing) threw on `qa_records`, a variable every file written by SEACAS, Cubit or Sierra carries, making the format unusable on anything but a synthetic test file
  - **Time steps.** A multi-step Exodus file drives the same timeline bar as a Kratos `.vtk` series, off the steps recorded *inside* the one file rather than sibling filenames — no `<prefix>_<rank>_<step>` naming needed. A solver still appending steps to the same file extends the timeline live
  - **Element blocks, node sets and side sets become SubModelParts**, through the same named-groups pipeline gmsh physical groups and Abaqus sets already use (added last release): two element blocks of the same cell type stay distinguishable rather than collapsing together, and a side set materializes as a real boundary-facet **Conditions** layer
  - `mesh_info`/`mesh_convert` gained a `timeStep` parameter; `mesh_info` reports the available `timeValues`
- **New read-only format: `.med`** (Salome). meshio++ 8.7.0 added MED field-write support for a mesh carrying exactly one data field, but writing two or more fields together — verified for every scalar+vector and point+cell combination — still fails ("field data size does not match its declared shape"), which is the common case for any real Kratos mesh, so `.med` stays read-only here
- **Fixed a silent data-loss regression**: meshio++ 8.7.0 lets ragged (polygon/polyhedron) cell blocks cross the WebAssembly boundary for the first time — previously they were rejected outright with an error. This extension's converter assumed every block was uniform (fixed node count per cell), so a ragged block silently contributed zero cells with **no diagnostic at all**, and every block's cell-index accounting after it silently shifted, corrupting named-group membership. Both are fixed: a ragged block is now skipped with a diagnostic naming its real cell count, and index accounting stays correct across it
- Upgraded to meshio++ 8.7.0 (from 8.5.0)

## [2.5.0] - 2026-07-23

- **Named groups now become SubModelParts.** Gmsh physical groups, Abaqus `*NSET`/`*ELSET`/`*SURFACE`, and every other named group meshio++ recognizes arrive in the outline tree as SubModelParts, with the usual frame / export / rename / delete actions. A **surface** group (a set of cell *facets* rather than whole cells) is materialized into real boundary-facet **Conditions**, so it is a visible layer — and exporting to `.mdpa` yields genuine Kratos Conditions. The same grouping is visible to the `mesh_info` MCP tool and sliceable with `mesh_extract_submodelpart`, which previously only worked on `.mdpa`
- **New formats**: `.cgns`, `.h5m` (MOAB), `.hmf` and `.med` (Salome) can be opened, and all but `.med` exported. `.med` is read-only because its WebAssembly writer rejects any mesh carrying data arrays
- **Fixed: an XDMF using HDF storage could not be opened at all** — the reader opens the companion `.h5` by the name written inside the XML, which was never placed alongside it. This is what ParaView writes by default
- **Fixed: exporting to `.xdmf` wrote a dangling file.** meshio++ 8.0.0 moved the heavy arrays out of the XML into a companion `<stem>.h5`; both files are now written next to each other, named after the destination
- Upgraded to meshio++ 8.5.0 (from 6.6.1). Note the bundled WebAssembly binary grows from 2.3 MB to 5.6 MB — it now statically links HDF5 and netCDF, which is what makes the formats above reachable

## [2.4.0] - 2026-07-18

- **Expression-driven remesh sizing**: a new **`size = ƒ(h)`** mode for **Remesh (MMG)** sets each node's target size from a formula of the current nodal size `h` (Kratos `NODAL_H`), the whole-mesh size statistics (`mean`, `std`, `min`, `max`, `median`, `q1`, `q3`, `iqr`) and the node coordinates `x, y, z` — for example `0.5*h`, `clamp(0.5*h, mean-1.5*std, mean+1.5*std)`, or a coordinate-graded `clamp(0.6 - 0.45*x, 0.1, 0.6)`. A collapsible **Per-part sizing** block assigns different formulas to individual SubModelParts (the statistics stay whole-mesh). The same `mode:"expr"` (`sizeExpr` + optional `sizeParts`) is reachable from the `mesh_transform` MCP tool and saved operation recipes
- Mesh-size statistics now include the population **standard deviation** (surfaced in the `mesh_size` MCP tool)

## [2.3.0] - 2026-07-18

- Added a **"What's New!"** screen that opens on startup after the extension updates, summarizing the changelog entries newer than the version you last saw (dismiss it and carry on). First installs stay silent; reopen anytime with the **Kratos MDPA: Show What's New** command, or disable the auto-popup with the `kratos.showWhatsNew` setting

## [2.2.0] - 2026-07-18

- Upgraded to meshio++ 6.6.1 (from 6.1.0), adding read support for **EnSight Gold** (`.case`/`.geo`) and **Triangle** (`.poly`) meshes
- Export now offers Triangle `.poly` and the write-only **SVG/TikZ** figure formats (a 2D/3D-projected drawing of the mesh) in a new "Figures" menu group
- These new formats are also reachable from the `mesh_convert`/`mesh_info` MCP tools via the extension defaults and `inputFormat`/`outputFormat` overrides

## [2.1.0] - 2026-07-17

- Deformed-shape field mode, combinable with the other Field modes (Contour · Quiver · Isosurface) instead of switching exclusively ([#51](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/51))
- Mesh Size panel (nodal/element size color overlay, box-and-whisker distribution, highlight smallest/largest elements, write sizes into the mesh) ([#51](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/51))
- Upgraded to meshio++ 6.1.0 ([#51](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/51))
- Dependabot auto-merge workflow for CI and dependency update PRs ([#51](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/51))
- Dependency updates: `esbuild`, `ejs`, `@kitware/vtk.js`, `express`/`@types/express`, `@vscode/vsce`, and GitHub Actions (`setup-node`, `checkout`, `deploy-pages`, `upload-pages-artifact`, `action-gh-release`) ([#39](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/39)–[#50](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/50))

## [2.0.0] - 2026-07-16

- Extended mesh-format support via [`@meshioplusplus/wasm`](https://www.npmjs.com/package/@meshioplusplus/wasm): dozens of additional read/write formats (gmsh, Abaqus, Ansys, FreeFEM, tetgen, and more) alongside the native VTK/MDPA/STL/OBJ/PLY support ([#38](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/38))

## [1.9.4] - 2026-07-14

- **Problemtypes**: build and run Kratos simulation cases directly from the preview — declarative problemtype catalog (built-in Structural, Fluid, Convection-Diffusion, Potential Flow, Shallow Water) with sidebar forms for conditions, materials, and VTK output, generating `ProjectParameters.json`, materials files, and `MainKratos.py`, plus Generate/Run/Open-results actions ([#34](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/34))
- **Flowgraph**: embedded node-graph problemtype editor for visually composing Kratos processes, with a live ProjectParameters bridge to/from the generated case ([#35](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/35))

## [1.6.0] - 2026-07-10

- Maintenance release (no functional changes since v1.5.9).

## [1.5.9] - 2026-07-08

- Maintenance/patch release following the MMG remeshing feature.

## [1.5.8] - 2026-07-08

- Added MMG-based mesh remeshing (uniform factor / target size / optimize modes with advanced tuning) and level-set splitting to the Mesh Modification sidebar, running off the main thread in a worker with live progress and cancellation ([#32](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/32))

## [1.4.5] - 2026-07-08

- Added a mesh-editing suite: linear → quadratic conversion, an undo/redo/partial-revert operation history with JSON recipe save/load, coordinate transforms (scale, translate, rotate), and SubModelPart rename/inspect from the outline tree ([#31](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/31))

## [1.3.4] - 2026-07-08

- Patch release following the File menu addition.

## [1.3.3] - 2026-07-08

- Implemented the webview File menu (Open, Save, Save As, Export) with palette-command parity ([#29](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/29))

## [1.3.1] - 2026-07-08

- Patch release following the multi-format preview extension.

## [1.2.4] - 2026-07-08

- Extended the preview to the full VTK family and surface-mesh formats: VTK XML (`.vtu`/`.vtp`/`.vti`/`.vts`/`.vtr`), multiblock (`.vtm`), binary legacy VTK, and STL/OBJ/PLY ([#28](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/28))

## [1.2.2] - 2026-07-07

- Version bump to 1.2.1 and added the local reinstall script/task (`npm run reinstall`) ([#19](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/19))

## [1.1.1] - 2026-07-03

- Added a VitePress documentation site, published to GitHub Pages ([#17](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/17))

## [1.1.0] - 2026-07-03

- Added plane-cut visualization for volume meshes with true element cross-sections ([#16](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/16))

## [1.0.2] - 2026-07-03

- Added a publish step to the Visual Studio Marketplace in CI.

## [1.0.1] - 2026-07-01

- Updated toolbar button labels with icons.

## [1.0.0] - 2026-06-26

- Added on-screen view navigation controls (orbit/pan/zoom/fit/center) and improved the orientation cube ([#9](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/9))

## [0.9.1] - 2026-06-26

- Added VTK preview support: timeline animation for time-series output, SubModelPart tree, and field visualization for Kratos VTK output ([#8](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/8))

## [0.8.1] - 2026-06-26

- Added coordinate axes and a reference grid to the scene ([#7](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/7))

## [0.7.0] - 2026-06-25

- Added field visualization: Contour, Quiver, and Isosurface modes ([#6](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/6))

## [0.6.0] - 2026-06-25

- Added a scene theme selector (presets, toolbar UI, and persistence) with related fixes to theme validation, VTK background flash, and select hover state.

## [0.5.1] - 2026-06-24

- Icon and minor fixes following the entity-search feature.

## [0.5.0] - 2026-06-24

- Added "find entity by ID" with wireframe context highlighting ([#5](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/5))

## [0.4.1] - 2026-06-24

- Added a mesh-quality panel with plots and bad-element highlighting ([#4](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/4))

## [0.3.0] - 2026-06-24

- Added large-file support ([#3](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/3))
- Ignored the `.worktrees/` directory in Git ([#2](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/2))

## [0.2.0] - 2026-06-23

- Added mesh panning, an example mesh, `CLAUDE.md`, and VS Code tasks; cleaned up the README.

## [0.1.0] - 2026-06-23

- Initial release: custom editor preview for `.mdpa` files.

[2.8.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.7.1...v2.8.0
[2.7.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.6.0...v2.7.0
[2.6.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.5.1...v2.6.0
[2.5.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.9.4...v2.0.0
[1.9.4]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.6.0...v1.9.4
[1.6.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.5.9...v1.6.0
[1.5.9]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.5.8...v1.5.9
[1.5.8]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.4.5...v1.5.8
[1.4.5]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.3.4...v1.4.5
[1.3.4]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.3.1...v1.3.3
[1.3.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.2.4...v1.3.1
[1.2.4]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.2.2...v1.2.4
[1.2.2]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.1.1...v1.2.2
[1.1.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.9.1...v1.0.0
[0.9.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.8.1...v0.9.1
[0.8.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.7.0...v0.8.1
[0.7.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.3.0...v0.4.1
[0.3.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/releases/tag/v0.1.0
