# Changelog

All notable changes to the **Kratos MDPA Preview** VS Code extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.14.1] - 2026-09-04

- **Stopping a run on Windows now attempts a graceful Ctrl+Break before
  terminating.** Both stop ladders (`RunHandle.stop` and the shared `stopPid`,
  so the editor and `case_stop` get it together) try a Ctrl+Break first —
  delivered via inbox PowerShell, so there is no helper binary to ship — and
  report a `"ctrlbreak"` rung when the process dies on it. Python turns the
  event into `KeyboardInterrupt`, so finalizers run and the last result file
  closes rather than truncating. The rung is best-effort by construction: it
  needs a console and a dedicated process group on the solver's side, and when
  it cannot be delivered the stop falls through to terminate rather than
  stranding — every message says attempted, never promised. Whether the rung
  exists in practice is still an open experiment: CI now also runs on
  `windows-latest` (with a Python for a real `try/finally`-marker stop test),
  and that leg is what proves or retires it.

## [3.14.0] - 2026-09-04

- **Remesh (MMG) can now freeze entities, bound sizes per part, and adapt
  anisotropically.** Three long-queued remeshing-depth items (roadmap Tier 2),
  all capability already compiled into the bundled MMG WASM — no new
  dependency. A **Frozen entities & local sizes** block in the Remesh form
  names whole EntityBlocks or SubModelPart subtrees MMG must leave
  bit-identical (a coupled or contact surface another code owns), and assigns
  per-block / per-part `hmin`/`hmax`/`hausd` bounds ("nothing smaller than
  2 mm in the boundary layer, whatever the formula says") — both ride the same
  block+SubModelPart reference table the harvest regroups by, and both are
  remesh-only. A fifth mode, **anisotropic**, differentiates a scalar nodal
  field twice inline and assembles a clamped positive-definite tensor metric
  from its Hessian ("adapt the mesh to the curvature of this solution": fine
  across a boundary layer, coarse along it). All three reach `mesh_transform`,
  saved recipes and the worker-thread progress/cancel UI.

## [3.13.0] - 2026-09-04

- **Node-only SubModelParts are now previewable, and isolated nodes highlight
  automatically.** A SubModelPart containing only nodes (no elements,
  conditions or geometries) previously rendered as near-invisible 6px points;
  such layers now draw at the same prominent point size as the quadratic
  mid-nodes overlay. On top of that, every node referenced by no cell
  connectivity — SubModelPart listing does not count — gets an automatic,
  on-by-default orange highlight under a new **Diagnostics → Isolated nodes**
  outline section, plus a warn-styled **Isolated nodes** row in the Information
  panel. `mesh_info` (MCP) reports the same set as a conditional
  `isolatedNodes` section (`count` plus the `ids`, capped at 1000).

- **New Kratos entry view in the Explorer.** With nothing open there was no way
  to reach the extension from the side bar; the always-visible **Kratos**
  section now offers **Open Mesh File…** and **Load Problem (zip)…**, reusing
  the existing commands.

## [3.12.0] - 2026-09-03

- **Constraints are now read as real entities, so editing a mesh keeps them
  correct.** The previous release stopped `Begin Constraints` blocks (Kratos
  master/slave constraints) from being thrown away on Save, by carrying the
  original text through unchanged. That text names nodes by id, so it went stale
  the moment anything renumbered or removed a node — and all the extension could
  do was warn you.

  Constraints are now parsed, and every operation that touches nodes maintains
  them. **Renumber** relabels a constraint's master and slave columns along with
  everything else, and compacts the constraint ids themselves — the
  `SubModelPartConstraints` lists follow. **Merge nodes** welds the columns, and
  drops a constraint that welding turned into a node tied to itself. **Crop**,
  **Linearize** and deleting a SubModelPart drop the constraints whose nodes are
  gone. **Merge mesh** carries a second file's constraints in with their own ids
  and node references shifted. Cleaning up orphan nodes no longer deletes a node
  that only a constraint refers to. Each of these says what it did.

  Because they come from the model rather than from the original file, **Save
  As** and every export now keep constraints even when there is no source file
  to copy from — which was impossible before.

  A row in a shape this extension does not recognise is kept exactly as written
  rather than dropped or guessed at, so an unusual constraint type still
  round-trips; operations that cannot maintain such a row say so instead of
  renumbering around it.

- **Fixed: exporting a SubModelPart no longer writes the whole file's
  constraints into it.** Exporting one part wrote every `Begin Constraints`
  block of the parent mesh into a file containing a fraction of its nodes.
  Extracting a part now takes only the constraints that belong to it. The same
  applied to **Export skin**, which listed constraint ids while defining none.

- **A saved file that names a constraint it does not define now tells you.**
  This is a file Kratos cannot read back, and until constraints were parsed
  there was nothing to check it against.

- `mesh_info` (MCP) reports a `constraints` section for an `.mdpa` that declares
  any — per block its name, variables, row count and id range — plus the
  constraint ids a SubModelPart lists that no block defines. Every SubModelPart
  in the tree now reports a constraint count alongside its other counts.

## [3.11.1] - 2026-09-02

- **Fixed: saving an `.mdpa` that declares constraints no longer throws them
  away.** A `Begin Constraints` block (Kratos master/slave constraints) was read
  only as a line count and was never written back — while the
  `SubModelPartConstraints` lists that *reference* it still were. So **File ▸
  Save** and **Save As** produced a file naming constraints it no longer
  contained, which is not a mesh Kratos can read back. The same applied to
  `mesh_transform` writing over its input.

  Constraints are now carried through verbatim, and placed after the nodes and
  the elements rather than at the top of the file, because Kratos resolves a
  constraint's master and slave columns against nodes it has already read.

  Verbatim text is keyed by node id, so the two ways that keying can go stale
  are now reported instead of being silent: saving tells you if node ids the
  constraints were written against are no longer in the mesh, and **Renumber**
  tells you it has just invalidated them. Neither blocks the save — a file that
  keeps its constraints is better than one that quietly dropped them — and the
  complete fix, reading constraints as real entities so edits can maintain them,
  is queued as the top of the roadmap.

- **Exporting a field that covers only part of the mesh now says so.** A cell
  field defined on some elements but not others is written as `0` in the gaps,
  and a `0` there cannot be told from a real value when the file is read back.
  The Exodus attribute path already avoided this for scalars; a vector never
  could. Either way the export now names the field and how much of the mesh it
  actually covered.

- The **Mesh Size** and **Beams** panels are now reachable from the Command
  Palette, like every other panel already was.

- Security: pinned the build's transitive `qs`, `browserslist` and `fast-uri`,
  and the documentation site's `nanoid`, past published advisories. `npm audit`
  reports no vulnerabilities in either package.

## [3.11.0] - 2026-09-02

- **Each split-view pane gets its own field settings and its own clip plane.**
  Until now a pane had only its own camera: layers, fields and the clip were
  global, so four panes were four viewpoints of one picture. Now the **Field
  panel and the Clip controls act on the focused pane**, so you can put
  DISPLACEMENT beside VELOCITY, a contour beside an isosurface, or a clipped
  section beside the whole model — each with its own variable, component,
  colormap, colour range, threshold, deformation and scalar bar.

  The panel names the pane it is editing (**Pane 2 of 4**) and offers **Copy to
  all panes** when you want them to agree again. Splitting seeds every new pane
  from the one you were working in and then lets them diverge, exactly as it
  already did for the camera.

  What stays shared is deliberate: which layers exist and their visibility,
  colours, opacity and display mode, plus the mesh-size, sphere, beam and
  face-normal overlays. Those are edited from one outline tree and one panel
  apiece; the ask was different *fields*, not different *layer sets*.

  Geometry is still built once and shared. Each pane wraps it in its own view of
  it rather than a copy, so switching layouts is as instant as before.

- **Fixed: "acts on the pane you last touched" was not true for anything you
  reached with the mouse.** The focused pane was read live from vtk.js's poked
  renderer, which is reset the moment the pointer leaves the canvas — so
  **Reset**, **Frame**, the navigation card and the keyboard view shortcuts
  quietly acted on the first pane rather than the outlined one, while the
  outline itself kept pointing at the right pane. The focus is now latched when
  you press or release inside a pane and holds until the next time you do,
  which is also what makes the per-pane panels usable at all.

- The Field panel's legend is burned into a screenshot in the single-pane
  layout only: panes can now colour by different fields, and one legend drawn
  in a corner would be describing the wrong ones. In a split, tick **Show
  scalar bar in scene** — that legend lives in each pane and is already part of
  the capture.

## [3.10.0] - 2026-08-29

- **Start and stop Kratos runs from an MCP client** — `case_run` and
  `case_stop`, completing the loop `case_status` began. All three meet the
  editor on the same `<stem>.kratosrun.json` file beside the mesh, so a run
  started on either side is visible from both, and **Show output** in the
  Kratos Runs view opens an agent-started run's log.

  The MCP server cannot *own* a solver — its stdout is the protocol channel and
  it exits with its client — so `case_run` always starts one **detached**, with
  its output appended to `<stem>.kratosrun.log`. It outlives the server. The
  case files are regenerated first by default, because a stale
  ProjectParameters.json solves the wrong problem silently.

  `waitSeconds` (default 10) is how long the call waits for the exit. A short
  case returns its exit code; a long one returns `running` with the pid and the
  log path and keeps solving, which is a handoff rather than a failure — the
  only timeout that can apply belongs to the client, and the server cannot see
  it. Poll `case_status`, which will read `detached` for the same run that
  `case_run` called `running`: it has only a pid, and pids are reused, so it
  will not claim more than it can verify.

  `case_stop` escalates SIGINT → SIGTERM → SIGKILL and says which rung worked.
  The SIGINT rung matters: it is what lets python close its last result file
  instead of truncating it. It records the stop before signalling, so the run
  reads *cancelled* rather than *failed*.

- **Stopping an adopted run is now graceful.** A run adopted from a sidecar
  after a window reload was terminated immediately, skipping the SIGINT rung
  that lets the solver shut down cleanly. It now uses the same ladder every
  other stop uses.

- Fixed: a stop requested in the editor latched only in memory, so the intent
  never reached the status file. And a run started in one place could silently
  overwrite the status record of a run started in another, destroying the only
  note of its pid and leaving it running, unlistable and unstoppable; the
  existing confirmation prompt now covers that case too.

## [3.9.0] - 2026-08-29

- **Beam / line-element rendering.** Advanced ▸ **Beams…** draws line elements
  as real tubes sized by their cross-section, instead of the fixed-width screen
  polylines that made a 6 mm tie rod and a 600 mm girder look identical at every
  zoom. The radius is the circular-equivalent `sqrt(A / π)` of the `CROSS_AREA`
  in the cell's own `Properties` block — resolved **per cell**, since repeated
  `Begin Elements` blocks merge into one layer that routinely holds members on
  several properties — falling back to an `ElementalData CROSS_AREA` field and
  then to a suggested constant. Thickness multiplies the radius only, never the
  length, so a member never detaches from its end nodes; tessellation and
  colour-by-section are there too, and the tubes follow the deformed-shape warp.

  A line cell is also the shape a 2D **boundary** takes, so the rendering only
  enables itself on real evidence: the section must be a genuine `CROSS_AREA`,
  and only *Elements* count towards enabling it — a `LineCondition2D2N` skin
  that shares a structural part's property id never flips it on by itself. A
  mesh with no sections at all (an imported wireframe, a fluid skin) keeps
  drawing as plain lines. Draw line conditions deliberately with **Line
  conditions**. Tubes are circular: a section area cannot orient a non-circular
  profile.

- **`Begin Properties` values are parsed.** Previously the extension kept only a
  label and a line count for a Properties block. It now reads the values —
  scalars, booleans, `[3] (…)` vectors, `[3,3] ((…),(…))` matrices and nested
  `Begin Table` blocks — and an unrecognised value (a constitutive-law name, for
  instance) is kept verbatim rather than dropped. `mesh_info` reports them as a
  `properties` section, alongside a new `beams` section for meshes with line
  cells. Saving is unchanged: Properties are still copied through verbatim, so
  the round-trip stays lossless.

  Two malformed-file behaviours are now explicit rather than accidental: a
  `Begin Properties` with no readable id is reported and skipped instead of
  silently shadowing the real `Properties 0`, and a duplicate id keeps the first
  block rather than letting a later empty one blank it. A `Begin Table` or
  `Begin SubModelPart` nested inside a Properties block is no longer leaked into
  the model — the latter previously became a genuine, phantom SubModelPart.

- New example `example/MDPA/portal_frame.mdpa` — a frame of beams, trusses and a
  line condition with mixed sections, showing all of the above at once.

## [3.8.0] - 2026-08-29

- **Split view.** View ▾ ▸ **Layout** puts the mesh in 1, 2 or 4 viewports at
  once — side by side, stacked, or a quad — each with its own camera, so you
  can watch the front and the top simultaneously or keep an overview beside a
  zoomed-in detail. It costs cameras, not geometry: every pane draws the SAME
  `vtkActor` instances, verified against vtk.js's own
  `ViewNode._renderableChildMap`, so switching to four panes is instant even on
  a large mesh. Only the camera is per-pane — layers, fields, clip and display
  mode stay shared, a deliberate scope (per-pane fields is a separate, larger,
  still-queued roadmap item). Node ID labels are refused outside a single pane
  rather than drawn over the wrong viewport.

- **Run manager** (**Kratos Runs** in the Explorer). Running a case used to be
  fire-and-forget: the terminal handle was dropped on the floor, two panels on
  same-named meshes in different folders could fight over one terminal, and the
  status line was never updated again once a solve started. Runs are now
  spawned as tracked child processes with a real exit code, appear in a
  **Kratos Runs** view with live progress read from `vtk_output/`, can be
  stopped from there (SIGINT → SIGTERM → SIGKILL, so python's finalizers close
  the last result file instead of truncating it), and outlive the preview panel
  that started them. A run started in the editor and one read by an agent
  through the new `case_status` MCP tool agree through the same
  `<stem>.kratosrun.json` file beside the mesh. `kratos.run.launchMode:
  "terminal"` keeps the old interactive terminal for anyone who wants a prompt
  instead.

- **Record the viewport as a video or a PNG sequence.** View ▾ ▸ **Record…**
  captures either a camera turntable (any mesh, `.mdpa` included) or a
  playthrough of a VTK time series, saved as a WebM video or as numbered PNG
  frames (with the exact `ffmpeg` command to turn those into an mp4, since this
  Chromium cannot encode H.264 itself). Pane separators are drawn into the
  capture in a split view, and the loading overlay no longer blanks a frame
  mid-recording.

- **A brand mark on the loading overlay.** The full-screen loading screen now
  shows a small turning wireframe mark above its progress bar, so there is
  something on screen saying the extension is alive even when the host cannot
  yet report a total size (previously the bar just sat at 0%). The motion is
  slow, single-axis and disabled under `prefers-reduced-motion: reduce`.

## [3.7.0] - 2026-08-29

- **Data table view**, with CSV and XLSX export. Advanced ▸ **Data table…**
  shows every node, element, condition or geometry as a row of plain values —
  coordinates or block+connectivity, optional SubModelPart membership, and
  every field defined there. A vector field splits into `NAME_X`/`_Y`/`_Z`
  columns (a 9-component Hessian into `NAME_0..NAME_8` — the naming rule is
  shared, not truncated, so nothing is silently dropped). The panel paginates
  at 100 000 rows before it virtualizes the visible window, since a single
  scroll spacer sized to a multi-million-row mesh would exceed the browser's
  own maximum layout height and make the tail of the mesh unreachable.
  Clicking a row highlights and frames the entity in the 3D view. **CSV** and
  **XLSX** always export the whole table, never just the visible page — CSV is
  streamed with no size limit, XLSX is capped at Excel's own worksheet limit
  and reports what it had to leave out. Coordinates export at their true
  32-bit float precision rather than the doubled-precision noise a naive
  conversion produces. Also reachable from the Command Palette and as the
  `mesh_export_table` MCP tool, the first tool that reports field *values*
  rather than metadata.
- **Plot a field value over time.** From the **Inspect** panel, click a node
  or element in a VTK time series and a new **Plot over time** button charts
  that entity's value across every step — the bulk counterpart of Inspect's
  own single-step, single-click answer. The scan runs in the extension host,
  not the preview: the viewer only ever holds one frame, so charting from it
  would mean stepping the whole timeline and rebuilding the scene once per
  step just to read one number. Progress is reported per step and the scan
  can be cancelled without losing what was already read. A step where the
  variable is missing or the entity is absent leaves a genuine break in the
  line rather than a value interpolated across it, and the two causes are
  reported separately since they have different fixes; a mesh that changes
  size mid-series is flagged, since the id may no longer be the same entity
  after that point. Edit operations applied in the sidebar are *not* replayed
  per step (that would cost roughly what scrubbing the timeline by hand
  costs), and the panel says so when any are applied rather than letting the
  plotted values silently disagree with what Inspect shows. Clicking a point
  on the chart jumps the 3D view to that step; **CSV** exports the series.
  Also reachable headlessly as the `mesh_field_series` MCP tool, which
  discovers a sibling `<prefix>_<rank>_<step>` or in-file (Exodus/GiD) series
  from a single file path exactly as the preview does.

## [3.6.1] - 2026-08-28

- **Fixed the `v3.6.0` release build**, which failed at the `vsce package` step
  ([run 33189202342](https://github.com/loumalouomega/VSCode-MDPA-Preview/actions/runs/33189202342)):
  a merge from `origin/master` brought in Dependabot's `@types/vscode` bump to `^1.134.0` without a
  matching `engines.vscode`, which `vsce` refuses to package (`@types/vscode` must not declare a
  newer API surface than the extension's own declared minimum VS Code version). `engines.vscode` is
  now `^1.134.0` to match. No functional change — the type-only dependency bump introduced no new
  API usage; this is a packaging-metadata fix.

## [3.6.0] - 2026-08-28

- **Updated `@meshioplusplus/wasm` to 10.20.2** (from the 9.22.0 the tree was actually running —
  `package-lock.json` said 10.0.0 and `node_modules` said 9.22.0, so nothing here had ever executed
  against a 10.x artifact). The upgrade needed no call-site changes at all: v10.0.0 is a
  version-*number* bump only, and every function this extension already called is byte-identical in
  signature across the whole window. The version-stamped fidelity notes in `CLAUDE.md`, `README.md`
  and the parser docblocks were re-measured against the live artifact rather than merely re-dated —
  including the gmsh `$PhysicalNames` export gap, which is **still open** at 10.20.2 and is now
  pinned by a test, so a future upstream fix fails loudly instead of leaving a stale note. The new
  upstream `vti` format is deliberately *not* routed: reading `.vti` is our own parser's, and
  upstream's writer raises on anything but a dense lattice. Provenance became on-by-default upstream
  in 10.17.0; measured across the jump it only rewrites the banner comment these formats already
  carried (`.msh`/`.mesh`/`.unv`/`.su2` are byte-identical), and a test now pins that it stays a
  comment rather than becoming a structural block.
- **GiD postprocess files open and export** (`.post.msh` + `.post.res`, `.post.bin`, `.post.h5`).
  GiD is Kratos's reference pre/post-processor, so its results now open directly in the preview —
  geometry, nodal and elemental fields, and **multi-step time series** driving the same timeline bar
  a Kratos VTK output series does. Opening either half of the ascii pair finds the other. Export
  offers the ascii flavour under **Solvers**, and writes both files: the `.post.res` half rides the
  same companion mechanism that already carries XDMF's `.h5` and OpenFOAM's `polyMesh/` tree, so the
  writer layer needed no change at all.
- **Compound extensions are resolved longest-suffix-first.** GiD forced this and it was a real trap:
  `case.post.msh`, `case.msh` and `case.post` are *three different formats* (GiD, Gmsh, PERMAS), and
  the plain last-dot extension a path yields for the first of those is `.msh` — so a GiD file was
  silently handed to the Gmsh reader. A single `meshExtname` helper is now the one authority for
  "which format is this path?" at every dispatch site, with a matching `meshStem` so a stem is the
  whole name minus the whole extension.
- **ODT smoothing** (`smooth`, `method: "odt"`). A third smoothing method aimed at a different goal
  from the other two: Taubin and Laplacian smooth a *surface*, while ODT moves each free interior
  vertex to the volume-weighted average of its incident tetrahedra's circumcenters, raising element
  **quality** — the one to run before a solve. Tetrahedra-only, and it says so by name rather than
  quietly doing nothing.
- **Field Hessian** (new operation). The second derivative of a scalar nodal field, as its nine
  flattened components. A field that is at most linear has an exactly zero Hessian on any mesh —
  the one shape-independent guarantee, and what the tests assert.
- **Error estimate** (new operation). The Zienkiewicz-Zhu recovery-based indicator, per cell, with
  optional marking (absolute / fraction / Dörfler) into a second 0/1 field that the Field panel's
  threshold mode can isolate directly. A field the mesh represents exactly has zero error, so a
  near-zero result is good news rather than a failure.
- **Distance to surface** (new operation). The signed distance from every node to a surface mesh
  picked from disk, negative inside. It pairs with the existing **Level-set split (MMG)**, which
  could already cut a mesh along the isosurface of a nodal field but had no way to obtain one from
  an imported geometry: the two together are "cut this mesh along that surface".
- **Transfer fields** (new operation). Mass-preserving transfer of another mesh's fields onto this
  one — over the shared region the measure-weighted total is conserved, which pointwise
  interpolation does not guarantee. Two behaviours are surfaced rather than hidden: nodal data
  travels by a cell round trip and is therefore *smoothed* rather than resampled, and an array whose
  entity count no longer matches is dropped **and named** instead of being scattered onto the wrong
  elements.
- **Watertightness** now appears on the **Face normals** status line and in the `mesh_quality` MCP
  tool: boundary edges (holes), non-manifold edges, inconsistently wound face pairs and zero-area
  faces. The existing native check is *relative* — it finds faces wound against each other but
  cannot tell you the surface is open — and these are counts rather than a pass/fail, because three
  boundary edges is a pinhole and three thousand is a surface that was never closed.
- **Field integrals** (new Advanced-menu panel + `mesh_field_integrate` MCP tool). The
  cell-measure-weighted total and mean of every cell field, for the whole mesh and per named region
  — which here means per entity block and per SubModelPart, so "the total mass of this part" needs
  no slicing. Regions overlap rather than partition, so their totals need not sum to the whole-mesh
  row; that is stated in the panel itself.
- The sidebar's mesh-file picker now carries which form asked for it, so the two new
  single-file forms cannot land their pick in the multi-select Merge mesh field.

## [3.5.0] - 2026-08-06

- **Combine operations into one apply** ([#13](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/13)).
  Every sidebar operation used to apply the moment its Apply button was clicked — one click, one
  history row, one toast, and a second operation fired while the first was still running was
  rejected outright rather than queued.
  - **New "Queue operations for one apply"** checkbox in the Edit section. While it's checked,
    every Apply button in the sidebar — Edit's transform forms and every Mesh Modification form —
    stages its operation into a list instead of running it immediately, with a short summary and a
    ✕ to drop a staged step. Build up a sequence from as many different forms as you like, then
    **Apply queued steps** runs them all in order under one progress bar.
  - **Each queued step still lands as its own independently undoable history entry** — queuing
    only saves the clicks, it does not change how steps are recorded. Undo peels them off one at a
    time, exactly as before.
  - **A queue that stops early keeps whatever already succeeded.** Cancelling, or a genuine
    failure partway through, does not roll back the steps that already ran — the toast reports how
    far it got.
  - Internally, `OperationHistory` gained `applyMany` — a small loop over the existing `applyNew`,
    so nothing about how a single operation is recorded had to change. The in-flight guard and
    apply/progress/rerender logic that used to be duplicated verbatim in both preview providers is
    now one shared module (`src/opApply.ts`), which the new batch handler needed anyway.
  - No MCP changes were needed — `mesh_transform`'s `ops`/`recipePath` array already applies
    several operations in one call; this brings the interactive UI up to the same capability.

## [3.4.0] - 2026-08-05

- **Combine meshes, with renumbering** ([#25](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/25)).
  Merging existed but was binary; renumbering did not exist at all.
  - **New `Renumber` operation** — compacts ids into a gapless run, the natural cleanup after a
    **Crop**, a **Merge mesh** or a **Remove orphan nodes**, each of which leaves holes behind.
    Elements, Conditions and Geometries are numbered **independently**, which is what Kratos
    means: an `Element 1` beside a `Condition 1` is correct, not a collision. Connectivity,
    SubModelPart membership and every field record follow their ids automatically. Coordinates,
    property ids and constraint ids are deliberately left alone, and the operation says how many
    of the last two it left rather than passing over them silently.
  - **`Reorder` and `Renumber` are different things, and the docs said otherwise.** `Reorder`
    permutes *storage order* and every node keeps its own id — which is exactly why SubModelParts
    and fields survive it untouched. Four places described it as renumbering the ids. Corrected;
    running Reorder then Renumber is the full RCM renumbering.
  - **Merge mesh now takes several files at once.** Pick any number in the Browse dialog and they
    merge in one operation: one pass of id offsetting, one weld across every seam instead of one
    per file, one entry in the history to undo. Each source is wrapped in its own SubModelPart
    named after its file, so you can still frame, export or delete one of them; give the operation
    a **name** and that becomes their shared parent instead.
  - Ids are now offset **per kind**, so elements continue the element run and conditions the
    condition run rather than both jumping past a shared maximum.
  - **Four defects fixed in merging**, all of which produced a quietly wrong model:
    - A merged-in child SubModelPart kept its old path, so it was addressed as `Inlet` while
      living under `MergedMesh` — unreachable from the outline, from Find, and from any operation
      targeting a part.
    - Constraint ids were never offset, so a merged file's constraint 7 collided with yours.
    - Nodal fixity flags were kept at their original length beside a doubled id list.
    - Both meshes' diagnostics were discarded.
  - **Fidelity losses are now reported instead of silent**: a merged file's `Properties` blocks
    cannot be carried over (only their line counts are parsed) so its cells' property ids resolve
    against your mesh's Properties, and a field that disagrees on component count between the two
    meshes is skipped rather than added as a second entry under the same name.
  - Both operations are reachable headless through the `mesh_transform` MCP tool. Recipes written
    before Merge mesh became multi-file still load unchanged.

## [3.3.0] - 2026-08-05

- **Reorganize SubModelParts** ([#12](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/12)).
  Only rename and delete existed; the tree itself could not be edited. Five new operations, each
  undoable, replayable in a recipe and reachable from `mesh_transform`:
  `createSubModelPart`, `moveSubModelPart`, `mergeSubModelParts`, `addSubModelPartEntities` and
  `removeSubModelPartEntities`.
  - **The parent/child subset rule is now maintained rather than ignored.** Kratos requires a
    child's entities to be a subset of its parent's, and nothing in this codebase enforced, checked
    or even mentioned it. These operations keep it true the way Kratos itself does, measured
    against `kratos/sources/model_part.cpp`: adding an entity to a part also adds it to every
    **ancestor** (`ModelPart::AddNode` calls the parent's first, line 297) and removing one also
    removes it from every **descendant** (`RemoveNode` loops over the sub model parts, lines
    439-440). Move and merge propagate upward for the same reason. The invariant therefore holds by
    construction, and each operation reports how many ids it propagated so the knock-on effect is
    visible instead of silent.
  - **UI**: every SubModelPart row gains an organize button — *New child* (an inline name field,
    no native prompt), *Move under*, *Merge into* and *Edit membership* (a kind selector plus an
    id-list field accepting ranges, e.g. `1,2,5-10`). Destinations that cannot work (the part
    itself, or anything in its own subtree) are not offered rather than offered and refused.
  - Removing an entity from a part changes **membership only** — the node or element itself stays
    in the mesh.

## [3.2.0] - 2026-08-05

- **Reload from disk — and applied operations now survive a re-parse.** Filed as a missing button
  ([#10](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/10)); the button was the small
  half. `OperationHistory.setBase` cleared the op stack, the cursor and the MMG snapshot map, and it
  ran on *every* parse — so an external file change, or merely pressing the timeline arrow once,
  silently discarded every edit with no prompt and nothing to undo back to.
  - **`rebase` beside `setBase`.** `setBase` still resets, but only for a genuinely new document;
    every re-parse path now rebases (keeping ops and cursor, dropping the snapshots, which were
    computed against the old base) and replays the stack onto the new contents.
  - **File ▸ Reload from disk**, the **Kratos Mesh: Reload from Disk** command and `Ctrl+Alt+R`.
  - **An operation that no longer applies is kept and marked**, not dropped, and the ops after it
    still run. There is deliberately no "failed" state: a real failure and a legitimate
    nothing-to-do both come back as a noop, so the row shows `no effect` with the operation's own
    message as its tooltip rather than claiming a distinction the layer below cannot make.
  - **Stepping a VTK time series skips the expensive operations.** Geometric edits follow you from
    frame to frame; MMG remesh, level-set split, smooth, reorder, partition, merge and field
    gradient are marked `skipped` instead of re-running on every arrow-key press. A new **Re-apply
    skipped operations** button runs them on the current frame.
- **The operation history is now testable, and tested.** The class used no `vscode` yet sat outside
  the test build, so the entire stateful layer — where this defect lived — had zero coverage. It
  moved to a pure `src/parser/opHistoryCore.ts` with the vscode glue (recipe dialogs, the replay
  progress notification) left in `src/opHistory.ts`, mirroring the `whatsNewCore.ts` split.
- **Watcher fixes** around the same code:
  - The VTK directory watcher is genuinely debounced (its handler was named `scheduleRediscover`
    and scheduled nothing), and a discovery that arrives mid-parse is now **queued instead of
    dropped** — a solver writing a burst of step files could previously have its final state simply
    missed.
  - The MDPA watcher handles `onDidDelete` (an atomic save is delete-then-create), and re-parses on
    **saving the `.mdpa` in a text editor** rather than waiting for a later disk flush.

## [3.1.0] - 2026-08-05

- **meshio++ upgraded from 9.9.0 to 9.22.0** — fourteen minor versions. Three capabilities reach
  the extension, and every version-pinned format claim in the codebase was re-measured against the
  new build rather than assumed:
  - **OpenFOAM export.** `.foam` joins File ▸ Export ▸ Solvers. It is the one format that writes a
    *directory*: the chosen `.foam` path becomes a 0-byte marker and the mesh lands in
    `constant/polyMesh/` beside it (`points`, `faces`, `owner`, `neighbour`, `boundary`). A
    companion file's name is therefore a relative path rather than a basename, and both callers
    create the intermediate folders. Export-only, with the single synthesized `defaultFaces` patch
    `blockMesh` itself produces.
  - **Polyhedral meshes open.** A CGNS `NGON_n`/`NFACE_n`, MED `POE` or VTU `VTK_POLYHEDRON` file
    used to open EMPTY — ragged cell blocks were diagnosed and skipped. They are now split into
    tetrahedra for display, fanning each face about its corner average so the decomposition fills
    the original cell exactly even when its faces are non-planar, deduplicating shared faces so
    neighbouring cells do not tear apart, and orienting every tetrahedron positively. Nodal fields
    are interpolated at the invented apex nodes and cell data is replicated to the children. The
    same path fixes VTK_POLYHEDRON in our own `.vtu` reader, which previously staged such a cell as
    a meaningless n-node blob because its shape lives in the `faces`/`faceoffsets` arrays.
    Polygonal (1-level ragged) blocks now simply draw, via the existing polygon normalization.
  - **Field gradient.** A new mesh operation — the gradient, divergence or curl of a nodal field —
    in the Mesh Modification sidebar's Fields group and as a `mesh_transform` op. Green-Gauss
    (exact for a linear field on any cell) or least-squares. Cells that cannot be differentiated
    come back `NaN` rather than approximated, and both that count and any least-squares fallbacks
    are reported instead of leaving a part-`NaN` field looking clean. An elemental field is
    piecewise constant, so it is refused by name and pointed at Average field.
  - **cgnslib is now compiled into the WASM build**, making ADF-backed containers and the CGNS 3.x
    section layout readable for the first time. Pinned by a test, since a build that silently
    dropped it would still read everything meshio++ writes itself.
  - Re-measured and unchanged: MED and Abaqus still carry SubModelParts out as families/sets,
    Exodus still round-trips block names but no node or side sets, and **gmsh still writes no
    `$PhysicalNames`**, so `.msh` export still carries no groups. The DOLFIN, TetGen and EnSight
    write exclusions all still hold for their original reasons.
  - The bundled `.wasm` grows by roughly 1.2 MB across both variants.

## [3.0.0] - 2026-07-31

- **Unified UI with the sibling CAD-Preview extension.** The interface adopts the shared design
  language documented in the new `doc/ui-design-system.md`, materialised
  as `webview/design-system.css` — a token/base layer written so CAD-Preview and KKSS can adopt the
  identical file verbatim. No functionality changed; this is a visual/interaction convergence:
  - **Toolbar and File buttons are solid primary pills** (the reference's signature look); an
    enabled mode (Pan, Wireframe, Cut Plane, Grid, Find, Inspect, …) now shows as an info-tinted
    fill with a focus outline instead of a filled blue button, so "mode on" and "option selected"
    read differently, as in CAD-Preview. The scene-theme picker restyles as an input control.
  - **Sidebar becomes a distinct column** (`sideBar-*` theme tokens) with CAD-Preview's
    section-header typography and text chevrons (`▾`/`▸`).
  - **Dropdown menus share one recipe** (File, Advanced, per-part export/info/opacity popovers):
    radius-5 panels, menu tokens, selection-coloured hover, 6×12 item padding, and a reserved
    tick column for checkable items (Parallel Projection).
  - **Navigation card matches the reference view-controls bar**: 24 px filled D-pad/zoom/view
    cells, the rotate step as a filled segment row, `⌄`/`⌃` collapse chevrons, uppercase group
    captions.
  - **Orientation cube** adopts the reference uniform blue faces, white bold labels and matching
    RGB axis arrows.
  - **One floating-panel chrome** (Quality/Mesh Size/Spheres/Field/Inspect/Lighting/Bookmarks):
    widget surface + border with no drop shadows (shadows are now exclusive to menus), a single
    header/close recipe, and every slider restyled to the shared 3 px-track/round-thumb recipe.
  - The message line becomes a status pill; typography/radii/spacing normalise to the reference
    scale throughout.



- **Upgraded to meshio++ 9.9.0** (from 9.8.0). The release closes the shapeless-data-boundary bug that was behind most of the extension's remaining format workarounds — a vector field crossed into the WebAssembly module as a flat array with no notion of its width, so an `(n, 3)` field arrived as `(3n, 1)` — and every consequence of that is fixed here:
  - **MED (Salome) is now an export format**, not read-only. The blocker was exactly the above: any mesh carrying a vector field (which a real Kratos mesh nearly always does) wrote without complaint and then could not be read back. Re-measured against the Kratos fixture that used to fail — the vector field round-trips, and **SubModelParts now survive an MED export as MED families**
  - **CGNS export no longer silently drops every field.** Point and cell data now round-trip through CGNS `FlowSolution` nodes, vectors included (CGNS has no component concept, so a vector is split into sibling scalars and rejoined on read). Note CGNS still writes no cell data for a mesh that mixes dimensions (tets plus boundary triangles, say), since there is nowhere to put it
  - **Exodus export keeps much more**: any elemental/conditional data that is not a per-element attribute is now written as an Exodus element variable (vectors included) instead of being dropped, and **element block names round-trip** — a re-opened export shows `Element3D4N` rather than the anonymous `Block 0` it used to. Genuine SubModelParts still do not survive an Exodus export (the writer emits no node sets or side sets); use `.mdpa`, `.vtu` or now `.med` when the grouping matters
  - **A real Salome/Code_Aster MED file opens.** Files using MED features the strict reader declines (field units, non-default time-step keys, named profiles) previously failed outright, because the fallback reader that covers them exists only in meshio++'s Python bindings. Such a file is now retried with a lenient read, which gets through it and skips only the individual constructs that cannot be represented
- **SubModelParts now survive an export to the formats that model named groups.** The extension previously never wrote its grouping out at all: `.med` gets MED families, `.inp` gets real `*NSET`/`*ELSET` set definitions, and every mesh block keeps its own name in `.exo`. Each mesh block is also kept as a separate block on export rather than being merged with same-shaped blocks, so an `Elements` and a `Conditions` block of the same cell type no longer fuse into one. (Measured while doing this and worth knowing: a `.msh` (Gmsh 4.1) export still carries no groups — meshio++ writes no `$PhysicalNames` for a mesh that did not come from Gmsh.)
- **Fixed: a spurious diagnostic on every Exodus file.** meshio++ 9.9.0 attaches the time of the step it read to every Exodus mesh, which the extension reported as dropped data the user never wrote.

## [2.9.1] - 2026-07-30

- **Upgraded to meshio++ 9.8.0** (from 9.7.0). No new formats — this is a correctness release for two the extension already exposed:
  - **CGNS export actually produces a readable file now.** Earlier builds wrote only the *first* tetrahedral block they found and left empty element sections for everything else, so exporting any other mesh — every surface mesh, every hexahedral mesh, every multi-block Kratos model — silently produced a `.cgns` file that no tool could read back, including this extension's own reader. meshio++ 9.8.0 rewrites CGNS as a genuine CGNS/SIDS-compliant subset: every cell type up to `hexahedron27` is written, each mesh block keeps its own element section in order, and the result is readable by cgnslib/ParaView/VTK. Files written by older versions (and by upstream `meshio`) still open, via a legacy-layout fallback. Note that CGNS carries geometry and topology only — no field data of any kind — so export to `.vtu`/`.mdpa` if you need the fields
  - **MED (Salome) remains read-only, but for a narrower reason.** 9.8.0 removed the blocker that made MED export impossible for essentially every Kratos mesh — a model with two cell blocks of the *same* type (routine here) used to be rejected outright, before field data even entered the picture — and multiple scalar fields now write and read back correctly. What still fails is any **vector** field: it writes without error but cannot be read back. Since a real Kratos mesh almost always carries one, MED stays excluded from the export list rather than shipping as a writer that fails on the common case
- **Fixed inaccurate format documentation** found while verifying the above: the notes claimed CGNS round-trips scalar and vector fields (it carries no field data at all) and misdescribed why MED export was disabled. Both now state what was actually measured against the shipped WebAssembly build

## [2.9.0] - 2026-07-29

- **Field visualization power-ups**: the Field panel's Contour/Isosurface now support an editable and lockable **color range** (with a reset-to-data button), an optional **log scale**, and **discrete color bands** (5/10/20) — all three transform the same colormap stops shown in the legend, the 3D coloring, and the new in-scene scalar bar together. Vector fields gain a **component selector** (Magnitude/X/Y/Z) for Contour/Isosurface/Threshold (Quiver stays magnitude). The colormap list grows from 4 to 12 (added Plasma, Inferno, Magma, Cividis, Turbo, Blue-Orange, Spectral, HSV). **Isosurface** now takes a count spinner and shows multiple independently-draggable iso values at once instead of a single slider. A new **"Show scalar bar in scene"** toggle renders a real `vtkScalarBarActor` legend that (unlike the panel's own legend) is captured by the Screenshot button; when it's off, a screenshot instead composites a legend onto the captured image automatically.
- **New Field mode: Threshold** — shows only the Elements/Conditions whose value falls inside an editable `[min, max]` window, with an all-nodes-in-range vs. any-node-in-range rule for nodal fields. Combines with Contour to color the surviving cells, or stands alone to isolate a region.
- **New: Inspect** (`Inspect` toolbar button) — click any node, element, or condition on the mesh to see its id, block, SubModelPart membership, and every field value defined at it, with no id needed up front (unlike Find). A **Measure** sub-mode inside the panel draws a line between two clicked nodes and reports the distance and Δx/Δy/Δz.
- **Cut Plane gains an oblique "Free" mode**: type an arbitrary normal vector (X/Y/Z) instead of only picking an axis preset, for a cut plane at any angle. The slider, flip, and field-colored cap all generalize to it.
- **Per-layer opacity**: hovering any outline row (a mesh block or a SubModelPart) reveals a small button that opens a live 0–100% opacity slider for that layer.
- **New Advanced-menu rendering-quality controls**: **Parallel Projection** toggles the camera between perspective and orthographic; **Lighting…** exposes global specular/ambient/diffuse sliders and a backface-culling toggle (useful for spotting an inverted shell element from the inside); **Camera Bookmarks…** saves and restores named views for the session, with a JSON textarea to copy a view out or paste one in for sharing across sessions. Standard axis-aligned views are now one keypress away — `1`–`6` for ±X/±Y/±Z, `i` for an isometric corner view — reusing the same snap logic as clicking a face of the orientation cube.
- The main toolbar and the Cut Plane panel markup are now single shared constants (`src/webviewChrome.ts`) consumed by both the `.mdpa` and mesh previews and the screenshot-documentation harness, instead of three copies that could silently drift.
- **Upgraded to meshio++ 9.7.0** (from 9.3.0). **Gmsh MSH 4.1 files are now actually readable**: every real Gmsh-written 4.1 file starts with a `$Entities` section that earlier builds rejected on sight, so in practice no real 4.1 file could be opened at all — `$Entities` is also where 4.1 records physical-group membership, so upgrading also means 4.1 files now get their named groups as SubModelParts. **MED (Salome) gains named regions** (`*FAS`/`*GRO` families), which flow through the same SubModelPart pipeline as every other format's named groups.

## [2.8.0] - 2026-07-28

- **10 new mesh operations** in the **Mesh Modification** sidebar, `mesh_transform` and the `mergeMesh` file picker's `mesh_extract_skin`/`kratos.mesh.exportSkin` sibling — a survey of what the bundled meshio++ WASM offers, kept native wherever the extension already does the job (`transform`, `clean`, `convertCells "elevate"`, `attachQuality`, `stats`, `isosurface`, `split by regions` and `dataInfo` were all ruled out that way):
  - **Smooth** (Taubin/Laplacian, with boundary/feature pinning and an inversion guard), **Reorder** (RCM bandwidth reduction, or Morton/Hilbert space-filling curves), and **Partition** (space-filling-curve domain decomposition into an Elemental `PARTITION_INDEX`, optionally with per-part SubModelParts) all use meshio++ strictly as an **oracle**: it computes a result whose shape survives losslessly (moved coordinates, a node permutation, a label array), which is then applied onto the extension's own mesh — its SubModelParts, ids, entity kinds and material assignments are never round-tripped through meshio++'s own (and, verified while researching this, quite lossy) mesh representation
  - **Refine** (uniform tri/quad/tet/hex/wedge/line subdivision, up to 4 levels, with exact field interpolation and no hanging nodes), **Quadratic → Linear** (the missing inverse of Convert Linear → Quadratic), **Simplexify** (hex/wedge/pyramid/quad → tets/triangles), **Crop** (bounding box or plane, keep-all/keep-any), **Field calculator** + **nodal ↔ elemental averaging** (a safe formula evaluator over coordinates and existing fields — never `eval`), and **Merge mesh** (append another mesh file's nodes/cells with id offsetting and an optional coincident-node weld) are implemented natively, reusing primitives the extension already had (edge/face tables, block/field slicing, the MMG-sizing expression evaluator) rather than repairing a lossy round-trip
  - Smooth/Reorder/Partition/Merge mesh run asynchronously with the same inline progress bar and play/stop cancel button as MMG remeshing; the rest apply instantly. Every operation joins the same undoable history, JSON recipe, and `mesh_transform` MCP tool as the original op set
  - **Advanced ▸ Export skin…** (+ the `mesh_extract_skin` MCP tool) extracts the boundary of a mesh's volume cells as a standalone surface mesh — a native boundary-face walk, so SubModelParts survive it (narrowed to node membership), unlike meshio++'s own surface/skin extractors which drop every region
- **Documentation**: every new operation now has its own worked screenshot in the [Mesh Editing guide](https://loumalouomega.github.io/VSCode-MDPA-Preview/guide/mesh-editing) — for the geometric ones a before/after pair in a single view, for the field-producing ones the result coloured by the variable they create, each next to the form showing the exact parameters that produced it
- **Mesh Modification, reorganized into subcategories**: with the additions above the section had grown to fourteen flat items. It is now six collapsible groups — **Element order & topology**, **Remeshing (MMG)**, **Smoothing & renumbering**, **Selection & combination**, **Fields**, **Sphere elements** — each collapsed by default, so the section reads as a short list of categories rather than a long scroll of forms
- **Toolbar cleanup**: **Mesh Size** moved from its own toolbar button into the **Advanced** menu (alongside Spheres…, Face normals and Export skin…), and the **Advanced** button itself moved to sit right after **Find**, next to **Screenshot** — the toolbar no longer grows a dedicated button for every analysis panel
- **Fixed: a popup-only Advanced-menu action's "active" highlight never worked** — `Mesh Size`'s (and, latently, `Spheres`') active-state toggle queried `#toolbar button[data-action="…"]`, but a menu item lives in the `#advanced-popup` sibling, not inside `#toolbar`, so the query always matched nothing. Both now query `[data-action="…"]` unscoped
- **Fixed: `mergeMesh`'s file picker couldn't actually merge a `.mdpa` file** — its own dialog lists `.mdpa` first, but the op read the second file through the mesh-format dispatcher that deliberately excludes `.mdpa` (parsed natively everywhere else in the extension), so picking the single most likely file silently no-opped with "Unsupported mesh file extension"

## [2.7.0] - 2026-07-27

- **SPHERE / particle element support** ([#63](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/63)): an Exodus file written by a peridynamics or DEM code failed to open outright with `Exodus: unknown element type SPHERE` — on a type meshio++ had mapped correctly all along. The cause was the *encoding*: [NetCDF.jl](https://github.com/JuliaGeo/NetCDF.jl), which PeriLab and other Julia solvers write Exodus with, counts the C string's terminating NUL in the `elem_type` attribute's length, so the value arrived as the 7 characters `"SPHERE\0"` and matched no key — and the NUL was invisible in the error message too. Fixed in meshio++ 9.3.0
  - **Particles now render as spheres.** A one-node element has no extent, so it used to draw as a fixed-size screen point that told you nothing about the discretization. The new **Spheres** toolbar button draws real sphere glyphs scaled in model space: they grow as you zoom, and neighbouring particles visibly touch or do not. A mesh carrying a `RADIUS` field switches to them automatically
  - **A radius where the file has none.** Most particle files declare no radius at all — the file from the issue has 504 `SPHERE` elements and not one Exodus attribute. The panel suggests one (half the median nearest-neighbour spacing, so a regular lattice renders as spheres that just touch) and draws every particle at it. Ordinary point clouds are left alone
  - **The radius is editable and it persists.** **Set element radius** is a normal undoable mesh operation — set an absolute value (creating the field), or *scale* existing radii without flattening their variation, optionally limited to one SubModelPart. It saves, exports, rides along in a saved recipe and a problem archive, and is reachable from the `mesh_transform` MCP tool; `mesh_info` now reports a `spheres` section so an agent can tell a radius-less particle file from a radius-carrying one
- **New: an "Advanced" toolbar menu**, for operations that are useful but not everyday, so the toolbar does not grow a button per niche feature. It opens with the sphere rendering above and:
  - **Face normals** — draws an arrow on every surface face and every boundary face of a volume mesh. This is how you find an **inverted element**: a cell's winding decides both its normal direction and the sign of its Jacobian, so a flipped cell points against its neighbours — unmistakable on screen, invisible in the statistics, and a hard error for the solver. Elements wound against a neighbour are counted and highlighted in red, with the caveat that this is a *relative* test: a uniformly inside-out mesh is self-consistent, so the arrows remain the check for global orientation
- **Exodus is now writable** (`.e`/`.exo`/`.ex2`), where it was read-only. A `RADIUS` round-trips as a genuine Exodus per-element attribute. The export is otherwise **lossy and deliberately so**: element blocks and nodal fields survive, but SubModelParts do not (the writer discards regions and synthesizes `Block N` names), a time series is flattened to a single step, and the output is NetCDF-4/HDF5 rather than classic netCDF-3. Export to `.mdpa` or `.vtu` when the grouping matters
- **Fixed: NaN from an Exodus attribute could become a real value.** meshio++ fills NaN for the blocks that do not declare an attribute, and the writers map NaN to `0` — so an unfiltered radius would have claimed every non-sphere element had radius 0. Such values are now dropped at the read boundary, and re-injected as NaN on the way back out, which is what lets a file where only some blocks carry an attribute round-trip unchanged
- **Fixed: Field ▸ Quiver drew nothing.** Building the arrow glyphs turned out to need a vtk.js rendering back end that the geometry profile does not register, so the arrows were created, added to the scene and silently never drawn — since the feature was introduced. Found while adding the sphere rendering, which is built the same way
- Upgraded to meshio++ 9.3.0 (from 8.7.0). The bundled WebAssembly grows by ~6.2 MB: since 8.8.0 the package ships a threaded build alongside the sequential one and selects it itself under Node, so both must be present — shipping only the old pair made **every** extended format fail to load with an opaque `LinkError`

## [2.6.0] - 2026-07-24

- **EXODUS II support** ([#56](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/56)): `.e`/`.exo`/`.ex2` open in the mesh preview, read-only. Requires meshio++ >= 8.6.0 — earlier builds (including 8.0.0–8.5.0, which only added the WASM HDF5/netCDF plumbing) threw on `qa_records`, a variable every file written by SEACAS, Cubit or Sierra carries, making the format unusable on anything but a synthetic test file
  - **Time steps.** A multi-step Exodus file drives the same timeline bar as a Kratos `.vtk` series, off the steps recorded *inside* the one file rather than sibling filenames — no `<prefix>_<rank>_<step>` naming needed. A solver still appending steps to the same file extends the timeline live
  - **Element blocks, node sets and side sets become SubModelParts**, through the same named-groups pipeline gmsh physical groups and Abaqus sets already use (added last release): two element blocks of the same cell type stay distinguishable rather than collapsing together, and a side set materializes as a real boundary-facet **Conditions** layer
  - `mesh_info`/`mesh_convert` gained a `timeStep` parameter; `mesh_info` reports the available `timeValues`
- **New read-only format: `.med`** (Salome). meshio++ 8.7.0 added MED field-write support for a mesh carrying exactly one data field, but writing two or more fields together — verified for every scalar+vector and point+cell combination — still fails ("field data size does not match its declared shape"), which is the common case for any real Kratos mesh, so `.med` stays read-only here
- **Fixed a silent data-loss regression**: meshio++ 8.7.0 lets ragged (polygon/polyhedron) cell blocks cross the WebAssembly boundary for the first time — previously they were rejected outright with an error. This extension's converter assumed every block was uniform (fixed node count per cell), so a ragged block silently contributed zero cells with **no diagnostic at all**, and every block's cell-index accounting after it silently shifted, corrupting named-group membership. Both are fixed: a ragged block is now skipped with a diagnostic naming its real cell count, and index accounting stays correct across it
- Upgraded to meshio++ 8.7.0 (from 8.5.0)

## [2.5.0] - 2026-07-23

- **Named groups now become SubModelParts.** Gmsh physical groups, Abaqus `*NSET`/`*ELSET`/`*SURFACE`, and every other named group meshio++ recognizes arrive in the outline tree as SubModelParts, with the usual frame / export / rename / delete actions. A **surface** group (a set of cell *facets* rather than whole cells) is materialized into real boundary-facet **Conditions**, so it is a visible layer — and exporting to `.mdpa` yields genuine Kratos Conditions. The same grouping is visible to the `mesh_info` MCP tool and sliceable with `mesh_extract_submodelpart`, which previously only worked on `.mdpa`
- **New formats**: `.cgns`, `.h5m` (MOAB), `.hmf` and `.med` (Salome) can be opened, and all but `.med` exported. `.med` is read-only because its WebAssembly writer rejects any mesh carrying data arrays
- **Fixed: an XDMF using HDF storage could not be opened at all** — the reader opens the companion `.h5` by the name written inside the XML, which was never placed alongside it. This is what ParaView writes by default
- **Fixed: exporting to `.xdmf` wrote a dangling file.** meshio++ 8.0.0 moved the heavy arrays out of the XML into a companion `<stem>.h5`; both files are now written next to each other, named after the destination
- Upgraded to meshio++ 8.5.0 (from 6.6.1). Note the bundled WebAssembly binary grows from 2.3 MB to 5.6 MB — it now statically links HDF5 and netCDF, which is what makes the formats above reachable

## [2.4.0] - 2026-07-18

- **Expression-driven remesh sizing**: a new **`size = ƒ(h)`** mode for **Remesh (MMG)** sets each node's target size from a formula of the current nodal size `h` (Kratos `NODAL_H`), the whole-mesh size statistics (`mean`, `std`, `min`, `max`, `median`, `q1`, `q3`, `iqr`) and the node coordinates `x, y, z` — for example `0.5*h`, `clamp(0.5*h, mean-1.5*std, mean+1.5*std)`, or a coordinate-graded `clamp(0.6 - 0.45*x, 0.1, 0.6)`. A collapsible **Per-part sizing** block assigns different formulas to individual SubModelParts (the statistics stay whole-mesh). The same `mode:"expr"` (`sizeExpr` + optional `sizeParts`) is reachable from the `mesh_transform` MCP tool and saved operation recipes
- Mesh-size statistics now include the population **standard deviation** (surfaced in the `mesh_size` MCP tool)

## [2.3.0] - 2026-07-18

- Added a **"What's New!"** screen that opens on startup after the extension updates, summarizing the changelog entries newer than the version you last saw (dismiss it and carry on). First installs stay silent; reopen anytime with the **Kratos MDPA: Show What's New** command, or disable the auto-popup with the `kratos.showWhatsNew` setting

## [2.2.0] - 2026-07-18

- Upgraded to meshio++ 6.6.1 (from 6.1.0), adding read support for **EnSight Gold** (`.case`/`.geo`) and **Triangle** (`.poly`) meshes
- Export now offers Triangle `.poly` and the write-only **SVG/TikZ** figure formats (a 2D/3D-projected drawing of the mesh) in a new "Figures" menu group
- These new formats are also reachable from the `mesh_convert`/`mesh_info` MCP tools via the extension defaults and `inputFormat`/`outputFormat` overrides

## [2.1.0] - 2026-07-17

- Deformed-shape field mode, combinable with the other Field modes (Contour · Quiver · Isosurface) instead of switching exclusively ([#51](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/51))
- Mesh Size panel (nodal/element size color overlay, box-and-whisker distribution, highlight smallest/largest elements, write sizes into the mesh) ([#51](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/51))
- Upgraded to meshio++ 6.1.0 ([#51](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/51))
- Dependabot auto-merge workflow for CI and dependency update PRs ([#51](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/51))
- Dependency updates: `esbuild`, `ejs`, `@kitware/vtk.js`, `express`/`@types/express`, `@vscode/vsce`, and GitHub Actions (`setup-node`, `checkout`, `deploy-pages`, `upload-pages-artifact`, `action-gh-release`) ([#39](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/39)–[#50](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/50))

## [2.0.0] - 2026-07-16

- Extended mesh-format support via [`@meshioplusplus/wasm`](https://www.npmjs.com/package/@meshioplusplus/wasm): dozens of additional read/write formats (gmsh, Abaqus, Ansys, FreeFEM, tetgen, and more) alongside the native VTK/MDPA/STL/OBJ/PLY support ([#38](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/38))

## [1.9.4] - 2026-07-14

- **Problemtypes**: build and run Kratos simulation cases directly from the preview — declarative problemtype catalog (built-in Structural, Fluid, Convection-Diffusion, Potential Flow, Shallow Water) with sidebar forms for conditions, materials, and VTK output, generating `ProjectParameters.json`, materials files, and `MainKratos.py`, plus Generate/Run/Open-results actions ([#34](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/34))
- **Flowgraph**: embedded node-graph problemtype editor for visually composing Kratos processes, with a live ProjectParameters bridge to/from the generated case ([#35](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/35))

## [1.6.0] - 2026-07-10

- Maintenance release (no functional changes since v1.5.9).

## [1.5.9] - 2026-07-08

- Maintenance/patch release following the MMG remeshing feature.

## [1.5.8] - 2026-07-08

- Added MMG-based mesh remeshing (uniform factor / target size / optimize modes with advanced tuning) and level-set splitting to the Mesh Modification sidebar, running off the main thread in a worker with live progress and cancellation ([#32](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/32))

## [1.4.5] - 2026-07-08

- Added a mesh-editing suite: linear → quadratic conversion, an undo/redo/partial-revert operation history with JSON recipe save/load, coordinate transforms (scale, translate, rotate), and SubModelPart rename/inspect from the outline tree ([#31](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/31))

## [1.3.4] - 2026-07-08

- Patch release following the File menu addition.

## [1.3.3] - 2026-07-08

- Implemented the webview File menu (Open, Save, Save As, Export) with palette-command parity ([#29](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/29))

## [1.3.1] - 2026-07-08

- Patch release following the multi-format preview extension.

## [1.2.4] - 2026-07-08

- Extended the preview to the full VTK family and surface-mesh formats: VTK XML (`.vtu`/`.vtp`/`.vti`/`.vts`/`.vtr`), multiblock (`.vtm`), binary legacy VTK, and STL/OBJ/PLY ([#28](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/28))

## [1.2.2] - 2026-07-07

- Version bump to 1.2.1 and added the local reinstall script/task (`npm run reinstall`) ([#19](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/19))

## [1.1.1] - 2026-07-03

- Added a VitePress documentation site, published to GitHub Pages ([#17](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/17))

## [1.1.0] - 2026-07-03

- Added plane-cut visualization for volume meshes with true element cross-sections ([#16](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/16))

## [1.0.2] - 2026-07-03

- Added a publish step to the Visual Studio Marketplace in CI.

## [1.0.1] - 2026-07-01

- Updated toolbar button labels with icons.

## [1.0.0] - 2026-06-26

- Added on-screen view navigation controls (orbit/pan/zoom/fit/center) and improved the orientation cube ([#9](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/9))

## [0.9.1] - 2026-06-26

- Added VTK preview support: timeline animation for time-series output, SubModelPart tree, and field visualization for Kratos VTK output ([#8](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/8))

## [0.8.1] - 2026-06-26

- Added coordinate axes and a reference grid to the scene ([#7](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/7))

## [0.7.0] - 2026-06-25

- Added field visualization: Contour, Quiver, and Isosurface modes ([#6](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/6))

## [0.6.0] - 2026-06-25

- Added a scene theme selector (presets, toolbar UI, and persistence) with related fixes to theme validation, VTK background flash, and select hover state.

## [0.5.1] - 2026-06-24

- Icon and minor fixes following the entity-search feature.

## [0.5.0] - 2026-06-24

- Added "find entity by ID" with wireframe context highlighting ([#5](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/5))

## [0.4.1] - 2026-06-24

- Added a mesh-quality panel with plots and bad-element highlighting ([#4](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/4))

## [0.3.0] - 2026-06-24

- Added large-file support ([#3](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/3))
- Ignored the `.worktrees/` directory in Git ([#2](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/2))

## [0.2.0] - 2026-06-23

- Added mesh panning, an example mesh, `CLAUDE.md`, and VS Code tasks; cleaned up the README.

## [0.1.0] - 2026-06-23

- Initial release: custom editor preview for `.mdpa` files.

[3.14.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.14.0...v3.14.1
[3.14.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.13.0...v3.14.0
[3.13.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.12.0...v3.13.0
[3.12.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.11.1...v3.12.0
[3.11.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.11.0...v3.11.1
[3.11.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.10.0...v3.11.0
[3.10.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.9.0...v3.10.0
[3.9.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.8.0...v3.9.0
[3.8.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.7.0...v3.8.0
[3.7.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.6.1...v3.7.0
[3.6.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.6.0...v3.6.1
[3.6.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.5.0...v3.6.0
[3.5.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v3.0.1...v3.1.0
[3.0.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.10.0...v3.0.0
[2.10.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.9.1...v2.10.0
[2.9.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.9.0...v2.9.1
[2.9.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.8.3...v2.9.0
[2.8.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.7.1...v2.8.0
[2.7.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.6.0...v2.7.0
[2.6.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.5.1...v2.6.0
[2.5.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.9.4...v2.0.0
[1.9.4]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.6.0...v1.9.4
[1.6.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.5.9...v1.6.0
[1.5.9]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.5.8...v1.5.9
[1.5.8]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.4.5...v1.5.8
[1.4.5]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.3.4...v1.4.5
[1.3.4]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.3.1...v1.3.3
[1.3.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.2.4...v1.3.1
[1.2.4]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.2.2...v1.2.4
[1.2.2]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.1.1...v1.2.2
[1.1.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.9.1...v1.0.0
[0.9.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.8.1...v0.9.1
[0.8.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.7.0...v0.8.1
[0.7.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.3.0...v0.4.1
[0.3.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/releases/tag/v0.1.0
