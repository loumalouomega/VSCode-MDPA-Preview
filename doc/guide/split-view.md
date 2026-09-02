# Split View

**View ▾ ▸ Layout** puts the mesh in one, two or four viewports at once. Every
pane draws the same mesh through its **own camera, field settings and clip
plane**, so you can watch the front and the top at the same time, keep a
whole-model overview beside a zoomed-in detail, or put two different result
variables side by side.

![The same mesh in four viewports, each with its own camera, the focused pane outlined](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/split-view.png)

| Layout | What you get |
|---|---|
| **Single** | One viewport — the default. |
| **Side by side** | Two panes, split left/right. |
| **Stacked** | Two panes, split top/bottom. |
| **Quad** | Four panes. |

## Which pane am I driving?

Orbit, pan and zoom always apply to the pane **under the pointer** — just move
the mouse into a pane and drag.

Everything else that acts on one pane without you pointing at it — **Reset**,
**Frame** on a layer or a table row, the navigation card's orbit and fit
buttons, the `1`–`6` and `i` view shortcuts, camera bookmarks, and now the
**Field panel** and the **Clip** controls — acts on the pane you last *pressed
in*. That pane is drawn with a highlighted border so there is no guessing, and
the orientation cube turns to match it.

Click inside a pane to point the panels at it. The focus is a latch, not a
hover: it survives moving the mouse off the canvas to reach the panel, which is
the whole point.

## A different field in each pane

![Two panes of one mesh, each coloured by a different variable](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/split-view-fields.png)

The Field panel edits the focused pane, so each pane carries its own variable,
colormap, component, colour range, log/band settings, isosurface values,
threshold window and deformation. Click into a pane, pick what it should show,
click into the next one and pick something else.

The panel says which pane it is editing (**Pane 2 of 4**) and offers **Copy to
all panes** when you want them to agree again. A new pane is seeded from the
pane you split out of, exactly as its camera is, and then diverges.

The **clip plane is per-pane too** — its own axis (or free normal), position and
flip — so a clipped section can sit beside the whole model. The Off/On toggle,
the slider and the axis buttons always describe the focused pane; move the focus
and they follow.

## What is shared, and what is not

Per pane: the **camera**, the **field settings** and the **clip plane**.

Shared: which layers exist and their visibility, colours and opacity, the
display mode, the selection, and the analysis overlays (mesh size, spheres,
beams, face normals). Those are edited from one outline tree and one panel
apiece, and the demand was for different *fields*, not different *layer sets*.

The geometry is shared too. Each pane wraps the same mesh in its own view of it
rather than a copy, so switching to a four-pane layout is instant even on a
large model.

::: tip Node IDs are single-pane only
Node ID labels are HTML drawn on top of the canvas, positioned by projecting
each node through one camera. In a split there is more than one camera, so the
labels would land over the wrong panes — the viewer says so and leaves them off
rather than drawing them in the wrong place.
:::

## Screenshots

A screenshot captures the **whole grid**, not the focused pane: the panes are
regions of one canvas, so that is what "the current view" means here. A quad
layout is a convenient way to get front/top/side/iso into a single image.

The Field panel's legend is burned into a screenshot only in the single-pane
layout — panes can colour by different fields, and one legend drawn in a corner
would be describing the wrong ones. In a split, tick **Show scalar bar in
scene** instead: that legend lives in each pane and is already part of the
capture.

## Under the hood

Panes are not separate canvases or separate documents. They are viewport
rectangles on the single render window, each with its own camera. Every layer's
geometry is built once and shared; each pane only wraps it in its own actor and
mapper, which is what lets a pane carry its own clip plane (a clipping plane is
a property of the mapper) without duplicating the mesh. That is why switching
layouts is instant and why nothing reloads when you do it.
