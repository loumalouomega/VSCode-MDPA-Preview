---
layout: home

hero:
  name: Kratos MDPA Preview
  text: 3D mesh viewer for VS Code
  tagline: >-
    Preview, organize, edit, and remesh Kratos Multiphysics .mdpa model-part
    files — and VTK / STL / OBJ / PLY meshes — with a navigable
    ModelPart / SubModelPart outline, mesh quality, field plots, and in-place
    editing. No Python or compiled Kratos required.
  image:
    src: https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/icon.png
    alt: Kratos MDPA Preview
  actions:
    - theme: brand
      text: Getting Started
      link: /guide/getting-started
    - theme: alt
      text: Explore Features
      link: /guide/viewer-outline
    - theme: alt
      text: Install from Marketplace
      link: https://marketplace.visualstudio.com/items?itemName=kratos-multiphysics.vscode-mdpa

features:
  - icon: 🧊
    title: 3D mesh preview
    details: >-
      View nodes, elements, conditions, and geometries in a VTK.js viewer.
      Volume elements are shown as their boundary surface; quadratic elements
      are approximated by their corner nodes.
    link: /guide/viewer-outline
    linkText: The 3D viewer & outline
  - icon: 🗂️
    title: SubModelParts as layers
    details: >-
      An outline tree of every entity block and the full SubModelPart hierarchy,
      each an independently toggleable overlay — isolate inlets, outlets, and
      boundaries with a click.
    link: /guide/viewer-outline#the-outline-tree-layers
    linkText: Layers & isolation
  - icon: 📐
    title: Mesh quality
    details: >-
      Purely geometric metrics inspired by Kratos' ComputeMeshQualityProcess:
      aspect/edge ratio, min/max angle, and size gradation — with histograms and
      a Good/Acceptable/Bad/Unacceptable verdict.
    link: /guide/mesh-quality
    linkText: Mesh quality metrics
  - icon: 🌈
    title: Field visualization
    details: >-
      Plot NodalData, ElementalData, and ConditionalData fields as contours,
      quiver glyphs, or isosurfaces, with selectable colormaps and a live legend.
    link: /guide/field-visualization
    linkText: Field visualization
  - icon: 🛠️
    title: Edit, remesh & level-set
    details: >-
      Linear→quadratic conversion, scale / translate / rotate / merge / delete,
      an undoable operation history with JSON recipes, and MMG remeshing and
      level-set splitting via WebAssembly.
    link: /guide/mesh-editing
    linkText: Mesh editing & MMG
  - icon: 🎞️
    title: VTK & mesh formats
    details: >-
      Open legacy .vtk (ASCII or binary), VTK XML (.vtu/.vtp/.vti/.vts/.vtr),
      multiblock .vtm, STL, OBJ, or PLY files. Kratos time series load
      automatically, with a timeline scrubber and play/pause controls.
    link: /guide/vtk-preview
    linkText: VTK & mesh formats
  - icon: 🧭
    title: Built-in navigation
    details: >-
      An orientation cube with axis arrows, an on-screen orbit / pan / zoom
      panel, a background grid, screenshot export, and find-entity-by-ID.
    link: /guide/navigation
    linkText: Navigation & orientation
---

![The MDPA preview: 3D mesh, ModelPart / SubModelPart outline, stats, and toolbar](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/preview-overview.png)

The extension is fully self-contained — a pure-TypeScript parser feeds a
[VTK.js](https://kitware.github.io/vtk-js/) viewer running in a webview. The raw
text editor stays the default; open the preview from the editor-title button,
the explorer context menu, or the **Open MDPA Preview** command.
