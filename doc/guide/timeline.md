# Time-series Playback

Kratos writes one file per model-part per time step. Open any file in such a
series (legacy `.vtk`, VTK XML, or `.vtm`) and the extension detects the naming
pattern, groups the sibling files, and loads the whole series as an animation.

![The timeline bar at the bottom of the viewport: step buttons, play/pause, scrubber, step label, and fps input](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/timeline.png)

## Filename grammar

Kratos names files as `<prefix>_<rank>_<step>.<ext>`. The extension parses this
pattern — anchored from the **right** so part names may contain underscores —
infers the parent / child prefix tree, and groups the sibling files in the same
directory into a single time-series model. Grouping is **per extension**: a
`.vtk` and a `.vtu` series with the same prefix never mix. `.stl` / `.obj` /
`.ply` and the extended meshio++ formats always open as static views.

## The timeline bar

When multiple time steps are found, a bar appears along the bottom of the
viewport:

```
◀  ▶  ▶▶  ══════●══════════  Step 4  (2/3)  2 fps
```

- **◀ / ▶▶** — step backward / forward one frame.
- **▶ / ⏸** — play / pause at the configured rate.
- **Scrubber** — drag to jump to any step instantly.
- **fps** input — playback speed (1–30 fps).

A single file with no timestep siblings opens as a static preview with no
timeline bar.

## State is preserved across frames

Camera position, layer visibility, the active field variable, mode, and colormap
are all preserved when switching frames — so a [field](./field-visualization)
animates cleanly across the series, and toggled layers stay toggled.

## SubModelparts across the series

Each submodelpart file in the series (e.g. `Main_FixedEdgeNodes_0_*`,
`Main_MovingNodes_0_*`) is merged into the frame as an overlay layer by
coordinate matching, so the submodelpart tree stays consistent as you scrub.

::: tip
The directory is watched for new files, so time steps written **while the preview
is open** automatically extend the timeline — handy for watching a running
simulation.
:::
