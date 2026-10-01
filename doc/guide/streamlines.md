# Streamlines

**Advanced ▸ Streamlines…** traces the curves that are everywhere tangent to a solved **nodal vector field** — VELOCITY, DISPLACEMENT, any 2- or 3-component field on the nodes — draws them over the mesh coloured by speed, and exports them as line cells.

## Choosing the field and the seeds

The field must live on the nodes. A cell field is piecewise constant and has no gradient to follow, so it is refused with a pointer to **Average field**. Where the lines start is one of:

- **Points** — one `x y z` per line, or switch on **Pick seeds** and click nodes in the scene; each click adds that node's coordinates.
- **Line** — a `count` of equidistant seeds from `From` to `To`, both ends included.
- **Plane** — a lattice `origin + i/(nu−1)·U + j/(nv−1)·V`; a count of 1 puts that row at the middle. **Use clip plane** fills the three vectors from the focused pane's clip plane — its slider position and span — so the seeds fall exactly on the section you are looking at.
- **SubModelPart** — the nodes of the part and its children, which is the natural way to seed from an inlet.

**Direction** is forward, backward or both; both gives two lines per seed, one each way.

While the panel is open, orange markers preview where the current draft would seed (the first 1000 at most) — a part previews as nothing, since its nodes are already visible in the mesh.

## How a line is traced

The integrator is a classical fourth-order Runge–Kutta in **arc length**, so a step is a distance rather than a time and does not shrink where the flow is slow. The step is a fraction (default 0.25) of the size of the cell the line is in. The field is interpolated barycentrically inside the containing cell, found with a locator built on the mesh's own cells; it is never extrapolated outside them.

Three caps bound a line: **Max steps** (default 2000), **Max length** (default five bounding-box diagonals) and a seed limit of 1000 — a request for more seeds is refused rather than silently truncated.

The trace runs in a worker thread, so the interface stays responsive while it works. The **Trace** button counts seeds as they complete, a newer **Trace** supersedes the running one (a timeline step re-traces the same seeds on the new frame), and **Cancel** stops after the current seed — the lines traced so far are kept and reported as a partial result. Cancellation takes effect between seeds: one very long line finishes before the run stops.

## Why a line ended

Every line records one of these, and the summary counts them:

| Code | Reason |
| --- | --- |
| 0 | reached the maximum length |
| 1 | reached the maximum number of steps |
| 2 | left the domain |
| 3 | reached a stagnation point — speed below 10⁻⁶ of the field's largest magnitude |
| 4 | met a node that carries no value |

A seed that produces no segment at all — outside the mesh, or at zero speed — is listed with its reason in the summary and in the MCP reply. It is never dropped without a word.

## How the lines look

**Style** switches the overlay between **Lines** (a pixel width) and **Tubes** — a surface around each line, sized as a share of the bounding-box diagonal with a ring resolution — both coloured by speed exactly like the lines. Styling is view-only: it never reaches a file, and **Export…** below still writes line cells. A tube layer over the two-million-ring-vertex budget falls back to lines and says so on the panel.

## What this is not

These are **steady** streamlines of the frame on screen: the field frozen at one instant. They are not the paths particles follow through a changing flow (pathlines), which need time interpolation. Edit operations applied in the sidebar are honoured, because the trace uses the mesh as it is on screen. Stepping the timeline re-traces the same seeds on the new frame.

## Exporting

**Export…** writes one node per vertex and one `Line2D2N` element per segment. Nodal fields: `STREAM_SPEED`, `STREAM_VELOCITY`, `STREAM_ARCLENGTH`. Per-segment fields: `STREAM_LINE`, `STREAM_SEED` (0-based index into the seed list), `STREAM_DIRECTION` (+1 forward, −1 backward) and `STREAM_TERMINATION` (the codes above). `.vtu` keeps all of them; a `.vtp` carries the nodal ones only.

## From an agent or a script

The same core runs headlessly as the `mesh_derive` MCP tool with `kind: "streamlines"`: give exactly one of `seedPoints`, `seedLine`, `seedPlane` or `seedPart`, and `timeStep` to choose a step of a multi-step file. The reply carries the termination counts and the rejected seeds, and a long trace reports per-seed progress as log lines. A clip-plane lattice needs no special tool — read the plane's position and span and pass them as an explicit `seedPlane`. See [MCP Server](./mcp).
