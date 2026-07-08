# VTK / Mesh Preview

The same viewer opens all common VTK-family and surface-mesh formats:

| Format | Extensions | Notes |
|---|---|---|
| Legacy VTK | `.vtk` | ASCII **and** binary (big-endian) |
| VTK XML | `.vtu`, `.vtp`, `.vti`, `.vts`, `.vtr` | ascii, inline base64, appended raw/base64, zlib-compressed |
| VTK multiblock | `.vtm` | referenced blocks merge into one scene; each block becomes a layer |
| Surface meshes | `.stl` (ascii+binary), `.obj`, `.ply` (ascii+binary) | STL vertices are welded; PLY vertex properties become fields |

Kratos writes one VTK file per model-part per time step (e.g. `Main_0_2.vtk`,
`Main_FixedEdgeNodes_0_4.vtk`). Open any `.vtk` (or VTK XML) file in the
explorer — the extension detects the Kratos naming pattern and loads the full
time series automatically.

The preview reuses the same viewer, outline, and toolbar as the
[MDPA Preview](./mdpa-preview), so mesh quality, field visualization,
screenshots, find-by-ID, and the navigation controls all work here too.
Point/cell data arrays from any format appear in the **Field** panel.

## Filename grammar

Kratos names files as `<prefix>_<rank>_<step>.<ext>`. The extension parses this
pattern (anchored from the right so part names may contain underscores), infers
the parent / child prefix tree, and groups the sibling files in the same
directory into a single time-series model. Grouping is per extension — a `.vtk`
and a `.vtu` series with the same prefix never mix. `.stl`/`.obj`/`.ply` always
open as static views.

## Submodelpart tree

The sidebar shows the same layer tree as the MDPA preview. The root model-part
file provides the full mesh; each submodelpart file (e.g. `FixedEdgeNodes`,
`MovingNodes`) appears as a hidden-by-default overlay layer that you can toggle
independently. Point-cloud submodelparts (node-only files) are rendered as
vertex cells. Drag the divider between the sidebar and the 3D view to resize the
sidebar.

## Timeline animation

When multiple time steps are found in the directory, a timeline bar appears at
the bottom of the viewport:

```
◀  ▶  ▶▶  ══════●══════════  Step 4  (2/3)  2 fps
```

- **◀ / ▶▶** step backward / forward one frame
- **▶ / ⏸** play / pause (at the configured fps rate)
- **Scrubber** — drag to jump to any step instantly
- **fps** input — controls playback speed (1–30 fps)

Camera position, layer visibility, active field variable, and colormap are all
preserved when switching frames. A single file with no timestep siblings opens
as a static preview with no timeline bar.

::: tip
The directory is watched for new files, so time steps written while the preview
is open automatically extend the timeline.
:::

## Known limitations

- MPI rank > 0 files are not merged in this release (rank-0 files are loaded).
- Submodelpart merging uses coordinate matching (`toFixed(6)`); if the root and
  subpart files were written at different float precision the merge may miss
  nodes (a diagnostic is emitted in the sidebar stats).
