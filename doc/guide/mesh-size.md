# Mesh Size

**Advanced ▸ Mesh Size** computes per-node and per-element mesh size and opens a
floating panel to inspect the distribution. It works on `.mdpa` and every
supported VTK / mesh format.

## What is measured

- **Nodal size** (`NODAL_H`) — a faithful port of Kratos'
  [`FindNodalHProcess`](https://github.com/KratosMultiphysics/Kratos): for each
  node, the **minimum distance to any other node that shares an element**. For a
  linear element this is the shortest incident edge; higher-order geometries
  include their mid-side nodes, exactly as the Kratos process does.
- **Element size** (`ELEMENT_H`) — the element **characteristic length**, taken
  as the mean of the element's edge lengths.

## The panel

- **Colour by** — `None`, `Nodal (NODAL_H)`, or `Element (ELEMENT_H)`. Choosing
  a measure colours the mesh Field-like (the same colour-mapping and colormap
  legend as [Field visualization](./field-visualization)), dimming the base mesh
  to wireframe so the colouring reads clearly.
- **Element size distribution** — a **box-and-whisker** plot of the element size:
  the box spans Q1–Q3 with the median line, the whiskers reach the Tukey fences
  (Q1 − 1.5·IQR and Q3 + 1.5·IQR), and dots mark the extremes when there are
  outliers beyond the whiskers.
- **Highlight** — **Smallest** and **Largest** toggle the statistical (IQR)
  outlier elements as overlays: small in **blue**, large in **red**. **Frame
  smallest / largest** zooms the 3D view to that group.

## Write to mesh

The **Write to mesh** buttons (`NODAL_H`, `ELEMENT_H`, or `Both`) append the
computed fields to the mesh as an **undoable operation**. Once written they:

- appear in the [Field visualization](./field-visualization) variable dropdown,
- are saved into the file (e.g. `Begin NodalData NODAL_H`) on **Save / Export**,
  and round-trip through the [problem archive](./mesh-editing).

Even without writing them, the computed values are cached on the model's
auxiliary store, so they are available to future operations.

## From the MCP server

The same computation is exposed to the [MCP server](./development) as the
`mesh_size` tool: it returns the nodal and element box-whisker statistics plus the
IQR-outlier smallest / largest element ids for any supported mesh file, with no
VS Code UI.
