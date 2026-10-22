# Volume View

A mesh that is a **dense regular lattice** — a `.vti` image file, or a grid written by **Advanced ▸ Sample to grid…** — can be drawn as image data instead of as the surface of its cells. **Advanced ▸ Volume view…** opens the panel.

The panel appears only when the open model really is a lattice: every cell an 8-node hexahedron, evenly spaced nodes on each axis, no missing or moved node and at least one nodal scalar. Otherwise it says so and nothing changes. The view needs the vtk.js renderer; the VTK-wasm renderer keeps the surface view.

## Show as

- **Surface** — the ordinary view (the default); selecting it restores the picture exactly.
- **Volume** — a ray-marched volume coloured by the chosen **Scalar** and **Colormap**. The **Opacity** curve decides what is see-through: click the curve to add a point, drag a point to move it, double-click an interior point to remove it, or start from a preset (ramp, inverse ramp, shell, faint).
- **Slices** — three orthogonal slices, each with its own on/off box and position slider.
- **Iso** — up to four marching-cubes iso surfaces, each with its own value slider, coloured from the same colormap.

A thin outline frames the lattice in every mode.

## What it does not do

It is display only. The cells, the fields and every export are the mesh you opened; edits you apply still act on that mesh. Rebuilding the scene (an edit, a new time step, a layout change) switches the view back to Surface because it belongs to one pane's renderer. Clicking to inspect an entity is a surface-view feature.

The decisions and measurements behind this, and the vtk.js modules that were evaluated and left out, are in the repository's `doc/vtk-js-evaluation.md`.
