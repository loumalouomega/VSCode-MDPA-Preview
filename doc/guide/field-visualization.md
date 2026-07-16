# Field Visualization

The **Field** toolbar button (or the **Field Visualization** command) plots the
data arrays stored in the file: `NodalData`, `ElementalData`, and
`ConditionalData` for `.mdpa`, and point / cell data arrays for every VTK and
mesh format. While a field is shown, the base mesh dims to wireframe so the
coloring or glyphs stand out.

## The panel

![The Field panel: variable and mode selectors, colormap dropdown, live legend, and a mesh colored by a nodal scalar](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/field-contour.png)

- **Variable** — pick any stored array. The dropdown labels each with its source
  (Nodal / Elemental / Conditional) and rank (scalar / vector).
- **Modes** — Contour, Quiver, Isosurface, and Deformed shape (see below). Each
  is an **independent toggle**, so you can combine any of them at once (e.g.
  Contour + Quiver, or Deformed + Contour). Modes that don't apply to the current
  variable are disabled (Quiver / Deformed need a vector; Isosurface needs a
  scalar).
- **Colormap** — Rainbow (jet, default), Viridis, Cool-warm, or Grayscale. The
  choice drives both the 3D coloring and the **legend** gradient with its
  min / mid / max tick values.

## Contour

Color the mesh by a scalar. Nodal fields are drawn as smooth interpolated
point-data; elemental / conditional fields are drawn flat per cell. **Vector
fields are colored by magnitude.** On a volume mesh, boundary faces inherit their
owning cell's value.

## Quiver

Draw arrow glyphs oriented and scaled by a **vector** field — at nodes for nodal
data, or at cell centroids for elemental / conditional data — colored by
magnitude. The **Arrow scale** slider tunes glyph length so the arrows read
clearly whatever the field's units.

## Isosurface

![Isosurface mode: the surface where a scalar equals the slider iso-value, cutting through the wireframe mesh](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/field-isosurface.png)

Extract the surface where a **scalar** equals a slider-driven **iso value**. On
volume meshes this uses marching tetrahedra (each cell decomposed into tets); 2D
and surface meshes fall back to **iso-lines**. Drag the **Iso value** slider to
sweep the surface through the field — the surface rebuilds live.

## Deformed shape

Warp the geometry by a **vector** field to visualize displacement — the standard
FE post-processing view. The deformation has its **own** "Deform by" selector
(independent of the coloring variable), so you can deform by `DISPLACEMENT` while
coloring by a stress scalar, and a **Warp scale** slider exaggerates or damps the
motion. The warp is *global*: with Deformed shape on, Contour, Quiver, and
Isosurface all render on the deformed geometry, while the undeformed reference
mesh stays visible as a wireframe. Combine Deformed + Contour for the canonical
"deformed shape colored by displacement" plot.

::: tip
See also [Mesh size](./mesh-size) for a related Field-like view of the per-node
and per-element mesh size, with a box-and-whisker of the element-size
distribution.
:::

::: tip
For a Kratos time series, the active variable, mode, and colormap are preserved
as you scrub the [timeline](./timeline), so a field animates across the steps.
:::
