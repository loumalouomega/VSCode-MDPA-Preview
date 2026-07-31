# Navigation & Orientation

Every preview carries always-on navigation aids, plus screenshot export and
find-by-ID.

![The orientation cube with X/Y/Z axis arrows and the on-screen navigation panel in the viewport corners](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/navigation.png)

## Orientation cube & axis arrows

An always-visible labeled cube sits in the **bottom-left** corner
(RIGHT / LEFT / TOP / BOTTOM / FRONT / BACK) and follows the camera as you orbit.
Prominent **X (red)**, **Y (green)**, and **Z (blue)** axis arrows with letter
labels radiate from it. **Click a cube face** to snap the camera to that canonical
axis direction. The label colors adapt to the light / dark scene theme.

## Navigation controls

A compact on-screen panel appears next to the cube once a model loads:

- **Rotate** compass — four arrows orbit the camera by the selected step
  (15° / 45° / 90°, azimuth / elevation); press-and-hold for continuous rotation.
- **Pan** compass — four arrows translate the camera plane (step proportional to
  the current zoom level).
- **Zoom** — `+` / `−` dolly the camera (×1.25 / ×0.8); press-and-hold for
  continuous zoom.
- **Fit** — frame all visible geometry (same as **Reset Camera**).
- **Ctr** (Center) — re-center the focal point on the visible bounds without
  changing the orbit angle or zoom.

All of these are webview-local — no round-trip to the extension host.

## Background grid

![The background grid: a labeled bounding-box with X/Y/Z axes and tick marks around the mesh](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/grid.png)

The **Grid** toolbar button toggles a bounding-box grid with labeled X / Y / Z
axes and tick marks around the mesh — handy for reading off coordinates and
scale. Axis and tick label colors adapt to the active theme.

## Screenshot export

The **📷** toolbar button captures the current viewport as a PNG and opens a Save
dialog pre-filled with the source file's name (e.g. `mesh.png` next to
`mesh.mdpa`). It uses VTK.js's `captureNextImage()` for correct WebGL swap-chain
timing.

::: tip
SVG export is not possible — the viewport is a rasterized WebGL canvas.
:::

## Find entity by ID

![Find: the searched entity highlighted in yellow while the rest of the mesh drops to wireframe](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/find-entity.png)

The **Find** toolbar button (or the **Find Entity by ID** command) opens a search
bar: choose **Node**, **Element**, **Condition**, or **Geometry**, type an ID, and
press **Go**. The matched entity is highlighted in **yellow** and the camera zooms
to it, while every other layer drops to **wireframe** for contrast. Closing the
bar restores the previous display state.

## Inspect

The **Inspect** toolbar button turns clicks on the mesh into a probe — no id
needed up front, unlike Find. Click any node, element, or condition and a
floating panel shows its id, block, SubModelPart membership, and every field
value defined at it (both the clicked entity and its nearest node, when both
resolve). The picked entity is highlighted and a **Frame** button zooms to it.

Inside the panel, a **Measure** toggle switches to a two-click distance tool:
click a first node, then a second, and the panel reports the distance and
Δx/Δy/Δz between them with a line drawn in the 3D view.

## Extras

- **Clip** — an interactive clipping plane to slice into a solid mesh: pick
  the X / Y / Z axis, or **Free** for an oblique cut (type a normal vector's
  X/Y/Z components), flip the direction, and drag the position slider. The
  section is capped with a filled surface (colored by the active Contour field,
  when one is shown) and its element intersection edges, not just a hollow
  clip.
- **Display: Shaded / Wire** — render all layers shaded or as edges only.
- **Layer opacity** — hover any outline row (mesh block or SubModelPart) for a
  small opacity button that opens a live 0–100% slider.
- **Scene theme** — the Appearance group's dropdown switches the viewport between Auto,
  Dark, Light, and Scientific palettes.
- **Appearance ▸ Persp/Ortho** — toggles the camera between perspective
  and orthographic (parallel) projection.
- **Advanced ▸ Lighting…** — global specular / ambient / diffuse sliders and a
  backface-culling toggle (useful for spotting an inverted shell element from
  the inside).
- **Advanced ▸ Camera Bookmarks…** — save the current view under a name and
  restore it later; the list resets when the preview reloads, but a **Camera
  JSON** textarea lets you copy a view out (or paste one in and click Apply)
  for sharing across sessions.
- **Standard views** — press `1`–`6` for the six axis-aligned views (±X/±Y/±Z)
  or `i` for an isometric-style corner view; same views as clicking a face of
  the orientation cube.
