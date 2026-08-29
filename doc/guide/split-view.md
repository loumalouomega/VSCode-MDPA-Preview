# Split View

**View ▾ ▸ Layout** puts the mesh in one, two or four viewports at once. Every
pane draws the same mesh through its **own camera**, so you can watch the front
and the top at the same time, or keep a whole-model overview beside a zoomed-in
detail.

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

Everything that acts on "the camera" without you pointing at anything —
**Reset**, **Frame** on a layer or a table row, the navigation card's orbit and
fit buttons, the `1`–`6` and `i` view shortcuts, camera bookmarks — acts on the
pane you last touched. That pane is drawn with a highlighted border so there is
no guessing, and the orientation cube turns to match it.

## What is shared, and what is not

Only the **camera** is per-pane. Layers, fields, the clip plane, display mode,
opacity and selection are shared, so a change shows up in every pane at once.

That is a deliberate scope rather than an oversight: it is what lets the panes
share one copy of the geometry, so switching to a four-pane layout costs four
cameras rather than four meshes and is instant even on a large model. Showing
*different fields* in different panes is a separate, much larger change — it is
tracked as its own roadmap item.

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

## Under the hood

Panes are not separate canvases or separate documents. They are viewport
rectangles on the single render window, each with its own camera, all drawing
the same actors. That is why switching layouts is instant and why nothing
reloads when you do it.
