# Changelog

All notable changes to the **Kratos MDPA Preview** VS Code extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
