---
layout: home

hero:
  name: Kratos MDPA Preview
  text: 3D mesh viewer for VS Code
  tagline: >-
    Preview, organize, and manage Kratos Multiphysics .mdpa model-part files —
    with a navigable ModelPart / SubModelPart outline and toggleable layers.
    No Python or compiled Kratos required.
  image:
    src: https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/icon.png
    alt: Kratos MDPA Preview
  actions:
    - theme: brand
      text: Getting Started
      link: /guide/getting-started
    - theme: alt
      text: MDPA Preview
      link: /guide/mdpa-preview
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
  - icon: 🗂️
    title: SubModelParts as layers
    details: >-
      An outline tree of every entity block and the full SubModelPart hierarchy,
      each an independently toggleable overlay — isolate inlets, outlets, and
      boundaries with a click.
  - icon: 📐
    title: Mesh quality
    details: >-
      Purely geometric metrics inspired by Kratos' ComputeMeshQualityProcess:
      aspect/edge ratio, min/max angle, and size gradation — with histograms and
      a Good/Acceptable/Bad/Unacceptable verdict.
  - icon: 🌈
    title: Field visualization
    details: >-
      Plot NodalData, ElementalData, and ConditionalData fields as contours,
      quiver glyphs, or isosurfaces, with selectable colormaps and a live legend.
  - icon: 🎞️
    title: VTK time-series
    details: >-
      Open a Kratos legacy .vtk file and the extension loads the whole time
      series automatically, with a timeline scrubber and play/pause controls.
  - icon: 🧭
    title: Built-in navigation
    details: >-
      An orientation cube with axis arrows, an on-screen orbit / pan / zoom
      panel, a background grid, screenshot export, and find-entity-by-ID.
---

![Kratos MDPA Preview](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/mdpa_preview.png)

The extension is fully self-contained — a pure-TypeScript MDPA parser feeds a
[VTK.js](https://kitware.github.io/vtk-js/) viewer running in a webview. The raw
text editor stays the default; open the preview from the editor-title button,
the explorer context menu, or the **Open MDPA Preview** command.
