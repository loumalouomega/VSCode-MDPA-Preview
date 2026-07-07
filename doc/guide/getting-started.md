# Getting Started

**Kratos MDPA Preview** is a VS Code extension that renders Kratos Multiphysics
`.mdpa` model-part files — and Kratos legacy `.vtk` output — as an interactive
3D mesh with a navigable ModelPart / SubModelPart outline.

It is fully self-contained: a pure-TypeScript MDPA parser feeds a
[VTK.js](https://kitware.github.io/vtk-js/) viewer running in a webview. **No
Python or compiled Kratos is required.**

## Requirements

- VS Code `1.84.0` or newer.

## Install

Install **Kratos MDPA Preview** from the VS Code Marketplace:

- In VS Code, open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`),
  search for **Kratos MDPA Preview**, and click **Install**.
- Or install it directly from the
  [Marketplace page](https://marketplace.visualstudio.com/items?itemName=kratos-multiphysics.vscode-mdpa).

## Open a preview

The raw text editor stays the **default** for `.mdpa` and `.vtk` files, so
opening a file shows its text. Open the 3D preview in any of these ways:

- **Editor-title button** — with a `.mdpa` (or `.vtk`) file open, click the
  preview button in the editor toolbar.
- **Explorer context menu** — right-click a `.mdpa` / `.vtk` file and choose
  **Open MDPA Preview** / **Open VTK Preview**.
- **Command Palette** — run **Kratos MDPA: Open MDPA Preview** or
  **Kratos VTK: Open VTK Preview** (`Ctrl+Shift+P` / `Cmd+Shift+P`).

Once the preview loads you get the 3D scene, the outline sidebar, a stats panel,
and a toolbar (Reset Camera, Node IDs, Quality, Field, Find, Grid, Screenshot).

## Next steps

- [MDPA Preview](./mdpa-preview) — the full feature set for `.mdpa` files.
- [VTK Preview](./vtk-preview) — Kratos legacy `.vtk` output and time-series
  playback.
- [Development](./development) — building the extension from source.
